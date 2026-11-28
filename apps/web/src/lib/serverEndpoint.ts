const SERVER_KEY = 'rcx-server';
export const SITE_URL_KEY = 'rcx-site-url';

export type ServerBaseChangeListener = (normalized: string, changed: boolean) => void;

const serverBaseListeners = new Set<ServerBaseChangeListener>();

/**
 * 订阅 Rocket.Chat 服务端地址变更（例如设置页保存、首次引导或团队配置同步）。
 * `client.ts` 等上层通信客户端通过此回调更新 baseUrl，避免基础库反过来依赖传输单例。
 */
export function onServerBaseChanged(listener: ServerBaseChangeListener): () => void {
  serverBaseListeners.add(listener);
  return () => serverBaseListeners.delete(listener);
}

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
  if (changed) {
    localStorage.removeItem(SITE_URL_KEY);
  }
  for (const listener of serverBaseListeners) {
    listener(normalized, changed);
  }
}

/** 头像 / 上传文件等静态资源的绝对地址 */
export function assetUrl(path: string): string {
  return `${getServerBase()}${path}`;
}

/**
 * 站内文件路径归一化。服务器在部分字段里给的是按 Site_Url 拼出来的绝对地址
 * （如 files.list 的 url 字段），而客户端实际连接的地址可能不一样 —— 直接拿去请求就会打到
 * 一个到不了的主机上（issue #19-8）。凡是站内文件端点，取出路径部分重拼到当前连接地址。
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
