import type { Todo } from '../stores/todos';

export interface LedgerEntry {
  kind: 'commitment' | 'wait';
  todoId: string;
  who: string;
  title: string;
  due?: string;
  dueState: 'overdue' | 'today' | 'upcoming' | 'none';
}

function dueState(due: string | undefined, today: string): LedgerEntry['dueState'] {
  if (!due) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'upcoming';
}

export function ledgerFromTodos(todos: Todo[], today: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const todo of todos) {
    if (todo.done) continue;
    const title = todo.title || todo.note || '待办';
    const state = dueState(todo.due, today);
    if (todo.committedTo) {
      entries.push({
        kind: 'commitment',
        todoId: todo.id,
        who: todo.committedTo,
        title,
        due: todo.due,
        dueState: state,
      });
    }
    if (todo.waitingFor) {
      entries.push({
        kind: 'wait',
        todoId: todo.id,
        who: todo.waitingFor,
        title,
        due: todo.due,
        dueState: state,
      });
    }
  }
  return entries;
}
