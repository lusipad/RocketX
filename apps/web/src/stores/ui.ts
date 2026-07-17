import { create } from 'zustand';

export type ModuleKey = string;

/** 内置模块顺序；运行时快捷键会把注册的 nav.module 插在 settings 之前。 */
export const MODULE_ORDER: ModuleKey[] = [
  'messages',
  'today',
  'codex',
  'ai-assistant',
  'todos',
  'calendar',
  'contacts',
  'workbench',
  'settings',
];

let moduleValidator = (module: ModuleKey) => MODULE_ORDER.includes(module);

export function installModuleValidator(validator: (module: ModuleKey) => boolean): void {
  moduleValidator = validator;
}

/** 工作台内部的子标签（提到全局状态，切走再回来才能停在原来那页） */
export type WorkbenchTab = 'overview' | 'workitems' | 'prs' | 'builds' | `query:${string}`;

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
  | 'discussions'
  | 'hidden';

interface UIState {
  module: ModuleKey;
  convFilter: ConvFilter;
  /** 选中的自定义分组 id（非空时覆盖 convFilter） */
  activeFolder: string | null;
  /** 未读会话打开后暂留在列表，切到下一条时再移除，避免列表当场跳动。 */
  retainedUnreadRid: string | null;
  switcherOpen: boolean;
  switcherCommandCenter: boolean;
  /** 工作台当前子标签（切模块后保持，不重置回概览） */
  workbenchTab: WorkbenchTab;
  /** 「我的工作项」的状态筛选（切页/切模块后保持，issue #17.1） */
  workItemStateFilter: string;
  /** 拉取请求页的子 tab（待我评审/我提的），同样切走保持 */
  prTab: 'review' | 'mine';
  /** 构建页「只看失败」开关，切走保持 */
  buildsFailedOnly: boolean;
  setModule: (m: ModuleKey) => void;
  setConvFilter: (f: ConvFilter) => void;
  setActiveFolder: (id: string | null) => void;
  retainUnread: (rid: string | null) => void;
  setSwitcherOpen: (open: boolean) => void;
  openCommandCenter: () => void;
  setWorkbenchTab: (t: WorkbenchTab) => void;
  setWorkItemStateFilter: (s: string) => void;
  setPrTab: (t: 'review' | 'mine') => void;
  setBuildsFailedOnly: (v: boolean) => void;
}

export const useUI = create<UIState>((set) => ({
  module: 'messages',
  convFilter: 'all',
  activeFolder: null,
  retainedUnreadRid: null,
  switcherOpen: false,
  switcherCommandCenter: false,
  workbenchTab: 'overview',
  workItemStateFilter: '全部',
  prTab: 'review',
  buildsFailedOnly: false,
  setModule: (m) => {
    if (moduleValidator(m)) set({ module: m });
  },
  setConvFilter: (f) =>
    set({
      convFilter: f,
      activeFolder: null,
      ...(f === 'unread' ? {} : { retainedUnreadRid: null }),
    }),
  setActiveFolder: (id) => set({ activeFolder: id, retainedUnreadRid: null }),
  retainUnread: (rid) => set({ retainedUnreadRid: rid }),
  setSwitcherOpen: (open) =>
    set({ switcherOpen: open, ...(open ? {} : { switcherCommandCenter: false }) }),
  openCommandCenter: () => set({ switcherOpen: true, switcherCommandCenter: true }),
  setWorkbenchTab: (t) => set({ workbenchTab: t }),
  setWorkItemStateFilter: (s) => set({ workItemStateFilter: s }),
  setPrTab: (t) => set({ prTab: t }),
  setBuildsFailedOnly: (v) => set({ buildsFailedOnly: v }),
}));
