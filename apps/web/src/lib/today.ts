import type { RcMessage } from '@rcx/rc-client';
import { eventsForDate, isEventDone, type CalendarEvent } from '../stores/calendar';
import { isOverdue, todayKey, type Todo } from '../stores/todos';
import { adoDateToLocal, isWorkItemDone, type WorkItem } from '../stores/workbench';
import type { IpmsgMessage } from '../ipmsg/store';

interface TodayBase {
  key: string;
  title: string;
  meta?: string;
  urgency: number;
  processed: boolean;
}

export type TodayItem =
  | (TodayBase & { kind: 'mention'; message: RcMessage; roomName: string })
  | (TodayBase & { kind: 'todo'; todo: Todo })
  | (TodayBase & { kind: 'event'; event: CalendarEvent; occurrenceDate: string })
  | (TodayBase & { kind: 'workitem'; workItem: WorkItem })
  | (TodayBase & { kind: 'ipmsg'; message: IpmsgMessage });

export interface TodayInput {
  mentions: Array<{ message: RcMessage; roomName: string }>;
  todos: Todo[];
  events: CalendarEvent[];
  workItems: WorkItem[];
  ipmsg?: IpmsgMessage[];
  scope: string;
  adoScope: string;
  processed?: ReadonlySet<string>;
  today?: string;
}

export function buildTodayItems(input: TodayInput): TodayItem[] {
  const today = input.today ?? todayKey();
  const processed = input.processed ?? new Set<string>();
  const items: TodayItem[] = [];

  for (const { message, roomName } of input.mentions) {
    const key = `rc:${input.scope}:${message.rid}:${message._id}`;
    items.push({
      key,
      kind: 'mention',
      title: message.msg || '（无文字消息）',
      meta: `${roomName} · ${message.u.name || message.u.username}`,
      urgency: 1,
      processed: processed.has(key),
      message,
      roomName,
    });
  }

  for (const message of input.ipmsg ?? []) {
    if (message.direction !== 'incoming') continue;
    const key = `ipmsg:${input.scope}:${message.id}`;
    items.push({
      key,
      kind: 'ipmsg',
      title: message.text || '（无文字消息）',
      meta: `${message.senderName} · 未认证局域网协议`,
      urgency: 1,
      processed: processed.has(key),
      message,
    });
  }

  for (const todo of input.todos) {
    if (todo.done || !todo.due || todo.due > today) continue;
    const key = `todo:${input.scope}:${todo.id}`;
    items.push({
      key,
      kind: 'todo',
      title: todo.note || todo.excerpt || '（无描述）',
      meta: todo.roomName,
      urgency: isOverdue(todo, today) ? 0 : 3,
      processed: processed.has(key),
      todo,
    });
  }

  for (const event of eventsForDate(input.events, today)) {
    if (isEventDone(event, today)) continue;
    const key = `event:${input.scope}:${event.id}:${today}`;
    items.push({
      key,
      kind: 'event',
      title: event.title,
      meta: event.allDay ? '全天' : [event.startTime, event.endTime].filter(Boolean).join(' - '),
      urgency: 2,
      processed: processed.has(key),
      event,
      occurrenceDate: today,
    });
  }

  for (const workItem of input.workItems) {
    if (isWorkItemDone(workItem.state)) continue;
    const due = adoDateToLocal(workItem.dueDate);
    const key = `ado:${input.adoScope}:${workItem.project}:${workItem.id}`;
    items.push({
      key,
      kind: 'workitem',
      title: workItem.title,
      meta: `#${workItem.id} · ${workItem.state}`,
      urgency: due && due < today ? 0 : due === today ? 3 : 4,
      processed: processed.has(key),
      workItem,
    });
  }

  return items.sort((left, right) => left.urgency - right.urgency || left.key.localeCompare(right.key));
}

export function todayCompletion(items: TodayItem[]): { done: number; total: number; rate: number } {
  const total = items.length;
  const done = items.filter((item) => item.processed).length;
  return { done, total, rate: total ? done / total : 1 };
}
