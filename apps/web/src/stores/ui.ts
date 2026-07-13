import { create } from 'zustand';

export type ModuleKey =
  | 'messages'
  | 'contacts'
  | 'docs'
  | 'calendar'
  | 'meetings'
  | 'workbench'
  | 'settings';

/** 会话列表分组过滤（飞书「分组」栏） */
export type ConvFilter =
  | 'all'
  | 'unread'
  | 'mentions'
  | 'favorites'
  | 'dm'
  | 'groups'
  | 'teams'
  | 'discussions';

interface UIState {
  module: ModuleKey;
  convFilter: ConvFilter;
  /** 选中的自定义分组 id（非空时覆盖 convFilter） */
  activeFolder: string | null;
  switcherOpen: boolean;
  setModule: (m: ModuleKey) => void;
  setConvFilter: (f: ConvFilter) => void;
  setActiveFolder: (id: string | null) => void;
  setSwitcherOpen: (open: boolean) => void;
}

export const useUI = create<UIState>((set) => ({
  module: 'messages',
  convFilter: 'all',
  activeFolder: null,
  switcherOpen: false,
  setModule: (m) => set({ module: m }),
  setConvFilter: (f) => set({ convFilter: f, activeFolder: null }),
  setActiveFolder: (id) => set({ activeFolder: id }),
  setSwitcherOpen: (open) => set({ switcherOpen: open }),
}));
