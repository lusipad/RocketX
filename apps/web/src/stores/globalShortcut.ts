import { create } from 'zustand';
import {
  GLOBAL_SHORTCUT_STORAGE_KEY,
  defaultGlobalShortcutConfig,
  parseGlobalShortcutConfig,
  type GlobalShortcutConfigV1,
  type GlobalShortcutValue,
} from '../lib/globalShortcut';

export type GlobalShortcutStatus =
  | 'unsupported'
  | 'disabled'
  | 'registering'
  | 'registered'
  | 'conflict';

interface GlobalShortcutStore {
  config: GlobalShortcutConfigV1;
  status: GlobalShortcutStatus;
  error: string | null;
  setEnabled: (enabled: boolean) => void;
  setShortcut: (shortcut: GlobalShortcutValue) => void;
  setRuntimeStatus: (status: GlobalShortcutStatus, error?: string | null) => void;
}

function loadConfig(): GlobalShortcutConfigV1 {
  try {
    return parseGlobalShortcutConfig(localStorage.getItem(GLOBAL_SHORTCUT_STORAGE_KEY));
  } catch {
    return defaultGlobalShortcutConfig();
  }
}

function persist(config: GlobalShortcutConfigV1): void {
  try {
    localStorage.setItem(GLOBAL_SHORTCUT_STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* 本机存储不可用时仅保留当前运行期配置 */
  }
}

export const useGlobalShortcut = create<GlobalShortcutStore>((set, get) => ({
  config: loadConfig(),
  status: 'unsupported',
  error: null,

  setEnabled: (enabled) => {
    const config = { ...get().config, enabled };
    persist(config);
    set({ config });
  },

  setShortcut: (shortcut) => {
    const config = { ...get().config, shortcut };
    persist(config);
    set({ config });
  },

  setRuntimeStatus: (status, error = null) => set({ status, error }),
}));
