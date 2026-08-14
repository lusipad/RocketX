import { create } from 'zustand';
import type { ButlerWorkspaceView } from '../lib/butlerWorkspace';
import { runtimeFeatures } from '../lib/runtimeMode';

export type ModuleKey = string;
export type ButlerTaskProvider = 'codex' | 'deepseek';

/** 内置模块顺序；运行时快捷键会把注册的 nav.module 插在 settings 之前。 */
export const MODULE_ORDER: ModuleKey[] = [
  'messages',
  'workbench',
  'butler-view',
  'todos',
  'calendar',
  'downloads',
  'contacts',
  'settings',
];

export const UI_MODULE_STORAGE_KEY = 'rcx-ui';
export const BUTLER_TASK_PROVIDER_STORAGE_KEY = 'rocketx.butler.task-provider';
export const DEFAULT_WORK_ITEM_STATE_FILTER = '__default_hide_shelved__';

/** 工作台内部的子标签（提到全局状态，切走再回来才能停在原来那页） */
export type WorkbenchTab = 'overview' | 'workitems' | 'contributions' | 'prs' | 'builds' | `query:${string}`;

interface ModuleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ModuleStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function readPersistedUIValue(storage: ModuleStorage | undefined = browserStorage()): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(UI_MODULE_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  } catch {
    return null;
  }
}

export function migratePersistedModule(value: unknown): ModuleKey {
  if (value === 'contributions') return 'workbench';
  return typeof value === 'string' && MODULE_ORDER.includes(value) ? value : 'messages';
}

function persistedModuleValue(parsed: unknown): unknown {
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  const state = record?.state && typeof record.state === 'object'
    ? record.state as Record<string, unknown>
    : undefined;
  return record?.module ?? state?.module ?? parsed;
}

export function readPersistedModule(storage: ModuleStorage | undefined = browserStorage()): ModuleKey {
  if (!storage) return 'messages';
  try {
    const parsed = readPersistedUIValue(storage);
    const module = migratePersistedModule(persistedModuleValue(parsed));
    return !runtimeFeatures().ai && module === 'butler-view' ? 'messages' : module;
  } catch {
    return 'messages';
  }
}

export function readPersistedWorkbenchTab(
  storage: ModuleStorage | undefined = browserStorage(),
): WorkbenchTab {
  return persistedModuleValue(readPersistedUIValue(storage)) === 'contributions'
    ? 'contributions'
    : 'overview';
}

export function readPersistedButlerTaskProvider(
  storage: ModuleStorage | undefined = browserStorage(),
): ButlerTaskProvider {
  try {
    return storage?.getItem(BUTLER_TASK_PROVIDER_STORAGE_KEY) === 'codex' ? 'codex' : 'deepseek';
  } catch {
    return 'deepseek';
  }
}

function persistButlerTaskProvider(provider: ButlerTaskProvider): void {
  try {
    browserStorage()?.setItem(BUTLER_TASK_PROVIDER_STORAGE_KEY, provider);
  } catch {
    // 浏览器禁用存储时仍保留本次会话选择。
  }
}

export function readPersistedWorkItemStateFilter(
  storage: ModuleStorage | undefined = browserStorage(),
): string {
  if (!storage) return DEFAULT_WORK_ITEM_STATE_FILTER;
  try {
    const parsed = readPersistedUIValue(storage);
    const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
    const state = record?.state && typeof record.state === 'object'
      ? record.state as Record<string, unknown>
      : undefined;
    const value = record?.workItemStateFilter ?? state?.workItemStateFilter;
    return typeof value === 'string' && value ? value : DEFAULT_WORK_ITEM_STATE_FILTER;
  } catch {
    return DEFAULT_WORK_ITEM_STATE_FILTER;
  }
}

function persistUIState(patch: { module?: ModuleKey; workItemStateFilter?: string }): void {
  try {
    const storage = browserStorage();
    if (!storage) return;
    storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({
      module: patch.module ?? readPersistedModule(storage),
      workItemStateFilter: patch.workItemStateFilter ?? readPersistedWorkItemStateFilter(storage),
    }));
  } catch {
    // 浏览器禁用存储时保持内存态即可。
  }
}

let moduleValidator = (module: ModuleKey) => MODULE_ORDER.includes(module);

export function installModuleValidator(validator: (module: ModuleKey) => boolean): void {
  moduleValidator = validator;
}

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
  /** Codex 工作区的一级视图。 */
  butlerView: ButlerWorkspaceView;
  /** 当前任务执行视图；只有用户主动切换时才持久化。 */
  butlerTaskProvider: ButlerTaskProvider;
  /** 用户显式选择的默认执行视图；临时 handoff 不改它。 */
  butlerTaskProviderPreference: ButlerTaskProvider;
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
  openButlerConversation: (provider?: ButlerTaskProvider) => void;
  setButlerTaskProvider: (provider: ButlerTaskProvider) => void;
  setButlerView: (view: ButlerWorkspaceView) => void;
  setWorkbenchTab: (t: WorkbenchTab) => void;
  setWorkItemStateFilter: (s: string) => void;
  setPrTab: (t: 'review' | 'mine') => void;
  setBuildsFailedOnly: (v: boolean) => void;
}

export const useUI = create<UIState>((set) => ({
  module: readPersistedModule(),
  convFilter: 'all',
  activeFolder: null,
  retainedUnreadRid: null,
  switcherOpen: false,
  switcherCommandCenter: false,
  butlerView: 'conversation',
  butlerTaskProvider: readPersistedButlerTaskProvider(),
  butlerTaskProviderPreference: readPersistedButlerTaskProvider(),
  workbenchTab: readPersistedWorkbenchTab(),
  workItemStateFilter: readPersistedWorkItemStateFilter(),
  prTab: 'review',
  buildsFailedOnly: false,
  setModule: (m) => {
    if (moduleValidator(m)) {
      persistUIState({ module: m });
      set((state) => m === 'butler-view'
        ? {
            module: m,
            butlerView: 'conversation',
            butlerTaskProvider: state.butlerTaskProviderPreference,
          }
        : { module: m });
    }
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
  setButlerTaskProvider: (provider) => {
    persistButlerTaskProvider(provider);
    set({
      butlerTaskProvider: provider,
      butlerTaskProviderPreference: provider,
    });
  },
  openButlerConversation: (provider) => {
    if (!runtimeFeatures().butler) return;
    persistUIState({ module: 'butler-view' });
    set((state) => ({
      module: 'butler-view',
      butlerView: 'conversation',
      butlerTaskProvider: provider ?? state.butlerTaskProviderPreference,
    }));
  },
  setButlerView: (view) => {
    if (!runtimeFeatures().butler) return;
    persistUIState({ module: 'butler-view' });
    set({
      module: 'butler-view',
      butlerView: view,
    });
  },
  setWorkbenchTab: (t) => set({ workbenchTab: t }),
  setWorkItemStateFilter: (s) => {
    persistUIState({ workItemStateFilter: s });
    set({ workItemStateFilter: s });
  },
  setPrTab: (t) => set({ prTab: t }),
  setBuildsFailedOnly: (v) => set({ buildsFailedOnly: v }),
}));
