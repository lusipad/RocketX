import { RcRestClient, RcRealtimeClient } from '@rcx/rc-client';

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
export { httpFetch, isTauri };

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
  }
}

/** 头像 / 上传文件等静态资源的绝对地址 */
export function assetUrl(path: string): string {
  return `${getServerBase()}${path}`;
}

// Site_Url：引用回复的消息链接必须以它为前缀，服务端才会展开成引用附件
const SITE_URL_KEY = 'rcx-site-url';
let siteUrlCache: string | null = null;
try {
  siteUrlCache = localStorage.getItem(SITE_URL_KEY);
} catch {
  /* SSR/隐私模式 */
}

export async function ensureSiteUrl(): Promise<string> {
  if (siteUrlCache) return siteUrlCache;
  try {
    const res = await httpFetch(`${getServerBase()}/api/v1/settings.public?_id=Site_Url`);
    const data: any = await res.json();
    const setting = Array.isArray(data?.settings) ? data.settings[0] : data?.settings;
    const value = typeof setting?.value === 'string' ? setting.value.replace(/\/+$/, '') : '';
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
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * 全局拦截 <a> 点击：桌面端一律走系统浏览器。
 * 挂一次即可覆盖所有链接（消息正文、卡片、预览…）。
 */
export function installLinkInterceptor(): void {
  if (!isTauri) return;
  document.addEventListener(
    'click',
    (e) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      const href = anchor?.getAttribute('href');
      if (!href || !/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      void openExternal(href);
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

// 认证从 localStorage 实时读取（authProvider），不依赖登录时序。
export const rest = new RcRestClient({
  baseUrl: getServerBase(),
  authProvider: loadStoredAuth,
  fetchImpl: isTauri ? httpFetch : undefined,
});
export const realtime = new RcRealtimeClient(wsUrlFor(getServerBase()));
