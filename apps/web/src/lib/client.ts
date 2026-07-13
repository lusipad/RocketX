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

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

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
  return siteUrlCache ?? getServerBase() ?? location.origin;
}

/** 同步取 Site_Url（init 时已预热缓存） */
export function siteUrlSync(): string {
  return siteUrlCache || getServerBase() || location.origin;
}

function wsUrlFor(base: string): string {
  if (base) return `${base.replace(/^http/, 'ws')}/websocket`;
  const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProtocol}://${location.host}/websocket`;
}

// 桌面端：HTTP 走 Tauri 的 Rust 通道（plugin-http），绕开 webview CORS，
// 连接任意 Rocket.Chat 服务器都无需服务端配置。WebSocket 不受 CORS 限制，仍走原生。
const tauriFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const { fetch: pluginFetch } = await import('@tauri-apps/plugin-http');
  return pluginFetch(input, init);
}) as typeof fetch;

/** 平台无关的 HTTP：桌面端走 Rust 通道（无 CORS 限制），Web 端走浏览器 fetch */
export const httpFetch: typeof fetch = isTauri
  ? tauriFetch
  : (((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch);

// 认证从 localStorage 实时读取（authProvider），不依赖登录时序。
export const rest = new RcRestClient({
  baseUrl: getServerBase(),
  authProvider: loadStoredAuth,
  fetchImpl: isTauri ? tauriFetch : undefined,
});
export const realtime = new RcRealtimeClient(wsUrlFor(getServerBase()));
