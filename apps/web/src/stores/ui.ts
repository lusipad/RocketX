import { create } from 'zustand';

export type ModuleKey = 'messages' | 'contacts' | 'docs' | 'calendar' | 'meetings' | 'workbench';

/** 会话列表分组过滤（飞书「分组」栏） */
export type ConvFilter = 'all' | 'unread' | 'mentions' | 'dm' | 'groups';
/** 会话排序：按时间 / 未读优先 */
export type ConvSort = 'time' | 'unread';

const SORT_KEY = 'rcx-conv-sort';

interface UIState {
  module: ModuleKey;
  convFilter: ConvFilter;
  convSort: ConvSort;
  switcherOpen: boolean;
  setModule: (m: ModuleKey) => void;
  setConvFilter: (f: ConvFilter) => void;
  setConvSort: (s: ConvSort) => void;
  setSwitcherOpen: (open: boolean) => void;
}

export const useUI = create<UIState>((set) => ({
  module: 'messages',
  convFilter: 'all',
  convSort: (localStorage.getItem(SORT_KEY) as ConvSort) || 'time',
  switcherOpen: false,
  setModule: (m) => set({ module: m }),
  setConvFilter: (f) => set({ convFilter: f }),
  setConvSort: (s) => {
    localStorage.setItem(SORT_KEY, s);
    set({ convSort: s });
  },
  setSwitcherOpen: (open) => set({ switcherOpen: open }),
}));
