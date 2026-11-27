import { create } from 'zustand';
import { getLocale, t, tp } from '../i18n';
import { formatDate } from '../i18n/format';
import { isTauri } from '../lib/http';
import { getLocalDataSchema, readLocalData, writeLocalData } from '../lib/localDataContract';
import { captureButlerAccountGeneration, subscribeButlerAccountSelection, waitForButlerAccountReady } from '../platform/butlerAccountReady';
import {
  addNativeTodo,
  deleteNativeTodo,
  listNativeTodos,
  migrateNativeTodos,
  updateNativeTodo,
  type NativeTodoRecord,
} from '../platform/desktopCommands';

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

type NativeTodo = NativeTodoRecord;

type NewTodo = Omit<Todo, 'id' | 'done' | 'createdAt'>;
type TodoUpdate = Partial<Pick<Todo, 'note' | 'due' | 'committedTo' | 'waitingFor'>>;

const KEY = 'rcx-todos';
const TODO_SCHEMA_VERSION = getLocalDataSchema('todo').version;
const pendingAdds = new Set<string>();
const desktopIds = new Map<string, string>();
let desktopReady: Promise<void> = Promise.resolve();
let desktopQueue: Promise<void> = Promise.resolve();

function load(): Todo[] {
  return readLocalData(KEY, TODO_SCHEMA_VERSION, [], (value) =>
    Array.isArray(value) ? value as Todo[] : undefined,
  );
}

function persist(todos: Todo[]): void {
  try {
    writeLocalData(KEY, TODO_SCHEMA_VERSION, todos);
  } catch {
    /* 存储满 */
  }
}

function legacyTodosForDesktop(): string | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) return raw;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'version' in value &&
      'data' in value &&
      (value as { version?: unknown }).version === TODO_SCHEMA_VERSION &&
      Array.isArray((value as { data?: unknown }).data)
    ) {
      return JSON.stringify((value as { data: Todo[] }).data);
    }
  } catch {
    // 损坏记录不应进入 SQLite 迁移；hydrate 会继续读取已有数据库。
  }
  return null;
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
  if (todo.mid) return todo.excerpt || todo.note || t('pages.todos.defaultTitle');
  return todo.note || todo.excerpt || t('pages.todos.defaultTitle');
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
  if ('committedTo' in patch) result.committedTo = patch.committedTo ?? null;
  if ('waitingFor' in patch) result.waitingFor = patch.waitingFor ?? null;
  return result;
}

function resolveDesktopId(id: string): string {
  return desktopIds.get(id) ?? id;
}

/**
 * 最近一次入队任务的结果（未吞异常的那一份）。
 *
 * 不用「全局错误闩」：那样别处的落盘失败会被下一个调用方认领，
 * 成功的动作报失败、失败的动作报成功。调用方在自己 add/update 之后
 * 立刻取走这个 promise，拿到的就是自己那次写入的结果。
 */
let lastEnqueued: Promise<void> = Promise.resolve();

function enqueueDesktop(task: (assertAccount: () => void) => Promise<void>): void {
  const assertAccount = captureButlerAccountGeneration();
  const admittedReady = desktopReady;
  const run = desktopQueue.then(async () => {
    await admittedReady;
    await waitForButlerAccountReady();
    assertAccount();
    await task(assertAccount);
    assertAccount();
  });
  // 队列本身要活下去，所以吞掉异常；lastEnqueued 保留原始 promise 供调用方 await
  desktopQueue = run.catch((error) => {
    console.warn('[Todos] SQLite 操作失败', error);
  });
  lastEnqueued = run;
  void run.catch(() => undefined);
}

/**
 * 等待「刚刚那次」落盘完成；失败时抛出。
 *
 * 一键动作比确认卡更容易连点，必须 await 到真实结果——
 * 否则会出现「提示已放进等待台账、数据库里其实空白」。
 * 调用方必须在写操作**之内**调用它，让失败变成 checkpoint 的失败。
 */
export function awaitLastTodoWrite(): Promise<void> {
  return lastEnqueued;
}

/** Await the selected account's initial migration and read before consuming its todos. */
export async function awaitTodoAccountReady(): Promise<void> {
  if (!isTauri) return;
  const assertAccount = captureButlerAccountGeneration();
  await desktopReady;
  await waitForButlerAccountReady();
  assertAccount();
}

/** 今天（本地时区）的 YYYY-MM-DD */
export function todayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 逾期：有截止日且早于今天，且没做完 */
export function isOverdue(todo: Todo, today = todayKey()): boolean {
  return !todo.done && !!todo.due && todo.due < today;
}

/** 截止日期的人话：今天 / 明天 / 逾期 N 天 / M月D日 */
export function dueLabel(due: string, today = todayKey()): string {
  const locale = getLocale();
  if (due === today) return t('pages.todos.due.today', undefined, locale);
  const dueMs = new Date(`${due}T00:00:00`).getTime();
  const todayMs = new Date(`${today}T00:00:00`).getTime();
  const days = Math.round((dueMs - todayMs) / 86400000);
  if (days === 1) return t('pages.todos.due.tomorrow', undefined, locale);
  if (days < 0) return tp(-days, 'pages.todos.due.overdueOne', 'pages.todos.due.overdueOther', undefined, locale);
  if (days <= 7) return tp(days, 'pages.todos.due.inDaysOne', 'pages.todos.due.inDaysOther', undefined, locale);
  const d = new Date(dueMs);
  const dateText = formatDate(
    d,
    locale === 'zh-CN' ? { month: 'long', day: 'numeric' } : { month: 'short', day: 'numeric' },
    locale,
  );
  return t('pages.todos.due.onDate', { date: dateText }, locale);
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
  todos: isTauri ? [] : load(),

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
    enqueueDesktop(async (assertAccount) => {
      try {
        const saved = fromNative(
          await addNativeTodo(toNativeNewTodo(todo)),
        );
        assertAccount();
        desktopIds.set(id, saved.id);
        set((state) => ({
          todos: state.todos.map((item) => (item.id === id ? saved : item)),
        }));
      } catch (error) {
        assertAccount();
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

    enqueueDesktop(async (assertAccount) => {
      const resolvedId = resolveDesktopId(id);
      try {
        const saved = fromNative(
          await updateNativeTodo(resolvedId, toNativePatch(patch)),
        );
        assertAccount();
        set((state) => ({
          todos: state.todos.map((todo) =>
            todo.id === id || todo.id === resolvedId ? saved : todo,
          ),
        }));
      } catch (error) {
        assertAccount();
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

    enqueueDesktop(async (assertAccount) => {
      const resolvedId = resolveDesktopId(id);
      try {
        const saved = fromNative(
          await updateNativeTodo(resolvedId, { done }),
        );
        assertAccount();
        set((state) => ({
          todos: state.todos.map((todo) =>
            todo.id === id || todo.id === resolvedId ? saved : todo,
          ),
        }));
      } catch (error) {
        assertAccount();
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

    enqueueDesktop(async (assertAccount) => {
      const resolvedId = resolveDesktopId(id);
      try {
        await deleteNativeTodo(resolvedId);
        assertAccount();
        desktopIds.delete(id);
      } catch (error) {
        assertAccount();
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

    enqueueDesktop(async (assertAccount) => {
      try {
        for (const todo of completed) {
          await deleteNativeTodo(resolveDesktopId(todo.id));
          assertAccount();
        }
      } finally {
        assertAccount();
        const stored = await listNativeTodos();
        assertAccount();
        set({ todos: stored.map(fromNative) });
      }
    });
  },
}));

async function hydrateDesktop(assertAccount: () => void): Promise<void> {
  await waitForButlerAccountReady();
  assertAccount();
  const legacyJson = legacyTodosForDesktop();
  if (legacyJson !== null) {
    try {
      await migrateNativeTodos(legacyJson);
      assertAccount();
      localStorage.removeItem(KEY);
    } catch (error) {
      assertAccount();
      console.warn('[Todos] 旧待办迁移失败，将在下次启动时重试', error);
    }
  }

  try {
    const stored = (await listNativeTodos()).map(fromNative);
    assertAccount();
    const pending = useTodos.getState().todos.filter((todo) => pendingAdds.has(todo.id));
    useTodos.setState({
      todos: [...pending, ...stored.filter((todo) => !pendingAdds.has(todo.id))],
    });
  } catch (error) {
    assertAccount();
    console.warn('[Todos] 无法从 SQLite 加载待办', error);
  }
}

if (isTauri) subscribeButlerAccountSelection(() => {
  pendingAdds.clear();
  desktopIds.clear();
  desktopQueue = Promise.resolve();
  lastEnqueued = Promise.resolve();
  useTodos.setState({ todos: [] });
  const assertAccount = captureButlerAccountGeneration();
  desktopReady = hydrateDesktop(assertAccount);
  void desktopReady.catch(() => undefined);
});
