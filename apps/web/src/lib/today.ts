import type { RcMessage } from '@rcx/rc-client';
import { eventsForDate, isEventDone, type CalendarEvent } from '../stores/calendar';
import { isOverdue, todayKey, type Todo } from '../stores/todos';
import {
  adoDateToLocal,
  isWorkItemDone,
  myPrsOf,
  reviewPrsOf,
  type Build,
  type PullRequest,
  type WorkItem,
} from '../stores/workbench';
import type { IpmsgMessage } from '../ipmsg/store';
import { stripAgentSessionMarker } from '../agent/card';

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
  | (TodayBase & { kind: 'pr'; pullRequest: PullRequest; relation: 'review' | 'mine' })
  | (TodayBase & { kind: 'build'; build: Build })
  | (TodayBase & { kind: 'ipmsg'; message: IpmsgMessage });

export interface TodayInput {
  mentions: Array<{ message: RcMessage; roomName: string }>;
  todos: Todo[];
  events: CalendarEvent[];
  workItems: WorkItem[];
  pullRequests?: PullRequest[];
  builds?: Build[];
  adoAccount?: string;
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
      title: stripAgentSessionMarker(message.msg) || '（无文字消息）',
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

  const reviewPullRequests = reviewPrsOf(input.pullRequests ?? [], input.adoAccount ?? '');
  const reviewIds = new Set(reviewPullRequests.map((pr) => pr.id));
  const relevantPullRequests = new Map<number, PullRequest>();
  for (const pullRequest of reviewPullRequests) {
    relevantPullRequests.set(pullRequest.id, pullRequest);
  }
  for (const pullRequest of myPrsOf(input.pullRequests ?? [], input.adoAccount ?? '')) {
    relevantPullRequests.set(pullRequest.id, pullRequest);
  }
  for (const pullRequest of relevantPullRequests.values()) {
    const relation = reviewIds.has(pullRequest.id) ? 'review' : 'mine';
    const key = `ado-pr:${input.adoScope}:${pullRequest.id}`;
    items.push({
      key,
      kind: 'pr',
      title: pullRequest.title,
      meta: `#${pullRequest.id} · ${relation === 'review' ? '待我评审' : '我提的'} · ${pullRequest.repo}`,
      urgency: relation === 'review' ? 1 : 3,
      processed: processed.has(key),
      pullRequest,
      relation,
    });
  }

  for (const build of input.builds ?? []) {
    const failed = build.result.toLocaleLowerCase() === 'failed';
    const running = build.status.toLocaleLowerCase() !== 'completed';
    if (!failed && !running) continue;
    const key = `ado-build:${input.adoScope}:${build.project}:${build.id}`;
    items.push({
      key,
      kind: 'build',
      title: `${build.definition} #${build.buildNumber}`,
      meta: `${build.project} · ${failed ? '失败' : '进行中'}`,
      urgency: failed ? 0 : 2,
      processed: processed.has(key),
      build,
    });
  }

  return items.sort((left, right) => left.urgency - right.urgency || left.key.localeCompare(right.key));
}

export function todayCompletion(items: TodayItem[]): { done: number; total: number; rate: number } {
  const total = items.length;
  const done = items.filter((item) => item.processed).length;
  return { done, total, rate: total ? done / total : 1 };
}
