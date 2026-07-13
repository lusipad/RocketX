import { create } from 'zustand';
import type { RcPreferences } from '@rcx/rc-client';
import { rest } from '../lib/client';

/** RC 用户偏好：服务端持久化，跨设备同步 */
interface PrefsState {
  prefs: RcPreferences;
  loaded: boolean;
  load: () => Promise<void>;
  /** 乐观更新 + 同步到服务端 */
  update: (patch: Partial<RcPreferences>) => Promise<void>;
}

const DEFAULTS: RcPreferences = {
  sidebarGroupByType: true,
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
};

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: DEFAULTS,
  loaded: false,

  load: async () => {
    try {
      const prefs = await rest.getPreferences();
      set({ prefs: { ...DEFAULTS, ...prefs }, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  update: async (patch) => {
    const prev = get().prefs;
    set({ prefs: { ...prev, ...patch } });
    try {
      await rest.setPreferences(patch);
    } catch {
      set({ prefs: prev }); // 失败回滚
    }
  },
}));

// 调试用：控制台可查 window.__prefs
if (typeof window !== 'undefined') {
  (window as unknown as { __prefs?: typeof usePrefs }).__prefs = usePrefs;
}
