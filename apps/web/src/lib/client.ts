import { RcRestClient, RcRealtimeClient, type RcPreferences } from '@rcx/rc-client';

const STORAGE_KEY = 'rcx-auth';

export interface StoredAuth {
  authToken: string;
  userId: string;
}

export function loadStoredAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth | null): void {
  if (auth) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    // 同步种上 RC 的 cookie，让 <img src="/avatar/..."> 这类非 fetch 请求也能通过认证
    document.cookie = `rc_uid=${encodeURIComponent(auth.userId)}; path=/; SameSite=Lax`;
    document.cookie = `rc_token=${encodeURIComponent(auth.authToken)}; path=/; SameSite=Lax`;
  } else {
    localStorage.removeItem(STORAGE_KEY);
    document.cookie = 'rc_uid=; path=/; Max-Age=0';
    document.cookie = 'rc_token=; path=/; Max-Age=0';
  }
}

// 服务器地址：空 = 同源（Web 部署经反向代理 / 开发经 Vite 代理）；
// 桌面端（Tauri）没有代理，登录页配置后存这里，直连 Rocket.Chat。
const SERVER_KEY = 'rcx-server';

import { httpFetch, isTauri } from './http';
export { httpFetch, isTauri, isTauriRuntime } from './http';

export function getServerBase(): string {
  try {
    return (localStorage.getItem(SERVER_KEY) ?? '').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function setServerBase(url: string): void {
  const normalized = url.trim().replace(/\/+$/, '');
  const changed = normalized !== getServerBase();
  localStorage.setItem(SERVER_KEY, normalized);
  rest.baseUrl = normalized;
  realtime.setUrl(wsUrlFor(normalized));
  if (changed) {
    // 换服务器后清理与旧服务器绑定的缓存
    localStorage.removeItem('rcx-site-url');
    siteUrlCache = null;
    clearCachedSettings();
    legacySnapshot = null;
    inflightSettings.clear();
  }
}

/** 头像 / 上传文件等静态资源的绝对地址 */
export function assetUrl(path: string): string {
  return `${getServerBase()}${path}`;
}

/**
 * 站内文件路径归一化。服务器在部分字段里给的是按 Site_Url 拼出来的绝对地址
 * （如 files.list 的 url 字段），而客户端实际连接的地址可能不一样（桌面端填 IP、
 * Web 端走反向代理，参见引用回复对 Site_Url 的处理 #9）——直接拿去请求就会打到
 * 一个到不了的主机上：图片显示不出来、下载报「网络连接失败」（issue #19-8）。
 * 凡是站内文件端点，取出路径部分重拼到当前连接地址；外部存储（S3 等）原样保留。
 */
const RC_FILE_PATH_RE = /^\/(file-upload|ufs|avatar|emoji-custom|file-decrypt)\//;
export function normalizeAssetPath(path: string): string {
  if (!path || path.startsWith('/')) return path;
  try {
    const u = new URL(path);
    if (RC_FILE_PATH_RE.test(u.pathname)) return u.pathname + u.search;
  } catch {
    /* 不是合法 URL：原样返回，交给下游按相对路径处理 */
  }
  return path;
}

// Site_Url：引用回复的消息链接必须以它为前缀，服务端才会展开成引用附件
const SITE_URL_KEY = 'rcx-site-url';
let siteUrlCache: string | null = null;
try {
  siteUrlCache = localStorage.getItem(SITE_URL_KEY);
} catch {
  /* SSR/隐私模式 */
}

/**
 * 从 `settings.public` 响应里按 `_id` 取出我们**要的那个**设置。
 *
 * 不能再用 `settings[0]`：至少到 Rocket.Chat 6.x，`settings.public?_id=X` 会**忽略
 * `_id` 过滤**，返回一页（默认 50 条）按字母序排的设置，首条是
 * `API_Apply_permission_view-outside-room_on_users-list`。于是所有 `settings[0].value`
 * 的调用都读到了别人的值：`uniqueID` 拿到 `false` → LAN 指纹退回接入 URL 归一化
 * （issue #369 的症状）；`Site_Url` 也拿到别人的值 → 引用链接前缀全错。
 */
function findPublicSetting(
  data: unknown,
  id: string,
): { found: true; value: unknown } | { found: false; listed: number } {
  const settings = (data as { settings?: unknown } | null)?.settings;
  const list = Array.isArray(settings) ? settings : settings ? [settings] : [];
  for (const entry of list) {
    const setting = entry as { _id?: unknown; value?: unknown } | null;
    if (setting && setting._id === id) return { found: true, value: setting.value };
  }
  return { found: false, listed: list.length };
}

/**
 * 读一个公开设置的三种结局。`failed`（限流、5xx、网络异常）与 `missing`（服务端确实
 * 没有这个设置）必须分开：LAN 指纹只在 `missing` 时才允许退回接入 URL 归一化，
 * `failed` 时退回会造出两端指纹来源不一致、互相永远发现不了的单边降级（issue #369）。
 */
export type PublicSettingResult =
  | { status: 'found'; value: unknown }
  | { status: 'missing' }
  | { status: 'failed' };

async function fetchPublicSettings(query: URLSearchParams): Promise<unknown> {
  const res = await httpFetch(`${getServerBase()}/api/v1/settings.public?${query.toString()}`);
  // httpFetch 与 fetch 一样不对非 2xx 抛错。Rocket.Chat 的 429 错误体也是 JSON，
  // 不在这里拦住就会被当成「服务端没有这个设置」，退避重试永远走不到。
  if (!res.ok) throw new Error(`settings.public HTTP ${res.status}`);
  return res.json();
}

/**
 * 老服务端（忽略 `_id` 过滤）的全量公开设置，按服务端地址在内存里共享一份。
 *
 * 一次 `count=0` 就能回答本次会话的所有设置。原先每个设置各拉一遍 359 条，启动时
 * Site_Url / 已读回执 / 讨论开关 / uniqueID 并发下来近十次请求，排在最后的 `uniqueID`
 * 正好撞上限流——这是单边降级在真实服务端上的来源。
 */
let legacySnapshot: { base: string; settings: Promise<unknown> } | null = null;

function legacyPublicSettings(id: string): Promise<unknown> {
  const base = getServerBase();
  if (legacySnapshot?.base === base) return legacySnapshot.settings;
  // count=0 在老服务端表示「不限页大小」，一次拿到全部设置，避免逐页翻。
  const settings = fetchPublicSettings(new URLSearchParams({ _id: id, count: '0' }));
  const snapshot = { base, settings };
  legacySnapshot = snapshot;
  settings.catch(() => {
    // 失败的全量结果不能留着，否则之后的读取都会复用这个失败。
    if (legacySnapshot === snapshot) legacySnapshot = null;
  });
  return settings;
}

async function queryPublicSetting(id: string): Promise<PublicSettingResult> {
  if (legacySnapshot?.base !== getServerBase()) {
    const page = findPublicSetting(await fetchPublicSettings(new URLSearchParams({ _id: id })), id);
    if (page.found) return { status: 'found', value: page.value };
    // 空列表说明服务端按 `_id` 过滤了，只是没有这个设置；非空却不含它，说明这是
    // 忽略过滤、按页返回别的设置的老服务端，要去全量结果里找。
    if (page.listed === 0) return { status: 'missing' };
  }
  const all = findPublicSetting(await legacyPublicSettings(id), id);
  return all.found ? { status: 'found', value: all.value } : { status: 'missing' };
}

/**
 * 公开设置的本地缓存。
 *
 * 必要性来自真实服务端：Rocket.Chat 6.x 对 `settings.public` 限流很紧，连续几次查询
 * 就持续返回 429，而老服务端要走 `count=0` 全量查询（359 条）更重。一次读失败就会让
 * LAN 指纹当次退回接入 URL 归一化（issue #369 的单边降级），所以成功的读取必须跨
 * 重启保留，失败也不能反复重试打爆限流。
 */
function settingCacheKey(id: string): string {
  return `rcx-setting:${getServerBase()}:${id}`;
}

function readCachedSetting(id: string): { hit: boolean; value: unknown } {
  try {
    const raw = localStorage.getItem(settingCacheKey(id));
    if (raw === null) return { hit: false, value: undefined };
    return { hit: true, value: JSON.parse(raw) };
  } catch {
    return { hit: false, value: undefined };
  }
}

function writeCachedSetting(id: string, value: unknown): void {
  try {
    localStorage.setItem(settingCacheKey(id), JSON.stringify(value));
  } catch {
    /* 隐私模式 / 配额满：缓存只是优化，不影响本次结果 */
  }
}

/** 换服务器时清掉所有公开设置缓存（键里带服务端地址，但没必要留着）。 */
function clearCachedSettings(): void {
  try {
    const prefix = 'rcx-setting:';
    const stale: string[] = [];
    // Node 的 localStorage 替身不一定实现 `length`/`key()`；有就清，没有就跳过。
    const length = typeof localStorage.length === 'number' ? localStorage.length : 0;
    for (let index = 0; index < length; index += 1) {
      const key = typeof localStorage.key === 'function' ? localStorage.key(index) : null;
      if (key?.startsWith(prefix)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    /* 读取失败时忽略 */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 同一设置的并发读取共用一个请求（启动时 init 与 LAN 会各读一次 Site_Url）。 */
const inflightSettings = new Map<string, Promise<PublicSettingResult>>();

async function resolvePublicSetting(id: string): Promise<PublicSettingResult> {
  // 限流（429）是真实服务端的常态：退避一次仍失败就报 `failed`，不写缓存，
  // 绝不把「读不到」当成「没有这个设置」。
  for (const attempt of [0, 1]) {
    if (attempt > 0) await sleep(600);
    try {
      const result = await queryPublicSetting(id);
      if (result.status === 'found') writeCachedSetting(id, result.value);
      return result;
    } catch {
      /* 下一轮重试 */
    }
  }
  return { status: 'failed' };
}

/**
 * 读一个公开设置（不需要登录），并告诉调用方是「读到了」「服务端没有」还是「这次读失败」。
 *
 * 老服务端忽略 `_id` 过滤时，第一次请求的 50 条里通常找不到我们要的设置
 * （`uniqueID` 按字母序排在末尾），此时改用本会话共享的全量结果；成功结果写入本地缓存。
 */
export function readPublicSettingResult(id: string): Promise<PublicSettingResult> {
  const cached = readCachedSetting(id);
  if (cached.hit) return Promise.resolve({ status: 'found', value: cached.value });
  const key = settingCacheKey(id);
  const pending = inflightSettings.get(key);
  if (pending) return pending;
  const task = resolvePublicSetting(id).finally(() => inflightSettings.delete(key));
  inflightSettings.set(key, task);
  return task;
}

/**
 * 读一个公开设置；读不到（服务端没有、或请求失败）时返回 `undefined`。
 * 需要区分这两种情况的调用方（LAN 指纹）用 `readPublicSettingResult`。
 */
export async function getPublicSetting(id: string): Promise<unknown> {
  try {
    const result = await readPublicSettingResult(id);
    return result.status === 'found' ? result.value : undefined;
  } catch {
    return undefined;
  }
}

export async function ensureSiteUrl(): Promise<string> {
  if (siteUrlCache) return siteUrlCache;
  try {
    const raw = await getPublicSetting('Site_Url');
    const value = typeof raw === 'string' ? raw.replace(/\/+$/, '') : '';
    if (value) {
      siteUrlCache = value;
      localStorage.setItem(SITE_URL_KEY, value);
    }
  } catch {
    /* 拿不到时回退 */
  }
  return siteUrlCache ?? getServerBase() ?? origin();
}

/** 同步取 Site_Url（init 时已预热缓存） */
export function siteUrlSync(): string {
  return siteUrlCache || getServerBase() || origin();
}

/** 当前页面地址；Node 里（测试脚本 import 到这个模块时）没有 location */
function origin(): string {
  return typeof location === 'undefined' ? '' : location.origin;
}

function wsUrlFor(base: string): string {
  if (base) return `${base.replace(/^http/, 'ws')}/websocket`;
  // 这个模块在顶层就构造 realtime 客户端，一旦直接用 location，
  // 任何 Node 侧脚本（测试）import 到它就崩。同源模式下 URL 由调用方在浏览器里补。
  if (typeof location === 'undefined') return '';
  const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProtocol}://${location.host}/websocket`;
}

// HTTP 通道见 lib/http.ts（桌面端走 Rust 通道绕开 CORS）。
// WebSocket 不受 CORS 限制，仍走原生。

/**
 * 打开外部链接。桌面端 webview 不支持 target="_blank"，
 * 必须经 opener 插件交给系统默认浏览器。
 */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external_url', { url });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** 通过桌面原生命令打开已接收的本地文件，避免 WebView opener ACL 差异。 */
export async function openLocalPath(path: string): Promise<void> {
  if (!isTauri || !path) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_local_file', { path });
}

/** 通过桌面原生命令打开消息正文里的 UNC 共享路径。 */
export async function openUncPath(path: string): Promise<void> {
  if (!isTauri || !path) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_unc_path', { path });
}

/**
 * 全局拦截 <a> 点击：桌面端一律走系统浏览器。
 * 挂一次即可覆盖所有链接（消息正文、卡片、预览…）。
 */
export function installLinkInterceptor(onError: (error: unknown) => void = console.error): void {
  if (!isTauri) return;
  document.addEventListener(
    'click',
    (e) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      const href = anchor?.getAttribute('href');
      if (!href || !/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      void openExternal(href).catch(onError);
    },
    true,
  );
}

/**
 * 桌面端屏蔽 webview 自带的右键菜单。
 *
 * 不屏蔽的话，在会话列表空白处点右键弹出来的是浏览器的「返回 / 刷新 / 另存为 /
 * 打印 / 检查」—— 一个聊天软件里冒出这些，用户当场就出戏了。
 *
 * 但输入框和可选中的文本要放行：那里的原生菜单提供复制/粘贴/拼写检查，
 * 自己重造一套只会更差。
 */
export function installContextMenuGuard(): void {
  if (!isTauri) return;
  document.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el) return;
    const editable =
      el.closest('input, textarea, [contenteditable="true"]') !== null ||
      !!window.getSelection()?.toString();
    // 组件自己处理过的（会话行、消息、分组）已经 preventDefault 了，这里不会再走到
    if (!editable) e.preventDefault();
  });
}

// 会话失效（token 被吊销 / 过期）时的处理器。由 auth store 注册，避免 client ←→ auth
// 的循环 import。REST 401 与实时 login 失败都汇到这里，统一登出回登录页。
let authLostHandler: (() => void) | null = null;
export function setAuthLostHandler(fn: () => void): void {
  authLostHandler = fn;
}

// 认证从 localStorage 实时读取（authProvider），不依赖登录时序。
export const rest = new RcRestClient({
  baseUrl: getServerBase(),
  authProvider: loadStoredAuth,
  fetchImpl: isTauri ? httpFetch : undefined,
  onAuthError: () => authLostHandler?.(),
});
export const realtime = new RcRealtimeClient(wsUrlFor(getServerBase()));

/**
 * 写用户偏好：优先走 DDP `saveUserPreferences`。
 *
 * RC 8.x 的 REST users.setPreferences 是 schema 校验端点（additionalProperties:false），
 * RocketX 自定义键（rcxAliases/rcxNameFormat）会被 invalid-params 整体拒绝；
 * DDP 方法是 Match.ObjectIncluding，放行额外键（saveUserPreferences 是很老的接口，
 * 旧服务器同样存在；未来版本移除时 call 会报错，自然落到 REST 回退）。
 * 实时连接未就绪（status !== 'connected'，此时 WS 尚未完成 login）直接用 REST，
 * 避免 call 投不出去干等 15s 超时。
 */
export async function savePreferences(data: Partial<RcPreferences>): Promise<void> {
  if (realtime.status === 'connected') {
    try {
      await realtime.call('saveUserPreferences', data);
      return;
    } catch {
      /* 方法不可用或连接刚好断开：回退 REST */
    }
  }
  await rest.setPreferences(data);
}
