import { create } from 'zustand';

export type ModuleKey =
  | 'messages'
  | 'todos'
  | 'contacts'
  | 'calendar'
  | 'workbench'
  | 'settings';

/** 工作台内部的子标签（提到全局状态，切走再回来才能停在原来那页） */
export type WorkbenchTab = 'overview' | 'workitems' | 'prs' | 'builds';

/** 会话列表分组过滤（飞书「分组」栏） */
export type ConvFilter =
  | 'all'
  | 'unread'
  | 'mentions'
  | 'favorites'
  | 'dm'
  /** 多人聊天：没有名字、由参与者拼出来的直聊（RC 里 t 仍是 'd'） */
  | 'multi'
  | 'groups'
  | 'teams'
  | 'discussions';

interface UIState {
  module: ModuleKey;
  convFilter: ConvFilter;
  /** 选中的自定义分组 id（非空时覆盖 convFilter） */
  activeFolder: string | null;
  switcherOpen: boolean;
  /** 工作台当前子标签（切模块后保持，不重置回概览） */
  workbenchTab: WorkbenchTab;
  /** 「我的工作项」的状态筛选（切页/切模块后保持，issue #17.1） */
  workItemStateFilter: string;
  setModule: (m: ModuleKey) => void;
  setConvFilter: (f: ConvFilter) => void;
  setActiveFolder: (id: string | null) => void;
  setSwitcherOpen: (open: boolean) => void;
  setWorkbenchTab: (t: WorkbenchTab) => void;
  setWorkItemStateFilter: (s: string) => void;
}

export const useUI = create<UIState>((set) => ({
  module: 'messages',
  convFilter: 'all',
  activeFolder: null,
  switcherOpen: false,
  workbenchTab: 'overview',
  workItemStateFilter: '全部',
  setModule: (m) => set({ module: m }),
  setConvFilter: (f) => set({ convFilter: f, activeFolder: null }),
  setActiveFolder: (id) => set({ activeFolder: id }),
  setSwitcherOpen: (open) => set({ switcherOpen: open }),
  setWorkbenchTab: (t) => set({ workbenchTab: t }),
  setWorkItemStateFilter: (s) => set({ workItemStateFilter: s }),
}));
