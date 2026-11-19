import type { CalendarEvent } from '../stores/calendar';
import type { Todo } from '../stores/todos';
import type { WorkItem } from '../stores/workbench';
import { pinyinMatch, pinyinScore } from './pinyin';

export type WorkSearchResult =
  | { kind: 'todo'; item: Todo }
  | { kind: 'event'; item: CalendarEvent }
  | { kind: 'workitem'; item: WorkItem };

function matchScore(keyword: string, title: string, details: string): number | null {
  const q = keyword.trim();
  const titleScore = pinyinScore(q, title);
  if (pinyinMatch(q, title)) return titleScore < 4 ? titleScore : 1;
  return details.toLocaleLowerCase().includes(q.toLocaleLowerCase()) ? 2 : null;
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
      item.note || item.excerpt || '',
      `${item.excerpt ?? ''} ${item.roomName ?? ''} ${item.author ?? ''} ${item.due ?? ''}`,
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

export const WORK_CONTEXT_SEARCH_COVERAGE = '仅检索当前账号已缓存的工作、原生会话索引、外部联系、验证成果和归档简报；不读取磁盘全文、未缓存聊天或远端 ADO 全库。未找到不表示来源中不存在。';

export interface WorkContextSearchInput {
  accountScope: string;
  query: string;
  workspaceRoot?: string | null;
  projectKey?: string | null;
  cards: readonly { id: string; title: string; note?: string | null; adoWorkItemId?: number | null; adoProject?: string | null; updatedAt: number; state: { projectKey?: string | null } }[];
  sessions: readonly { id: string; todoId: string | null; nativeSessionId: string; runtime: string; title?: string | null; workspaceRoot: string; accountScope?: string | null; updatedAt: number }[];
  links: readonly { id: string; todoId: string; externalId: string; title?: string | null; webUrl?: string | null; project?: string | null; lastVerifiedAt: number }[];
  evidences: readonly { id: string; todoId: string; title: string; summary?: string | null; workspaceRoot?: string | null; webUrl?: string | null; stale?: boolean; verifiedAt: number }[];
  digests?: readonly { id: string; accountScope: string; relatedTodoId: string | null; title: string; summaryMd: string; createdAt: number }[];
  limit?: number;
}

export interface WorkContextSearchResult {
  id: string;
  kind: 'work' | 'session' | 'link' | 'artifact' | 'digest';
  title: string;
  snippet: string;
  workId: string | null;
  sourceRef: string;
  updatedAt: number;
  stale: boolean;
}

function comparableWorkspace(path?: string | null): string {
  return (path ?? '').trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/** The ledger passed here must already be hydrated for accountScope. No network or filesystem search. */
export function searchWorkContext(input: WorkContextSearchInput): WorkContextSearchResult[] {
  const query = input.query.trim();
  if (!query) return [];
  const ws = comparableWorkspace(input.workspaceRoot);
  const project = input.projectKey?.trim().toLowerCase();
  const sessions = input.sessions.filter((s) => (!s.accountScope || s.accountScope === input.accountScope)
    && (!ws || comparableWorkspace(s.workspaceRoot) === ws));
  const scopedWorkIds = new Set(input.cards.filter((card) => {
    if (project && (card.state.projectKey ?? card.adoProject ?? '').toLowerCase() !== project) return false;
    return !ws || sessions.some((s) => s.todoId === card.id)
      || Boolean(project && (card.state.projectKey ?? card.adoProject ?? '').toLowerCase() === project);
  }).map((card) => card.id));
  const results: Array<{ score: number; result: WorkContextSearchResult }> = [];
  const add = (result: WorkContextSearchResult) => {
    const score = matchScore(query, result.title, `${result.snippet} ${result.sourceRef}`);
    if (score !== null) results.push({ score, result });
  };
  for (const card of input.cards) {
    if (!scopedWorkIds.has(card.id)) continue;
    add({ id: `work:${card.id}`, kind: 'work', title: card.title, snippet: [card.adoWorkItemId ? `ADO #${card.adoWorkItemId}` : '', card.note, card.adoProject].filter(Boolean).join(' · '), workId: card.id, sourceRef: `work:${card.id}`, updatedAt: card.updatedAt, stale: false });
  }
  for (const session of sessions) {
    if ((session.todoId && !scopedWorkIds.has(session.todoId)) || (!session.todoId && project)) continue;
    add({ id: `session:${session.id}`, kind: 'session', title: session.title || session.nativeSessionId, snippet: `${session.runtime} · ${session.workspaceRoot} · ${session.nativeSessionId}`, workId: session.todoId, sourceRef: session.nativeSessionId, updatedAt: session.updatedAt, stale: false });
  }
  for (const link of input.links) {
    if (!scopedWorkIds.has(link.todoId)) continue;
    add({ id: `link:${link.id}`, kind: 'link', title: link.title || link.externalId, snippet: [link.externalId, link.project, link.webUrl].filter(Boolean).join(' · '), workId: link.todoId, sourceRef: link.webUrl || link.externalId, updatedAt: link.lastVerifiedAt, stale: false });
  }
  for (const evidence of input.evidences) {
    if (!scopedWorkIds.has(evidence.todoId) || (ws && evidence.workspaceRoot && comparableWorkspace(evidence.workspaceRoot) !== ws)) continue;
    add({ id: `artifact:${evidence.id}`, kind: 'artifact', title: evidence.title, snippet: evidence.summary ?? '', workId: evidence.todoId, sourceRef: evidence.webUrl || `evidence:${evidence.id}`, updatedAt: evidence.verifiedAt, stale: Boolean(evidence.stale) });
  }
  for (const digest of input.digests ?? []) {
    if (digest.accountScope !== input.accountScope || !digest.relatedTodoId || !scopedWorkIds.has(digest.relatedTodoId)) continue;
    add({ id: `digest:${digest.id}`, kind: 'digest', title: digest.title, snippet: digest.summaryMd, workId: digest.relatedTodoId, sourceRef: `digest:${digest.id}`, updatedAt: digest.createdAt, stale: false });
  }
  return results.sort((a, b) => a.score - b.score || b.result.updatedAt - a.result.updatedAt || a.result.id.localeCompare(b.result.id))
    .slice(0, Math.max(1, Math.min(input.limit ?? 30, 100))).map(({ result }) => ({ ...result, snippet: result.snippet.slice(0, 300) }));
}
