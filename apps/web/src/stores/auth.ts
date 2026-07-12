import { create } from 'zustand';
import type { RcUser } from '@rcx/rc-client';
import { loadStoredAuth, realtime, rest, saveAuth } from '../lib/client';

interface AuthState {
  status: 'boot' | 'guest' | 'authing' | 'authed';
  user: RcUser | null;
  error: string | null;
  /** 启动时尝试用本地 token 恢复登录 */
  resume: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  status: 'boot',
  user: null,
  error: null,

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
      set({
        status: 'guest',
        error: err instanceof Error ? err.message : '登录失败，请检查用户名和密码',
      });
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
}));
