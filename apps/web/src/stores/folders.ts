import { create } from 'zustand';

/**
 * 自定义分组（会话文件夹）。
 * Rocket.Chat 没有这个数据模型，存在本地（跨设备不同步）。
 * 一个会话可以属于多个分组。
 */
/** 规则匹配方式 */
export type RuleMode = 'prefix' | 'contains' | 'regex';

export interface FolderRule {
  mode: RuleMode;
  /** 匹配串（prefix/contains 不区分大小写；regex 为正则源码） */
  value: string;
}

export interface Folder {
  id: string;
  name: string;
  /** 手工拖进来的会话 rid（顺序即显示顺序） */
  rids: string[];
  /**
   * 规则：命中会话名的自动进组，和手工拖入并存。
   * 典型用法：前缀 WI —— 所有「WI-1234 xxx」的会话自动归到一组。
   */
  rules?: FolderRule[];
}

/** 会话名是否命中某条规则 */
export function ruleMatches(rule: FolderRule, name: string): boolean {
  const v = rule.value.trim();
  if (!v) return false;
  if (rule.mode === 'regex') {
    try {
      return new RegExp(v, 'i').test(name);
    } catch {
      // 正则写错了不能让整个列表炸掉，当作不匹配
      return false;
    }
  }
  const lower = name.toLowerCase();
  const needle = v.toLowerCase();
  return rule.mode === 'prefix' ? lower.startsWith(needle) : lower.includes(needle);
}

/** 会话是否属于该分组：手工加入 或 命中任一规则 */
export function inFolder(folder: Folder, conv: { rid: string; name: string }): boolean {
  if (folder.rids.includes(conv.rid)) return true;
  return (folder.rules ?? []).some((r) => ruleMatches(r, conv.name));
}

export const RULE_LABELS: Record<RuleMode, string> = {
  prefix: '名称以…开头',
  contains: '名称包含…',
  regex: '正则匹配',
};

const KEY = 'rcx-folders';
const COLLAPSE_KEY = 'rcx-collapsed';

function load(): Folder[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Folder[]) : [];
  } catch {
    return [];
  }
}

function persist(folders: Folder[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(folders));
  } catch {
    /* 存储满 */
  }
}

function loadCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

interface FoldersState {
  folders: Folder[];
  /** 折叠的分区/分组 key */
  collapsed: string[];
  create: (name: string) => string;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  /** 移动分组顺序 */
  move: (id: string, dir: -1 | 1) => void;
  /** 加入/移出会话 */
  addRoom: (folderId: string, rid: string) => void;
  removeRoom: (folderId: string, rid: string) => void;
  reorderRoom: (folderId: string, rid: string, beforeRid: string | null) => void;
  /**
   * 丢掉已经不存在的会话（退群、被移出、在别的端删了）。
   * 分组只存在本地，服务器不会通知我们某个 rid 没了，
   * 不清理的话分组计数会一直虚高，点进去却是空的。
   */
  prune: (validRids: Set<string>) => void;
  /** 整体替换某个分组的规则 */
  setRules: (folderId: string, rules: FolderRule[]) => void;
  /** 会话所属的分组 id 列表 */
  foldersOf: (rid: string) => string[];
  toggleCollapse: (key: string) => void;
  isCollapsed: (key: string) => boolean;
}

export const useFolders = create<FoldersState>((set, get) => ({
  folders: load(),
  collapsed: loadCollapsed(),

  create: (name) => {
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const folders = [...get().folders, { id, name: name.trim() || '新分组', rids: [] }];
    set({ folders });
    persist(folders);
    return id;
  },

  rename: (id, name) => {
    const folders = get().folders.map((f) =>
      f.id === id ? { ...f, name: name.trim() || f.name } : f,
    );
    set({ folders });
    persist(folders);
  },

  remove: (id) => {
    const folders = get().folders.filter((f) => f.id !== id);
    set({ folders });
    persist(folders);
  },

  move: (id, dir) => {
    const folders = [...get().folders];
    const i = folders.findIndex((f) => f.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= folders.length) return;
    [folders[i], folders[j]] = [folders[j], folders[i]];
    set({ folders });
    persist(folders);
  },

  addRoom: (folderId, rid) => {
    const folders = get().folders.map((f) =>
      f.id === folderId && !f.rids.includes(rid) ? { ...f, rids: [...f.rids, rid] } : f,
    );
    set({ folders });
    persist(folders);
  },

  removeRoom: (folderId, rid) => {
    const folders = get().folders.map((f) =>
      f.id === folderId ? { ...f, rids: f.rids.filter((r) => r !== rid) } : f,
    );
    set({ folders });
    persist(folders);
  },

  reorderRoom: (folderId, rid, beforeRid) => {
    const folders = get().folders.map((f) => {
      if (f.id !== folderId) return f;
      const rids = f.rids.filter((r) => r !== rid);
      if (!rids.includes(rid)) {
        // ensure rid is present
      }
      const idx = beforeRid ? rids.indexOf(beforeRid) : rids.length;
      rids.splice(idx >= 0 ? idx : rids.length, 0, rid);
      return { ...f, rids };
    });
    set({ folders });
    persist(folders);
  },

  setRules: (folderId, rules) => {
    const clean = rules.filter((r) => r.value.trim());
    const folders = get().folders.map((f) => (f.id === folderId ? { ...f, rules: clean } : f));
    set({ folders });
    persist(folders);
  },

  prune: (validRids) => {
    let changed = false;
    const folders = get().folders.map((f) => {
      const kept = f.rids.filter((r) => validRids.has(r));
      if (kept.length === f.rids.length) return f;
      changed = true;
      return { ...f, rids: kept };
    });
    if (!changed) return;
    set({ folders });
    persist(folders);
  },

  foldersOf: (rid) => get().folders.filter((f) => f.rids.includes(rid)).map((f) => f.id),

  toggleCollapse: (key) => {
    const collapsed = get().collapsed.includes(key)
      ? get().collapsed.filter((k) => k !== key)
      : [...get().collapsed, key];
    set({ collapsed });
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      /* ignore */
    }
  },

  isCollapsed: (key) => get().collapsed.includes(key),
}));
