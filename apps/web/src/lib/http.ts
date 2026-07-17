/**
 * 平台无关的 HTTP。
 *
 * 单独成一个模块，是为了让 ADO 这类纯网络代码不必去 import client.ts ——
 * 那里在模块顶层就构造了 Rocket.Chat 的 WebSocket 客户端（用到 location），
 * 一 import 就把整个 IM 客户端和浏览器全局拖进来，Node 里跑不了、也没法测。
 */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// 桌面端：HTTP 走 Tauri 的 Rust 通道（plugin-http），绕开 webview CORS，
// 连任意服务器都不需要服务端配合。
const tauriFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const rawUrl = input instanceof Request ? input.url : input.toString();
  const url = new URL(rawUrl, location.href);
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !grantedOrigins.has(url.origin)) {
    throw new Error(`HTTP origin 尚未由宿主授权: ${url.origin}`);
  }
  const { fetch: pluginFetch } = await import('@tauri-apps/plugin-http');
  return pluginFetch(input, init);
}) as typeof fetch;

const grantedOrigins = new Set<string>();
const grantingOrigins = new Map<string, Promise<string>>();

export async function ensureHttpOrigin(input: string | URL): Promise<string> {
  const url = new URL(input.toString());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('只允许无凭据的 http/https 地址');
  }
  if (!isTauri) return url.origin;
  if (grantedOrigins.has(url.origin)) return url.origin;
  const pending = grantingOrigins.get(url.origin);
  if (pending) return pending;
  const task = import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke<string>('allow_http_origin', { origin: url.origin }))
    .then(
      (origin) => {
        grantedOrigins.add(origin);
        grantingOrigins.delete(url.origin);
        return origin;
      },
      (error) => {
        grantingOrigins.delete(url.origin);
        throw error;
      },
    );
  grantingOrigins.set(url.origin, task);
  return task;
}

/** 桌面端走 Rust 通道，其余（Web / Node 测试脚本）走原生 fetch */
export const httpFetch: typeof fetch = isTauri
  ? tauriFetch
  : (((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch);
