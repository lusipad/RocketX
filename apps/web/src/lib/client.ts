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
  localStorage.setItem(SERVER_KEY, normalized);
  rest.baseUrl = normalized;
  realtime.setUrl(wsUrlFor(normalized));
}

/** 头像 / 上传文件等静态资源的绝对地址 */
export function assetUrl(path: string): string {
  return `${getServerBase()}${path}`;
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
