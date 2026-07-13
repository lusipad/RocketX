import { create } from 'zustand';

/**
 * 自定义分组（会话文件夹）。
 * Rocket.Chat 没有这个数据模型，存在本地（跨设备不同步）。
 * 一个会话可以属于多个分组。
 */
export interface Folder {
  id: string;
  name: string;
  /** 会话 rid 列表（顺序即显示顺序） */
  rids: string[];
}

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
