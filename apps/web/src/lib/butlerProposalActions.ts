import type { RoundsProposal } from '../kernel/ai/features/butler-rounds';
import { todayKey, useTodos, type Todo } from '../stores/todos';
import { useWorkbench, type WorkItem } from '../stores/workbench';
import {
  markProposalHandled,
  type ButlerProposalHandledStorage,
  type RecentSentMessage,
} from './butlerOutbox';

type NewTodo = Omit<Todo, 'id' | 'done' | 'createdAt'>;
type TodoUpdate = Partial<Pick<Todo, 'note' | 'due' | 'committedTo' | 'waitingFor'>>;

export interface ButlerProposalTodoState {
  todos: Todo[];
  add(todo: NewTodo): string;
  update(id: string, patch: TodoUpdate): void;
  toggle(id: string): void;
}

export interface ButlerProposalContext {
  today?: string;
  who?: string;
  todoState?: ButlerProposalTodoState;
  workItems?: readonly WorkItem[];
  messageRefs?: Readonly<Record<string, RecentSentMessage>>;
  handledStorage?: ButlerProposalHandledStorage;
}

export type ButlerProposalResult = 'applied' | 'already-applied' | 'needs-who' | 'missing-ref';

function refId(ref: string, prefix: string): string | null {
  return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
}

export function acceptButlerProposal(
  proposal: RoundsProposal,
  context: ButlerProposalContext = {},
): ButlerProposalResult {
  const todoState = context.todoState ?? useTodos.getState();
  const today = context.today ?? todayKey();

  if (proposal.kind === 'add-commitment') {
    const messageId = refId(proposal.ref, 'msg:');
    if (messageId) {
      const message = context.messageRefs?.[proposal.ref];
      if (!message || message.ref !== proposal.ref) return 'missing-ref';
      const who = (proposal.who ?? context.who)?.trim();
      if (!who) return 'needs-who';
      if (todoState.todos.some((item) => item.mid === messageId)) {
        markProposalHandled(proposal.ref, context.handledStorage);
        return 'already-applied';
      }
      todoState.add({
        source: 'message',
        title: message.text,
        rid: message.rid,
        mid: messageId,
        roomName: message.roomName,
        excerpt: message.text,
        note: proposal.reason || message.text,
        committedTo: who,
        ...(proposal.due ? { due: proposal.due } : {}),
      });
      markProposalHandled(proposal.ref, context.handledStorage);
      return 'applied';
    }

    const id = refId(proposal.ref, 'todo:');
    const todo = id ? todoState.todos.find((item) => item.id === id) : undefined;
    if (!todo) return 'missing-ref';
    const who = (proposal.who ?? context.who)?.trim();
    if (!who) return 'needs-who';
    todoState.update(todo.id, {
      committedTo: who,
      ...(proposal.due ? { due: proposal.due } : {}),
    });
    return 'applied';
  }

  if (proposal.kind === 'schedule-today') {
    const todoId = refId(proposal.ref, 'todo:');
    if (todoId) {
      const todo = todoState.todos.find((item) => item.id === todoId);
      if (!todo) return 'missing-ref';
      todoState.update(todo.id, { due: today });
      return 'applied';
    }

    const workItemRef = refId(proposal.ref, 'wi:');
    if (!workItemRef) return 'missing-ref';
    const workItemId = Number(workItemRef);
    const workItems = context.workItems ?? useWorkbench.getState().workItems;
    const workItem = Number.isInteger(workItemId)
      ? workItems.find((item) => item.id === workItemId)
      : undefined;
    if (!workItem) return 'missing-ref';
    todoState.add({
      source: 'ado',
      title: workItem.title,
      adoWorkItemId: workItem.id,
      adoProject: workItem.project,
      due: today,
    });
    return 'applied';
  }

  const todoId = refId(proposal.ref, 'todo:') ?? refId(proposal.ref, 'ledger:');
  const todo = todoId ? todoState.todos.find((item) => item.id === todoId) : undefined;
  if (!todo) return 'missing-ref';
  if (todo.done) return 'already-applied';
  todoState.toggle(todo.id);
  return 'applied';
}

export function dismissButlerProposal(
  proposal: RoundsProposal,
  storage?: ButlerProposalHandledStorage,
): void {
  markProposalHandled(proposal.ref, storage);
}
