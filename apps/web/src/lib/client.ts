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

// 开发环境经 Vite 代理走同源；生产部署时由反向代理把
// /api /websocket /avatar 转发到 Rocket.Chat。
// 认证从 localStorage 实时读取（authProvider），不依赖登录时序。
export const rest = new RcRestClient({ baseUrl: '', authProvider: loadStoredAuth });

const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
export const realtime = new RcRealtimeClient(`${wsProtocol}://${location.host}/websocket`);
