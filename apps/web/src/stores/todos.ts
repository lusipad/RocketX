import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { isTauri } from '../lib/http';

/**
 * 待办（TODO）。
 *
 * Rocket.Chat 只有「星标消息」，没有描述和截止日期，所以待办存在本机。
 * 从消息标记的待办锚定一条消息（rid + mid），点开能跳回原始上下文；
 * 手动新建的待办（issue #64）没有来源消息，note 就是它的全部内容。
 */
export interface Todo {
  id: string;
  source?: 'manual' | 'message' | 'ado';
  /** 来源消息；手动新建的待办没有 */
  rid?: string;
  mid?: string;
  adoWorkItemId?: number;
  adoProject?: string;
  title?: string;
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
  priority?: number;
  createdAt: number;
  doneAt?: number;
  updatedAt?: number;
  committedTo?: string;
  waitingFor?: string;
}

interface NativeTodo {
  id: string;
  source: 'manual' | 'message' | 'ado';
  rid: string | null;
  mid: string | null;
  adoWorkItemId: number | null;
  adoProject: string | null;
  title: string;
  note: string | null;
  roomName: string | null;
  author: string | null;
  done: boolean;
  priority: number;
  due: string | null;
  createdAt: number;
  doneAt: number | null;
  updatedAt: number;
  committedTo: string | null;
  waitingFor: string | null;
}

type NewTodo = Omit<Todo, 'id' | 'done' | 'createdAt'>;
type TodoUpdate = Partial<Pick<Todo, 'note' | 'due'>>;

const KEY = 'rcx-todos';
const pendingAdds = new Set<string>();
const desktopIds = new Map<string, string>();
let desktopReady: Promise<void> = Promise.resolve();
let desktopQueue: Promise<void> = Promise.resolve();

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

function fromNative(todo: NativeTodo): Todo {
  return {
    id: todo.id,
    source: todo.source,
    rid: todo.rid ?? undefined,
    mid: todo.mid ?? undefined,
    adoWorkItemId: todo.adoWorkItemId ?? undefined,
    adoProject: todo.adoProject ?? undefined,
    title: todo.title,
    roomName: todo.roomName ?? undefined,
    excerpt: todo.source === 'message' ? todo.title : undefined,
    author: todo.author ?? undefined,
    note: todo.note ?? undefined,
    due: todo.due ?? undefined,
    done: todo.done,
    priority: todo.priority,
    createdAt: todo.createdAt,
    doneAt: todo.doneAt ?? undefined,
    updatedAt: todo.updatedAt,
    committedTo: todo.committedTo ?? undefined,
    waitingFor: todo.waitingFor ?? undefined,
  };
}

function todoTitle(todo: NewTodo): string {
  if (todo.title) return todo.title;
  if (todo.mid) return todo.excerpt || todo.note || '待办';
  return todo.note || todo.excerpt || '待办';
}

function toNativeNewTodo(todo: NewTodo): Record<string, unknown> {
  return {
    source:
      todo.source ?? (todo.adoWorkItemId !== undefined ? 'ado' : todo.mid ? 'message' : 'manual'),
    rid: todo.rid,
    mid: todo.mid,
    adoWorkItemId: todo.adoWorkItemId,
    adoProject: todo.adoProject,
    title: todoTitle(todo),
    note: todo.note,
    roomName: todo.roomName,
    author: todo.author,
    priority: todo.priority,
    due: todo.due,
    doneAt: todo.doneAt,
    committedTo: todo.committedTo,
    waitingFor: todo.waitingFor,
  };
}

function toNativePatch(patch: TodoUpdate): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if ('note' in patch) result.note = patch.note ?? null;
  if ('due' in patch) result.due = patch.due ?? null;
  return result;
}

function resolveDesktopId(id: string): string {
  return desktopIds.get(id) ?? id;
}

function enqueueDesktop(task: () => Promise<void>): void {
  desktopQueue = desktopQueue
    .then(async () => {
      await desktopReady;
      await task();
    })
    .catch((error) => {
      console.warn('[Todos] SQLite 操作失败', error);
    });
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
  add: (t: NewTodo) => string;
  update: (id: string, patch: TodoUpdate) => void;
  toggle: (id: string) => void;
  remove: (id: string) => void;
  /** 某条消息是否已经在待办里（消息上显示标记） */
  hasMessage: (mid: string) => boolean;
  /** 清掉所有已完成 */
  clearDone: () => void;
}

export const useTodos = create<TodoState>((set, get) => ({
  todos: load(),

  add: (todo) => {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const now = Date.now();
    if (!isTauri) {
      const todos = [{ ...todo, id, done: false, createdAt: now }, ...get().todos];
      set({ todos });
      persist(todos);
      return id;
    }

    const optimistic = {
      ...todo,
      id,
      source:
        todo.source ??
        (todo.adoWorkItemId !== undefined ? 'ado' : todo.mid ? 'message' : 'manual'),
      title: todoTitle(todo),
      done: false,
      createdAt: now,
      updatedAt: now,
    } satisfies Todo;
    const todos = [optimistic, ...get().todos];
    set({ todos });

    pendingAdds.add(id);
    enqueueDesktop(async () => {
      try {
        const saved = fromNative(
          await invoke<NativeTodo>('butler_todo_add', { todo: toNativeNewTodo(todo) }),
        );
        desktopIds.set(id, saved.id);
        set((state) => ({
          todos: state.todos.map((item) => (item.id === id ? saved : item)),
        }));
      } catch (error) {
        set((state) => ({ todos: state.todos.filter((item) => item.id !== id) }));
        throw error;
      } finally {
        pendingAdds.delete(id);
      }
    });
    return id;
  },

  update: (id, patch) => {
    const previous = get().todos.find((todo) => todo.id === id);
    const todos = get().todos.map((todo) => (todo.id === id ? { ...todo, ...patch } : todo));
    set({ todos });

    if (!isTauri) {
      persist(todos);
      return;
    }

    enqueueDesktop(async () => {
      const resolvedId = resolveDesktopId(id);
      try {
        const saved = fromNative(
          await invoke<NativeTodo>('butler_todo_update', {
            id: resolvedId,
            patch: toNativePatch(patch),
          }),
        );
        set((state) => ({
          todos: state.todos.map((todo) =>
            todo.id === id || todo.id === resolvedId ? saved : todo,
          ),
        }));
      } catch (error) {
        if (previous) {
          set((state) => ({
            todos: state.todos.map((todo) =>
              todo.id === id || todo.id === resolvedId ? previous : todo,
            ),
          }));
        }
        throw error;
      }
    });
  },

  toggle: (id) => {
    const previous = get().todos.find((todo) => todo.id === id);
    if (!previous) return;
    const done = !previous.done;
    const todos = get().todos.map((todo) =>
      todo.id === id ? { ...todo, done, doneAt: done ? Date.now() : undefined } : todo,
    );
    set({ todos });

    if (!isTauri) {
      persist(todos);
      return;
    }

    enqueueDesktop(async () => {
      const resolvedId = resolveDesktopId(id);
      try {
        const saved = fromNative(
          await invoke<NativeTodo>('butler_todo_update', {
            id: resolvedId,
            patch: { done },
          }),
        );
        set((state) => ({
          todos: state.todos.map((todo) =>
            todo.id === id || todo.id === resolvedId ? saved : todo,
          ),
        }));
      } catch (error) {
        set((state) => ({
          todos: state.todos.map((todo) =>
            todo.id === id || todo.id === resolvedId ? previous : todo,
          ),
        }));
        throw error;
      }
    });
  },

  remove: (id) => {
    const previous = get().todos.find((todo) => todo.id === id);
    const todos = get().todos.filter((todo) => todo.id !== id);
    set({ todos });

    if (!isTauri) {
      persist(todos);
      return;
    }

    enqueueDesktop(async () => {
      const resolvedId = resolveDesktopId(id);
      try {
        await invoke('butler_todo_delete', { id: resolvedId });
        desktopIds.delete(id);
      } catch (error) {
        if (previous) set((state) => ({ todos: [previous, ...state.todos] }));
        throw error;
      }
    });
  },

  hasMessage: (mid) => get().todos.some((todo) => todo.mid === mid && !todo.done),

  clearDone: () => {
    const completed = get().todos.filter((todo) => todo.done);
    const todos = get().todos.filter((todo) => !todo.done);
    set({ todos });

    if (!isTauri) {
      persist(todos);
      return;
    }

    enqueueDesktop(async () => {
      try {
        for (const todo of completed) {
          await invoke('butler_todo_delete', { id: resolveDesktopId(todo.id) });
        }
      } finally {
        const stored = await invoke<NativeTodo[]>('butler_todo_list', { filter: {} });
        set({ todos: stored.map(fromNative) });
      }
    });
  },
}));

async function hydrateDesktop(): Promise<void> {
  const legacyJson = localStorage.getItem(KEY);
  if (legacyJson !== null) {
    try {
      await invoke<number>('butler_todo_migrate_from_json', { json: legacyJson });
      localStorage.removeItem(KEY);
    } catch (error) {
      console.warn('[Todos] 旧待办迁移失败，将在下次启动时重试', error);
    }
  }

  try {
    const stored = (await invoke<NativeTodo[]>('butler_todo_list', { filter: {} })).map(fromNative);
    const pending = useTodos.getState().todos.filter((todo) => pendingAdds.has(todo.id));
    useTodos.setState({
      todos: [...pending, ...stored.filter((todo) => !pendingAdds.has(todo.id))],
    });
  } catch (error) {
    console.warn('[Todos] 无法从 SQLite 加载待办', error);
  }
}

if (isTauri) desktopReady = hydrateDesktop();
