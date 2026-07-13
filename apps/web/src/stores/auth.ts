import { create } from 'zustand';
import type { RcUser } from '@rcx/rc-client';
import { loadStoredAuth, realtime, rest, saveAuth } from '../lib/client';

interface AuthState {
  status: 'boot' | 'guest' | 'authing' | 'authed';
  user: RcUser | null;
  error: string | null;
  /**
   * 头像版本号，换头像后 +1。
   *
   * Rocket.Chat 的头像地址是 /avatar/:username —— 换了图 URL 还是同一个，
   * 浏览器照旧拿缓存，界面上看不出任何变化。靠这个数字挂到查询串上把缓存打掉。
   */
  avatarVersion: number;
  /** 启动时尝试用本地 token 恢复登录 */
  resume: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 改完资料后重新拉一遍自己（昵称、头像 ETag） */
  refreshUser: () => Promise<void>;
  bumpAvatar: () => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'boot',
  user: null,
  error: null,
  avatarVersion: 0,

  resume: async () => {
    const stored = loadStoredAuth();
    if (!stored) {
      set({ status: 'guest' });
      return;
    }
    try {
      const data = await rest.loginWithToken(stored.authToken);
      // 重新写一遍认证信息，确保 rc_uid/rc_token cookie 就位（头像、文件下载要用）
      saveAuth({ authToken: data.authToken, userId: data.userId });
      set({ status: 'authed', user: data.me, error: null });
    } catch {
      saveAuth(null);
      set({ status: 'guest' });
    }
  },

  login: async (username, password) => {
    set({ status: 'authing', error: null });
    try {
      const data = await rest.login(username, password);
      saveAuth({ authToken: data.authToken, userId: data.userId });
      set({ status: 'authed', user: data.me, error: null });
    } catch (err) {
      // Tauri 插件可能抛字符串而非 Error，都要兜住
      const raw = err instanceof Error ? err.message : String(err ?? '');
      let friendly: string;
      if (/unauthorized/i.test(raw)) {
        friendly = '用户名或密码错误';
      } else if (/fetch|network|load failed|error sending request|not allowed|scope/i.test(raw)) {
        friendly = '无法连接服务器：请检查服务器地址是否正确、网络是否可达';
      } else {
        friendly = raw || '登录失败，请重试';
      }
      set({ status: 'guest', error: friendly });
    }
  },

  logout: async () => {
    realtime.close();
    saveAuth(null);
    try {
      await rest.logout();
    } catch {
      /* 忽略登出失败 */
    }
    set({ status: 'guest', user: null });
    location.reload();
  },

  refreshUser: async () => {
    try {
      set({ user: await rest.me() });
    } catch {
      /* 拉不到就先用旧的，不至于把界面上的自己弄没 */
    }
  },

  bumpAvatar: () => set({ avatarVersion: get().avatarVersion + 1 }),
}));
