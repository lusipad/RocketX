import { create } from 'zustand';
import { RcApiError, type RcUser } from '@rcx/rc-client';
import { t } from '../i18n';
import {
  lifecycleClearBusinessMcpAzureDevOps,
  lifecycleClearBusinessMcpRocketChat,
  lifecycleSyncBusinessMcpAzureDevOps,
  lifecycleSyncBusinessMcpRocketChat,
  runUserRuntimeShutdownHooks,
} from '../lib/runtimeLifecycle';
import { loadWorkbenchConfig } from '../lib/ado';
import { loadStoredAuth, realtime, rest, saveAuth, setAuthLostHandler } from '../lib/client';
import { getServerBase } from '../lib/serverEndpoint';
import { completeFirstRun } from '../lib/firstRun';
import { ensureHttpOrigin } from '../lib/http';
import { ensureAccountScope, LOCAL_ACCOUNT_OWNER, LOCAL_MODE_USER_ID } from '../lib/accountScope';
import { runtimeFeatures } from '../lib/runtimeMode';
import { useAliases } from './aliases';
import { registerFocusPresencePort } from './focus';
import { useUI } from './ui';
import { restoreTrayAttention } from '../lib/tray';
import type { LoginFailureDisplay } from '../lib/loginDiagnostic';
import { writeLoginDiagnostic } from '../lib/loginDiagnostic';
import { startupPresence } from '../lib/presencePreference';

export { LOCAL_MODE_USER_ID };
export const LOCAL_MODE_STORAGE_KEY = 'rcx-local-mode';
export const USER_CACHE_KEY = 'rcx-user-cache';

export function isDefiniteAuthRejection(error: unknown): boolean {
  if (!(error instanceof RcApiError) && !(error instanceof Error && error.name === 'RcApiError')) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

function saveCachedUser(user: RcUser): void {
  try {
    if (typeof localStorage === 'undefined' || !user._id) return;
    localStorage.setItem(USER_CACHE_KEY, JSON.stringify({
      _id: user._id,
      username: user.username,
      name: user.name,
      avatarETag: user.avatarETag,
    }));
  } catch {
    /* 无痕或非浏览器环境忽略 */
  }
}

function loadCachedUser(userId: string): RcUser | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RcUser> | null;
    if (!parsed || parsed._id !== userId) return null;
    return {
      _id: userId,
      username: typeof parsed.username === 'string' && parsed.username ? parsed.username : userId,
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : userId,
      ...(typeof parsed.avatarETag === 'string' ? { avatarETag: parsed.avatarETag } : {}),
      status: 'offline',
    };
  } catch {
    return null;
  }
}

function localUser(): RcUser {
  return {
    _id: LOCAL_MODE_USER_ID,
    username: 'local',
    name: t('nav.rail.localMode'),
    status: 'offline',
  };
}

interface AuthState {
  status: 'boot' | 'guest' | 'authing' | 'authed';
  localMode: boolean;
  needsReauth: boolean;
  user: RcUser | null;
  error: LoginFailureDisplay | null;
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
  /** 启动时尝试用本地 token 恢复会话；未登录 Rocket.Chat 时默认直接进入本地工作区 */
  resume: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  /** 免 Rocket.Chat 登录直接进入本地工作区 */
  enterLocalMode: () => Promise<void>;
  /** 打开内嵌 Rocket.Chat 连接入口（保留本地工作区与侧栏） */
  exitLocalMode: () => Promise<void>;
  logout: () => Promise<void>;
  /** 改完资料后重新拉一遍自己（昵称、头像 ETag） */
  refreshUser: () => Promise<void>;
  bumpAvatar: () => void;
  /** 会话失效（token 被吊销/过期，REST 401 或实时 login 失败）：仅锁定远端消息与联系人，保留本地账号作用域与工作区 */
  handleAuthLost: () => void;
}

const AVATAR_VERSION_KEY = 'rcx-avatar-version';
const OWNER_STORAGE_KEY = 'rcx-owner';

function readRecoverableRemoteAccountOwner(): { owner: string; userId: string } | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    if (localStorage.getItem(LOCAL_MODE_STORAGE_KEY) === '1') return null;
    const owner = localStorage.getItem(OWNER_STORAGE_KEY)?.trim() ?? '';
    if (!owner || owner === LOCAL_ACCOUNT_OWNER) return null;
    const atIndex = owner.indexOf('@');
    const userId = atIndex > 0 ? owner.slice(0, atIndex) : '';
    if (!userId || userId === LOCAL_MODE_USER_ID) return null;
    return { owner, userId };
  } catch {
    return null;
  }
}

function buildFallbackUser(userId: string): RcUser {
  return loadCachedUser(userId) ?? {
    _id: userId,
    username: userId,
    name: userId,
    status: 'offline',
  };
}

function writeLocalModeFlag(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(LOCAL_MODE_STORAGE_KEY, '1');
    else localStorage.removeItem(LOCAL_MODE_STORAGE_KEY);
  } catch {
    /* 无痕或非浏览器环境忽略 */
  }
}

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
        if (!me.localMode && !me.needsReauth && (me.status === 'authed' || me.status === 'authing')) onLost();
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

async function syncBusinessMcpSession(auth: { authToken: string; userId: string }): Promise<void> {
  const workbench = loadWorkbenchConfig();
  await Promise.all([
    lifecycleSyncBusinessMcpRocketChat({
      serverUrl: getServerBase(),
      userId: auth.userId,
      authToken: auth.authToken,
    }),
    lifecycleSyncBusinessMcpAzureDevOps({
      collectionUrl: workbench?.adoBase,
      authMode: workbench?.auth,
      pat: workbench?.pat,
      allowInsecureAdoHttp: workbench?.allowInsecureAdoHttp,
    }),
  ]);
}

async function syncLocalBusinessMcpSession(): Promise<void> {
  const workbench = loadWorkbenchConfig();
  await Promise.all([
    lifecycleClearBusinessMcpRocketChat(),
    lifecycleSyncBusinessMcpAzureDevOps({
      collectionUrl: workbench?.adoBase,
      authMode: workbench?.auth,
      pat: workbench?.pat,
      allowInsecureAdoHttp: workbench?.allowInsecureAdoHttp,
    }),
  ]);
}

let businessMcpSyncInFlight: Promise<void> | null = null;

function startBusinessMcpSync(auth: { authToken: string; userId: string }): Promise<void> {
  const task = syncBusinessMcpSession(auth);
  businessMcpSyncInFlight = task;
  const clear = () => {
    if (businessMcpSyncInFlight === task) businessMcpSyncInFlight = null;
  };
  void task.then(clear, clear);
  return task;
}

async function clearBusinessMcpSession(): Promise<void> {
  const pending = businessMcpSyncInFlight;
  if (pending) await pending.catch(() => undefined);
  await Promise.all([
    lifecycleClearBusinessMcpRocketChat(),
    lifecycleClearBusinessMcpAzureDevOps(),
  ]);
}

async function shutdownUserRuntime(): Promise<void> {
  await runUserRuntimeShutdownHooks();
}

async function activateLocalWorkspace(
  set: (partial: Partial<AuthState>) => void,
  error: LoginFailureDisplay | null = null,
): Promise<void> {
  writeLocalModeFlag(true);
  if (ensureAccountScope(LOCAL_MODE_USER_ID) === 'switched') {
    await lifecycleClearBusinessMcpRocketChat().catch(() => undefined);
    await shutdownUserRuntime();
    location.reload();
    return;
  }
  set({ status: 'authed', localMode: true, needsReauth: false, user: localUser(), error });
  void syncLocalBusinessMcpSession().catch((syncError) => {
    console.warn('[rcx] 本地模式业务 MCP 同步失败', syncError);
  });
}

function applyStartupPresence(user: RcUser, userId: string): RcUser {
  const status = startupPresence(getServerBase(), userId);
  if (user.status === status) return user;
  // 在线状态写回不应阻塞首屏，也不应把一个仍然有效的登录会话踢回登录页。
  void rest.setStatus(status).catch(() => {});
  return { ...user, status };
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'boot',
  localMode: false,
  needsReauth: false,
  user: null,
  error: null,
  avatarVersion: readAvatarVersion(),

  resume: async () => {
    // 会话失效 / 多标签处理器在启动时挂一次
    wireSessionHandlers(() => get().handleAuthLost());
    const stored = loadStoredAuth();
    if (!stored) {
      const recoverable = readRecoverableRemoteAccountOwner();
      if (recoverable) {
        writeLocalModeFlag(false);
        const fallbackUser = buildFallbackUser(recoverable.userId);
        set({
          status: 'authed',
          localMode: false,
          needsReauth: true,
          user: fallbackUser,
          error: {
            kind: 'session_expired',
            stage: 'login',
            summary: t('auth.session.resumeExpiredSummary'),
            detail: t('auth.session.resumeExpiredDetail'),
            diagnostic: `stage=resume kind=session_expired detail=no stored token for ${recoverable.owner}, preserved account scope`,
          },
        });
        void syncLocalBusinessMcpSession().catch((syncError) => {
          console.warn('[rcx] 离线模式业务 MCP 同步失败', syncError);
        });
        return;
      }
      await activateLocalWorkspace(set, null);
      return;
    }
    try {
      await ensureHttpOrigin(getServerBase());
      const data = await rest.loginWithToken(stored.authToken);
      writeLocalModeFlag(false);
      // 重新写一遍认证信息，确保 rc_uid/rc_token cookie 就位（头像、文件下载要用）
      saveAuth({ authToken: data.authToken, userId: data.userId });
      // 本地数据换主人了（换账号/首次升级）→ 搬移后重载，让各 store 重新加载
      if (ensureAccountScope(data.userId) === 'switched') {
        await clearBusinessMcpSession();
        await shutdownUserRuntime();
        location.reload();
        return;
      }
      const authedUser = applyStartupPresence(data.me, data.userId);
      saveCachedUser(authedUser);
      set({ status: 'authed', localMode: false, needsReauth: false, user: authedUser, error: null });
      // 业务 MCP 只影响 AI 工具配置，放到登录完成后同步，避免网络抖动拖住首屏。
      void startBusinessMcpSync({ authToken: data.authToken, userId: data.userId }).catch((error) => {
        console.warn('[rcx] 业务 MCP 会话同步失败', error);
      });
      // 登录后把服务端备注名合并进本地缓存（首次登录则把本机数据迁移上传），失败不阻塞登录
      void useAliases.getState().sync();
    } catch (err) {
      if (isDefiniteAuthRejection(err)) {
        saveAuth(null);
        writeLocalModeFlag(false);
        await lifecycleClearBusinessMcpRocketChat().catch(() => undefined);
        const fallbackUser = buildFallbackUser(stored.userId);
        // 明确收到 401/403 时仅清理失效 token 并标记 needsReauth，不切去 local-user@local 也不退出 MainPage。
        set({
          status: 'authed',
          localMode: false,
          needsReauth: true,
          user: fallbackUser,
          error: {
            kind: 'session_expired',
            stage: 'login',
            summary: t('auth.session.resumeExpiredSummary'),
            detail: t('auth.session.resumeExpiredDetail'),
            diagnostic: 'stage=resume kind=session_expired detail=token rejected (401/403), preserved account scope',
          },
        });
        void syncLocalBusinessMcpSession().catch((syncError) => {
          console.warn('[rcx] 离线模式业务 MCP 同步失败', syncError);
        });
        return;
      }
      // 网络离线、VPN 未通、超时或服务端 5xx：保留 rcx-auth 与原账号作用域，进入离线就绪态。
      writeLocalModeFlag(false);
      if (ensureAccountScope(stored.userId) === 'switched') {
        await clearBusinessMcpSession().catch(() => undefined);
        await shutdownUserRuntime();
        location.reload();
        return;
      }
      const fallbackUser = buildFallbackUser(stored.userId);
      set({ status: 'authed', localMode: false, needsReauth: false, user: fallbackUser, error: null });
      void syncLocalBusinessMcpSession().catch((syncError) => {
        console.warn('[rcx] 离线模式业务 MCP 同步失败', syncError);
      });
    }
  },

  login: async (username, password) => {
    const prev = get();
    const wasLocalMode = prev.localMode;
    const wasNeedsReauth = prev.needsReauth;
    const prevUser = prev.user;
    set({
      status: 'authing',
      localMode: wasLocalMode,
      needsReauth: wasNeedsReauth,
      user: wasLocalMode ? localUser() : wasNeedsReauth ? prevUser : null,
      error: null,
    });
    try {
      await ensureHttpOrigin(getServerBase());
      const data = await rest.login(username, password);
      writeLocalModeFlag(false);
      saveAuth({ authToken: data.authToken, userId: data.userId });
      // 同一台机器换账号登录：先把上一个人的本地数据搬走、还原自己的,再重载
      if (ensureAccountScope(data.userId) === 'switched') {
        await clearBusinessMcpSession();
        await shutdownUserRuntime();
        location.reload();
        return;
      }
      const authedUser = applyStartupPresence(data.me, data.userId);
      saveCachedUser(authedUser);
      set({ status: 'authed', localMode: false, needsReauth: false, user: authedUser, error: null });
      void startBusinessMcpSync({ authToken: data.authToken, userId: data.userId }).catch((error) => {
        console.warn('[rcx] 业务 MCP 会话同步失败', error);
      });
      // 登录后把服务端备注名合并进本地缓存（首次登录则把本机数据迁移上传），失败不阻塞登录
      void useAliases.getState().sync();
    } catch (err) {
      const diag = await writeLoginDiagnostic(err, 'login');
      if (wasLocalMode) {
        await lifecycleClearBusinessMcpRocketChat().catch(() => undefined);
        set({ status: 'authed', localMode: true, needsReauth: false, user: localUser(), error: diag });
        return;
      }
      if (wasNeedsReauth) {
        await lifecycleClearBusinessMcpRocketChat().catch(() => undefined);
        set({ status: 'authed', localMode: false, needsReauth: true, user: prevUser, error: diag });
        return;
      }
      await clearBusinessMcpSession();
      set({ status: 'guest', localMode: false, needsReauth: false, error: diag });
    }
  },

  enterLocalMode: async () => {
    wireSessionHandlers(() => get().handleAuthLost());
    if (typeof localStorage !== 'undefined') {
      completeFirstRun(localStorage);
    }
    saveAuth(null);
    realtime.close();
    await activateLocalWorkspace(set, null);
    if (useUI.getState().module === 'messages') {
      useUI.getState().setModule(runtimeFeatures().butler ? 'butler-view' : 'todos');
    }
  },

  exitLocalMode: async () => {
    useUI.getState().setModule('messages');
  },

  logout: async () => {
    if (get().localMode) {
      await get().exitLocalMode();
      return;
    }
    await shutdownUserRuntime();
    realtime.close();
    saveAuth(null);
    writeLocalModeFlag(true);
    await clearBusinessMcpSession();
    try {
      await rest.logout();
    } catch {
      /* 忽略登出失败 */
    }
    // reload 会销毁 JS 定时器；必须先等原生托盘恢复，避免透明帧永久残留。
    await restoreTrayAttention();
    set({ status: 'authed', localMode: true, needsReauth: false, user: localUser(), error: null });
    location.reload();
  },

  refreshUser: async () => {
    if (get().localMode || get().needsReauth) return;
    try {
      const me = await rest.me();
      saveCachedUser(me);
      set({ user: me });
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
    // 幂等：只在已连接远端账号且尚未处于 needsReauth 时处理（401 会一批一起来）；本地模式忽略远端 401
    const st = get();
    if (st.localMode || st.needsReauth || (st.status !== 'authed' && st.status !== 'authing')) return;
    realtime.close();
    saveAuth(null);
    writeLocalModeFlag(false);
    void lifecycleClearBusinessMcpRocketChat().catch(() => undefined);
    void syncLocalBusinessMcpSession().catch((syncError) => {
      console.warn('[rcx] 离线模式业务 MCP 同步失败', syncError);
    });
    set({
      status: 'authed',
      localMode: false,
      needsReauth: true,
      user: st.user ? { ...st.user, status: 'offline' } : null,
      error: {
        kind: 'session_expired',
        stage: 'login',
        summary: t('auth.session.lostSummary'),
        detail: t('auth.session.lostDetail'),
        diagnostic: 'stage=login kind=session_expired detail=session invalidated locally (preserved account scope)',
      },
    });
  },
}));

registerFocusPresencePort({
  readStatus: () => useAuth.getState().user?.status,
  writeStatus: (status) => {
    const state = useAuth.getState();
    if (state.localMode || state.needsReauth) return null;
    return rest.setStatus(status).then(() => undefined);
  },
});
