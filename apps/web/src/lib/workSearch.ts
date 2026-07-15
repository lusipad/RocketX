import type { CalendarEvent } from '../stores/calendar';
import type { Todo } from '../stores/todos';
import type { WorkItem } from '../stores/workbench';

export type WorkSearchResult =
  | { kind: 'todo'; item: Todo }
  | { kind: 'event'; item: CalendarEvent }
  | { kind: 'workitem'; item: WorkItem };

function matchScore(keyword: string, title: string, details: string): number | null {
  const q = keyword.toLocaleLowerCase();
  const normalizedTitle = title.toLocaleLowerCase();
  if (normalizedTitle.startsWith(q)) return 0;
  if (normalizedTitle.includes(q)) return 1;
  return details.toLocaleLowerCase().includes(q) ? 2 : null;
}

/** 搜索已经在客户端缓存的工作数据，不触发额外网络请求。 */
export function searchWork(
  keyword: string,
  todos: Todo[],
  events: CalendarEvent[],
  workItems: WorkItem[],
  limit = 20,
): WorkSearchResult[] {
  const q = keyword.trim();
  if (!q) return [];

  const matches: { score: number; order: number; result: WorkSearchResult }[] = [];
  let order = 0;
  for (const item of todos) {
    const score = matchScore(
      q,
      item.note || item.excerpt,
      `${item.excerpt} ${item.roomName} ${item.author} ${item.due ?? ''}`,
    );
    if (score !== null) matches.push({ score, order, result: { kind: 'todo', item } });
    order++;
  }
  for (const item of events) {
    const score = matchScore(
      q,
      item.title,
      `${item.description ?? ''} ${item.date} ${item.startTime ?? ''} ${item.endTime ?? ''}`,
    );
    if (score !== null) matches.push({ score, order, result: { kind: 'event', item } });
    order++;
  }
  for (const item of workItems) {
    const score = matchScore(
      q,
      `#${item.id} ${item.title}`,
      `${item.type} ${item.state} ${item.project} ${item.assignedTo ?? ''}`,
    );
    if (score !== null) matches.push({ score, order, result: { kind: 'workitem', item } });
    order++;
  }

  return matches
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map(({ result }) => result);
}
