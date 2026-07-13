import { create } from 'zustand';
import type { RcPreferences } from '@rcx/rc-client';
import { rest } from '../lib/client';
import { toast } from './toast';

/** RC 用户偏好：服务端持久化，跨设备同步 */
interface PrefsState {
  prefs: ResolvedPrefs;
  loaded: boolean;
  load: () => Promise<void>;
  /** 乐观更新 + 同步到服务端 */
  update: (patch: Partial<RcPreferences>) => Promise<void>;
}

/**
 * 合并默认值之后的偏好：所有字段都必有值。
 *
 * 之前各个组件各写各的 `prefs.x ?? 默认值`，同一个开关在 20 处散落着默认值 ——
 * 结果 sidebarGroupByType 在会话列表里是 false、在设置页里是 true，
 * 界面显示的和实际行为对不上。默认值只能有一处。
 */
export type ResolvedPrefs = RcPreferences & Required<Pick<RcPreferences, keyof typeof DEFAULTS>>;

const DEFAULTS = {
  /**
   * 「消息」默认按时间自然排列，不按类型切成 收藏/团队/讨论/频道/私聊 几段。
   *
   * 分区看着整齐，代价是「最新的那条消息在哪」变成一道找茬题 —— 它可能在任何一段里，
   * 而人对会话的记忆本来就是按时间的。飞书、微信默认都是一条流。
   * 想要分区的人可以在 设置 → 侧栏 里打开。
   */
  sidebarGroupByType: false,
  sidebarShowFavorites: true,
  sidebarShowUnread: false,
  sidebarSortby: 'activity',
  sidebarViewMode: 'medium',
  sidebarDisplayAvatar: true,
  sendOnEnter: 'normal',
  autoImageLoad: true,
  useEmojis: true,
  convertAsciiEmoji: true,
  hideUsernames: false,
  showThreadsInMainChannel: false,
  displayAvatars: true,
  desktopNotifications: 'all',
  unreadAlert: true,
  muteFocusedConversations: true,
  notificationsSoundVolume: 100,
  enableAutoAway: true,
  idleTimeLimit: 300,
} satisfies Partial<RcPreferences>;

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: DEFAULTS,
  loaded: false,

  /**
   * 只有「用户真的改过」的偏好才覆盖我们的默认值。
   *
   * 坑在这里：`/api/v1/me` 返回的 38 个偏好里，绝大多数是 **Rocket.Chat 的默认值**，
   * 不是用户设过的。直接 `{...DEFAULTS, ...服务端}` 合并，等于我们的默认值
   * 永远被 RC 的默认值盖掉 —— 比如 sidebarGroupByType，RC 默认 true，
   * 我们改成 false 完全不起作用。
   *
   * `users.info` 里的 settings.preferences 才是用户显式保存过的那些键。
   */
  load: async () => {
    try {
      const explicit = await rest.getExplicitPreferences();
      set({ prefs: { ...DEFAULTS, ...explicit }, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  update: async (patch) => {
    const prev = get().prefs;
    set({ prefs: { ...prev, ...patch } });
    try {
      await rest.setPreferences(patch);
    } catch (err) {
      set({ prefs: prev }); // 失败回滚
      toast.error(err, '设置保存失败');
    }
  },
}));

// 调试用：控制台可查 window.__prefs
if (typeof window !== 'undefined') {
  (window as unknown as { __prefs?: typeof usePrefs }).__prefs = usePrefs;
}
