import { create } from 'zustand';
import type { RcUser } from '@rcx/rc-client';
import { getServerBase, loadStoredAuth, realtime, rest, saveAuth, setAuthLostHandler } from '../lib/client';
import { ensureHttpOrigin } from '../lib/http';
import { ensureAccountScope } from '../lib/accountScope';
import { restoreTrayAttention } from '../lib/tray';
import { loginFailureMessage } from '../lib/loginDiagnostic';

interface AuthState {
  status: 'boot' | 'guest' | 'authing' | 'authed';
  user: RcUser | null;
  error: string | null;
  /**
   * 自己头像的版本号，换头像后 +1。
   *
   * Rocket.Chat 的头像地址是 /avatar/:username —— 换了图 URL 还是同一个，
   * 浏览器照旧拿缓存，界面上看不出任何变化。靠这个数字挂到查询串上把缓存打掉。
   *
   * 必须持久化：只存在内存里的话，刷新一次就归 0，URL 退回没有 v 参数的那个，
   * 又命中旧图缓存 —— 换完头像刷新反而看到旧头像。
   */
  avatarVersion: number;
  /** 启动时尝试用本地 token 恢复登录 */
  resume: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 改完资料后重新拉一遍自己（昵称、头像 ETag） */
  refreshUser: () => Promise<void>;
  bumpAvatar: () => void;
  /** 会话失效（token 被吊销/过期，REST 401 或实时 login 失败）：登出回登录页 */
  handleAuthLost: () => void;
}

const AVATAR_VERSION_KEY = 'rcx-avatar-version';

/** 会话失效 / 多标签同步的处理器只挂一次 */
let sessionHandlersWired = false;
function wireSessionHandlers(onLost: () => void): void {
  if (sessionHandlersWired) return;
  sessionHandlersWired = true;
  // REST 401 与实时 login 失败都汇到同一处理
  setAuthLostHandler(onLost);
  realtime.onAuthFailure = onLost;
  // 多标签同步：其他标签登出/换账号时本标签跟着走，
  // 否则内存里还是「已登录」、请求却全 401（P1-9）
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== 'rcx-auth') return;
      const cur = loadStoredAuth();
      const me = useAuth.getState();
      if (!cur) {
        if (me.status === 'authed' || me.status === 'authing') onLost();
      } else if (me.user && cur.userId !== me.user._id) {
        // 换了账号：内存状态还是旧账号，直接重载去加载新账号
        location.reload();
      }
    });
  }
}

/** Node 下跑纯函数单测时没有 localStorage，读写都得兜住 */
function readAvatarVersion(): number {
  try {
    return Number(localStorage.getItem(AVATAR_VERSION_KEY)) || 0;
  } catch {
    return 0;
  }
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'boot',
  user: null,
  error: null,
  avatarVersion: readAvatarVersion(),

  resume: async () => {
    // 会话失效 / 多标签处理器在启动时挂一次
    wireSessionHandlers(() => get().handleAuthLost());
    const stored = loadStoredAuth();
    if (!stored) {
      set({ status: 'guest' });
      return;
    }
    try {
      await ensureHttpOrigin(getServerBase());
      const data = await rest.loginWithToken(stored.authToken);
      // 重新写一遍认证信息，确保 rc_uid/rc_token cookie 就位（头像、文件下载要用）
      saveAuth({ authToken: data.authToken, userId: data.userId });
      // 本地数据换主人了（换账号/首次升级）→ 搬移后重载，让各 store 重新加载
      if (ensureAccountScope(data.userId) === 'switched') {
        location.reload();
        return;
      }
      set({ status: 'authed', user: data.me, error: null });
    } catch {
      saveAuth(null);
      set({ status: 'guest' });
    }
  },

  login: async (username, password) => {
    set({ status: 'authing', error: null });
    try {
      await ensureHttpOrigin(getServerBase());
      const data = await rest.login(username, password);
      saveAuth({ authToken: data.authToken, userId: data.userId });
      // 同一台机器换账号登录：先把上一个人的本地数据搬走、还原自己的,再重载
      if (ensureAccountScope(data.userId) === 'switched') {
        location.reload();
        return;
      }
      set({ status: 'authed', user: data.me, error: null });
    } catch (err) {
      set({ status: 'guest', error: loginFailureMessage(err) });
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
    // reload 会销毁 JS 定时器；必须先等原生托盘恢复，避免透明帧永久残留。
    await restoreTrayAttention();
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

  bumpAvatar: () => {
    const next = get().avatarVersion + 1;
    try {
      localStorage.setItem(AVATAR_VERSION_KEY, String(next));
    } catch {
      /* 无痕模式 / 非浏览器环境：内存里记着就行 */
    }
    set({ avatarVersion: next });
  },

  handleAuthLost: () => {
    // 幂等：只在真的处于登录态时处理，避免重复触发（401 会一批一起来）
    const st = get();
    if (st.status !== 'authed' && st.status !== 'authing') return;
    realtime.close();
    saveAuth(null);
    set({ status: 'guest', user: null, error: '登录已失效，请重新登录' });
  },
}));
