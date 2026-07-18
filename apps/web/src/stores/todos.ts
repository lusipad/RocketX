import { create } from 'zustand';

/**
 * 待办（TODO）。
 *
 * Rocket.Chat 只有「星标消息」，没有描述和截止日期，所以待办存在本机。
 * 从消息标记的待办锚定一条消息（rid + mid），点开能跳回原始上下文；
 * 手动新建的待办（issue #64）没有来源消息，note 就是它的全部内容。
 */
export interface Todo {
  id: string;
  /** 来源消息；手动新建的待办没有 */
  rid?: string;
  mid?: string;
  /** 来源会话名与消息摘要，做成快照——原会话被隐藏了待办也还能看懂 */
  roomName?: string;
  excerpt?: string;
  /** 消息作者 */
  author?: string;
  /** 自己补充的说明；手动待办的正文 */
  note?: string;
  /** 截止日期，YYYY-MM-DD */
  due?: string;
  done: boolean;
  createdAt: number;
  doneAt?: number;
}

const KEY = 'rcx-todos';

function load(): Todo[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Todo[];
  } catch {
    return [];
  }
}

function persist(todos: Todo[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(todos));
  } catch {
    /* 存储满 */
  }
}

/** 今天（本地时区）的 YYYY-MM-DD */
export function todayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 逾期：有截止日且早于今天，且没做完 */
export function isOverdue(t: Todo, today = todayKey()): boolean {
  return !t.done && !!t.due && t.due < today;
}

/** 截止日期的人话：今天 / 明天 / 逾期 N 天 / M月D日 */
export function dueLabel(due: string, today = todayKey()): string {
  if (due === today) return '今天到期';
  const dueMs = new Date(`${due}T00:00:00`).getTime();
  const todayMs = new Date(`${today}T00:00:00`).getTime();
  const days = Math.round((dueMs - todayMs) / 86400000);
  if (days === 1) return '明天到期';
  if (days < 0) return `已逾期 ${-days} 天`;
  if (days <= 7) return `${days} 天后到期`;
  const d = new Date(dueMs);
  return `${d.getMonth() + 1}月${d.getDate()}日到期`;
}

interface TodoState {
  todos: Todo[];
  add: (t: Omit<Todo, 'id' | 'done' | 'createdAt'>) => string;
  update: (id: string, patch: Partial<Pick<Todo, 'note' | 'due'>>) => void;
  toggle: (id: string) => void;
  remove: (id: string) => void;
  /** 某条消息是否已经在待办里（消息上显示标记） */
  hasMessage: (mid: string) => boolean;
  /** 清掉所有已完成 */
  clearDone: () => void;
}

export const useTodos = create<TodoState>((set, get) => ({
  todos: load(),

  add: (t) => {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const todos = [{ ...t, id, done: false, createdAt: Date.now() }, ...get().todos];
    set({ todos });
    persist(todos);
    return id;
  },

  update: (id, patch) => {
    const todos = get().todos.map((t) => (t.id === id ? { ...t, ...patch } : t));
    set({ todos });
    persist(todos);
  },

  toggle: (id) => {
    const todos = get().todos.map((t) =>
      t.id === id ? { ...t, done: !t.done, doneAt: !t.done ? Date.now() : undefined } : t,
    );
    set({ todos });
    persist(todos);
  },

  remove: (id) => {
    const todos = get().todos.filter((t) => t.id !== id);
    set({ todos });
    persist(todos);
  },

  hasMessage: (mid) => get().todos.some((t) => t.mid === mid && !t.done),

  clearDone: () => {
    const todos = get().todos.filter((t) => !t.done);
    set({ todos });
    persist(todos);
  },
}));
