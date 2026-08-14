import {
  directGetIdentity,
  directGetProjectRefs,
  directGetPullRequestPage,
  type AdoProjectRef,
  type DirectConfig,
} from './adoDirect';
import { TimedLruCache } from './timedLruCache';

export type ContributionEventType = 'pull-request';

export interface ContributionIdentity {
  id: string;
  displayName: string;
  account: string;
  imageUrl?: string;
}

export interface ContributionEvent {
  id: string;
  type: ContributionEventType;
  day: string;
  occurredAt: string;
  project: string;
  repository?: string;
  repositoryId?: string;
  title: string;
  url: string;
  summary?: string;
}

export interface ContributionFilter {
  project?: string;
}

export interface ContributionRange {
  from: string;
  to: string;
}

export interface ContributionSourceStatus {
  type: ContributionEventType;
  state: 'complete' | 'partial' | 'unavailable';
  count: number;
  warnings: string[];
}

export interface ContributionSnapshot {
  identity: ContributionIdentity;
  events: ContributionEvent[];
  statuses: ContributionSourceStatus[];
  projects: string[];
  fetchedAt: number;
}

interface LoadOptions {
  range: ContributionRange;
  filters?: ContributionFilter;
  signal?: AbortSignal;
  force?: boolean;
  connectionRevision?: number;
}

const PAGE_SIZE = 100;
const MAX_CONCURRENCY = 6;
const SNAPSHOT_CACHE = new TimedLruCache<ContributionSnapshot>(8, 5 * 60_000);

export function localDayKey(value: string | number | Date, timezoneOffsetMinutes?: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (timezoneOffsetMinutes !== undefined) {
    const local = new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
    return local.toISOString().slice(0, 10);
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function defaultContributionRange(): ContributionRange {
  const today = new Date();
  const from = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1, 12);
  return { from: localDayKey(from), to: localDayKey(today) };
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('贡献加载已取消', 'AbortError');
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  signal: AbortSignal | undefined,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      abortIfNeeded(signal);
      const index = cursor;
      cursor += 1;
      results[index] = await task(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseLocalDay(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`无效日期：${day}`);
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(year, month - 1, date);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== date) {
    throw new Error(`无效日期：${day}`);
  }
  return value;
}

function rangeBounds(range: ContributionRange): { from: string; toExclusive: string } {
  const from = parseLocalDay(range.from);
  const to = parseLocalDay(range.to);
  if (from > to) throw new Error('贡献开始日期不能晚于结束日期');
  const end = new Date(to);
  end.setDate(end.getDate() + 1);
  return { from: from.toISOString(), toExclusive: end.toISOString() };
}

function inRange(value: string, bounds: { from: string; toExclusive: string }): boolean {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= Date.parse(bounds.from) && time < Date.parse(bounds.toExclusive);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '未知错误');
  return message.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://').slice(0, 240);
}

interface PullRequestRef {
  id: number;
  title: string;
  project: string;
  projectId: string;
  repository: string;
  repositoryId: string;
  createdAt: string;
}

function pullRequestRef(raw: Record<string, any>): PullRequestRef | null {
  const id = Number(raw.pullRequestId);
  const repositoryId = typeof raw.repository?.id === 'string' ? raw.repository.id : '';
  const project = typeof raw.repository?.project?.name === 'string' ? raw.repository.project.name : '';
  if (!Number.isInteger(id) || id <= 0 || !repositoryId || !project) return null;
  return {
    id,
    title: typeof raw.title === 'string' ? raw.title : `PR #${id}`,
    project,
    projectId: typeof raw.repository?.project?.id === 'string' ? raw.repository.project.id : project,
    repository: typeof raw.repository?.name === 'string' ? raw.repository.name : repositoryId,
    repositoryId,
    createdAt: typeof raw.creationDate === 'string' ? raw.creationDate : '',
  };
}

function pullRequestUrl(cfg: DirectConfig, pullRequest: PullRequestRef): string {
  const base = cfg.adoBase.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(pullRequest.project)}/_git/${encodeURIComponent(pullRequest.repository)}/pullrequest/${pullRequest.id}`;
}

async function fetchProjectPullRequests(
  cfg: DirectConfig,
  identityId: string,
  project: AdoProjectRef,
  bounds: { from: string; toExclusive: string },
  signal?: AbortSignal,
): Promise<ContributionEvent[]> {
  const events: ContributionEvent[] = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    abortIfNeeded(signal);
    const page = await directGetPullRequestPage(cfg, {
      project: project.name,
      creatorId: identityId,
      status: 'all',
      minTime: bounds.from,
      maxTime: bounds.toExclusive,
      queryTimeRangeType: 'created',
      top: PAGE_SIZE,
      skip,
      signal,
    });
    for (const raw of page) {
      const pullRequest = pullRequestRef(raw);
      if (!pullRequest || !inRange(pullRequest.createdAt, bounds)) continue;
      events.push({
        id: `pr:${pullRequest.projectId}:${pullRequest.repositoryId}:${pullRequest.id}:created`,
        type: 'pull-request',
        occurredAt: pullRequest.createdAt,
        day: localDayKey(pullRequest.createdAt),
        project: pullRequest.project,
        repository: pullRequest.repository,
        repositoryId: pullRequest.repositoryId,
        title: pullRequest.title,
        summary: `PR #${pullRequest.id}`,
        url: pullRequestUrl(cfg, pullRequest),
      });
    }
    if (page.length < PAGE_SIZE) return events;
  }
}

export async function loadAdoContributions(
  cfg: DirectConfig,
  options: LoadOptions,
): Promise<ContributionSnapshot> {
  abortIfNeeded(options.signal);
  const bounds = rangeBounds(options.range);
  const identity = await directGetIdentity(cfg, { signal: options.signal });
  if (!identity.id) throw new Error('Azure DevOps 未返回当前身份的稳定 ID');

  const cacheKey = JSON.stringify({
    adoBase: cfg.adoBase.trim().replace(/\/+$/, '').toLowerCase(),
    auth: cfg.auth ?? 'pat',
    connectionRevision: options.connectionRevision ?? 0,
    identity: identity.id.toLowerCase(),
    range: options.range,
    project: options.filters?.project ?? '',
  });
  if (!options.force) {
    const cached = SNAPSHOT_CACHE.get(cacheKey);
    if (cached.hit) return cached.value;
  }

  const allProjects = await directGetProjectRefs(cfg, { signal: options.signal });
  const projects = allProjects.filter(
    (project) => !options.filters?.project || project.name === options.filters.project,
  );
  const failures: string[] = [];
  const batches = await mapLimit(projects, MAX_CONCURRENCY, options.signal, async (project) => {
    try {
      return await fetchProjectPullRequests(cfg, identity.id, project, bounds, options.signal);
    } catch (error) {
      abortIfNeeded(options.signal);
      failures.push(`${project.name}：${describeError(error)}`);
      return [];
    }
  });
  abortIfNeeded(options.signal);

  const events = [...new Map(batches.flat().map((event) => [event.id, event])).values()]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  const status: ContributionSourceStatus = {
    type: 'pull-request',
    state: failures.length === 0 ? 'complete' : events.length > 0 ? 'partial' : 'unavailable',
    count: events.length,
    warnings: failures,
  };
  const snapshot: ContributionSnapshot = {
    identity,
    events,
    statuses: [status],
    projects: allProjects.map((project) => project.name),
    fetchedAt: Date.now(),
  };
  SNAPSHOT_CACHE.set(cacheKey, snapshot);
  return snapshot;
}
