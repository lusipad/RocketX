import { useChat } from '../stores/chat';
import { useTodos, type Todo } from '../stores/todos';
import { turnButlerBriefItemIntoTodo, type ButlerBriefActionResult } from './butlerBriefActions';
import type { ButlerConclusion } from './butlerConclusions';
import { createButlerToolCheckpoint, type ButlerToolCheckpoint } from './butlerToolRuntime';

type NewTodo = Omit<Todo, 'id' | 'done' | 'createdAt'>;
type TodoPatch = Partial<Pick<Todo, 'note' | 'due' | 'committedTo' | 'waitingFor'>>;

export interface ConclusionTodoState {
  todos: Todo[];
  add(todo: NewTodo): string;
  update(id: string, patch: TodoPatch): void;
}

export interface ConclusionActionContext {
  todoState?: ConclusionTodoState;
}

export type ConclusionWatchResult =
  | 'created'
  | 'updated'
  | 'already-watching'
  | 'needs-who'
  | 'conflict'
  | 'unsupported';

/**
 * 房间名取自订阅表而不是切 label 字符串——房间名或人名里含 `·`/`：` 时
 * 切分会把快照写坏（label 只是给人看的展示串，不是结构化字段）。
 */
function roomNameOf(rid: string): string {
  const chat = useChat.getState();
  return chat.subscriptions[rid]?.fname
    || chat.subscriptions[rid]?.name
    || chat.rooms[rid]?.fname
    || chat.rooms[rid]?.name
    || '会话';
}

export function turnConclusionIntoTodo(
  conclusion: ButlerConclusion,
  context: ConclusionActionContext = {},
): ButlerBriefActionResult {
  if (!conclusion.can.todo || !conclusion.source) return 'unsupported';
  const todoState = context.todoState ?? useTodos.getState();
  const source = conclusion.source;
  // pr:/build: 走 turnButlerBriefItemIntoTodo 会命中它那条「无去重」分支，
  // 连点必然重复建条；这里直接不支持（施工图 §4.4）。
  if (conclusion.ref.startsWith('pr:') || conclusion.ref.startsWith('build:')) return 'unsupported';
  return turnButlerBriefItemIntoTodo(conclusion.ref, conclusion.plain, {
    todoState,
    ...(source.kind === 'message' && source.rid
      ? {
          message: {
            ref: conclusion.ref,
            rid: source.rid,
            roomName: roomNameOf(source.rid),
            text: conclusion.plain,
          },
        }
      : {}),
  });
}

/**
 * 「盯它」：把这条结论记进等待台账。
 *
 * `waitingFor` 与 `committedTo` 互斥——同时写会在 ledger 里冒出一条多余的承诺条。
 */
export function watchConclusion(
  conclusion: ButlerConclusion,
  input: { who: string; due?: string },
  context: ConclusionActionContext = {},
): ConclusionWatchResult {
  const rid = conclusion.source?.rid;
  const mid = conclusion.source?.mid;
  if (!conclusion.can.watch || !rid || !mid) return 'unsupported';
  const who = input.who.trim();
  if (!who) return 'needs-who';
  const due = input.due?.trim();
  const todoState = context.todoState ?? useTodos.getState();
  const existing = todoState.todos.find((todo) => todo.mid === mid && !todo.done);
  if (existing) {
    // 用户自己记过「我答应给谁」：waitingFor 与 committedTo 互斥，
    // 静默改写会把他的承诺变成等待，还会在台账里长出两条。交给用户自己决定。
    if (existing.committedTo) return 'conflict';
    if (existing.waitingFor === who && (existing.due ?? '') === (due ?? '')) return 'already-watching';
    todoState.update(existing.id, { waitingFor: who, ...(due ? { due } : {}) });
    return 'updated';
  }
  todoState.add({
    source: 'message',
    title: conclusion.plain,
    rid,
    mid,
    roomName: roomNameOf(rid),
    excerpt: conclusion.plain,
    waitingFor: who,
    ...(due ? { due } : {}),
  });
  return 'created';
}

/**
 * 一键动作的审批 checkpoint。
 *
 * 幂等键**不含结论文本**：换个措辞不应绕过去重（这是「反馈按标题归并」在
 * 问答结论上会失效的正解）。`who` 进 wait 键，否则改「等谁」会被
 * executeApprovedButlerOperation 的 completed 短路吃掉。
 */
export function createConclusionCheckpoint(
  conclusion: ButlerConclusion,
  action: 'todo' | 'wait',
  who?: string,
  now?: number,
  due?: string,
): ButlerToolCheckpoint {
  // due 必须进键：否则「同一人换个截止日期」会被 completed 短路吃掉，
  // 用户看到成功提示，日期却一个字没写进去。
  const idempotencyKey = action === 'wait'
    ? `butler-conclusion:wait:${conclusion.ref}:${who?.trim() ?? ''}:${due?.trim() ?? ''}`
    : `butler-conclusion:todo:${conclusion.ref}`;
  return createButlerToolCheckpoint({
    toolName: action === 'wait' ? 'conclusion.wait' : 'conclusion.todo',
    effect: 'write',
    capability: 'todos.write',
    idempotencyKey,
    status: 'approval-required',
    params: {
      ref: conclusion.ref,
      ...(who?.trim() ? { who: who.trim() } : {}),
      ...(due?.trim() ? { due: due.trim() } : {}),
    },
    preview: action === 'wait'
      ? `盯它：${conclusion.label}${who?.trim() ? `（等 ${who.trim()}）` : ''}`
      : `记为待办：${conclusion.label}`,
    ...(now === undefined ? {} : { now }),
  });
}
