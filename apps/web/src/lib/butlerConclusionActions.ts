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
  | 'unsupported';

/** label 形如 `房间 · 发言人：正文` */
function roomOf(label: string | undefined): string {
  const room = label?.split('·')[0]?.trim();
  return room || '会话';
}

function bodyOf(label: string | undefined): string {
  const index = label?.indexOf('：') ?? -1;
  const body = index >= 0 ? label!.slice(index + 1).trim() : label?.trim();
  return body || '';
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
  return turnButlerBriefItemIntoTodo(conclusion.ref, conclusion.text, {
    todoState,
    ...(source.kind === 'message' && source.rid
      ? {
          message: {
            ref: conclusion.ref,
            rid: source.rid,
            roomName: roomOf(source.label),
            text: bodyOf(source.label),
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
  if (!conclusion.can.watch || !conclusion.source?.rid || !conclusion.source.mid) return 'unsupported';
  const who = input.who.trim();
  if (!who) return 'needs-who';
  const due = input.due?.trim();
  const todoState = context.todoState ?? useTodos.getState();
  const source = conclusion.source;
  const existing = todoState.todos.find((todo) => todo.mid === source.mid && !todo.done);
  if (existing) {
    if (existing.waitingFor === who) return 'already-watching';
    todoState.update(existing.id, { waitingFor: who, ...(due ? { due } : {}) });
    return 'updated';
  }
  todoState.add({
    source: 'message',
    title: conclusion.text,
    rid: source.rid,
    mid: source.mid,
    roomName: roomOf(source.label),
    excerpt: bodyOf(source.label),
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
): ButlerToolCheckpoint {
  const idempotencyKey = action === 'wait'
    ? `butler-conclusion:wait:${conclusion.ref}:${who?.trim() ?? ''}`
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
    },
    preview: action === 'wait'
      ? `盯它：${conclusion.label}${who?.trim() ? `（等 ${who.trim()}）` : ''}`
      : `记为待办：${conclusion.label}`,
    ...(now === undefined ? {} : { now }),
  });
}
