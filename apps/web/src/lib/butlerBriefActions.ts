import { useTodos, type Todo } from '../stores/todos';

type NewTodo = Omit<Todo, 'id' | 'done' | 'createdAt'>;

export interface ButlerBriefTodoState {
  todos: Todo[];
  add(todo: NewTodo): string;
}

export interface ButlerBriefMessageRef {
  ref: string;
  rid: string;
  roomName: string;
  text: string;
}

export interface ButlerBriefActionContext {
  todoState?: ButlerBriefTodoState;
  message?: ButlerBriefMessageRef;
}

export type ButlerBriefActionResult = 'created' | 'already-exists' | 'unsupported';

function refId(ref: string, prefix: string): string | null {
  return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
}

export function turnButlerBriefItemIntoTodo(
  ref: string,
  title: string,
  context: ButlerBriefActionContext = {},
): ButlerBriefActionResult {
  const todoState = context.todoState ?? useTodos.getState();
  const workItemRef = refId(ref, 'wi:');
  if (workItemRef) {
    const adoWorkItemId = Number(workItemRef);
    if (!Number.isInteger(adoWorkItemId)) return 'unsupported';
    if (todoState.todos.some((todo) => todo.adoWorkItemId === adoWorkItemId)) {
      return 'already-exists';
    }
    todoState.add({ source: 'ado', title, note: title, adoWorkItemId });
    return 'created';
  }

  const messageRef = refId(ref, 'msg:');
  if (messageRef) {
    const message = context.message;
    if (!message || message.ref !== ref || messageRef !== message.ref.slice(4)) return 'unsupported';
    if (todoState.todos.some((todo) => todo.mid === messageRef)) return 'already-exists';
    todoState.add({
      source: 'message',
      title,
      rid: message.rid,
      mid: messageRef,
      roomName: message.roomName,
      excerpt: message.text,
    });
    return 'created';
  }

  if (refId(ref, 'pr:') || refId(ref, 'build:')) {
    todoState.add({ source: 'manual', title, note: title });
    return 'created';
  }

  return 'unsupported';
}
