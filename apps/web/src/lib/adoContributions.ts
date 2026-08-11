import {
  directGetCommitPage,
  directGetIdentity,
  directGetProjectRefs,
  directGetPullRequestPage,
  directGetPullRequestThreads,
  directGetRepositoriesForProject,
  directGetWorkItemCommentsPage,
  directGetWorkItemRevisionPage,
  type AdoProjectRef,
  type AdoRepositoryRef,
  type DirectConfig,
} from './adoDirect';
import { TimedLruCache } from './timedLruCache';

export type ContributionEventType =
  | 'commit'
  | 'pull-request'
  | 'pull-request-review'
  | 'pull-request-comment'
  | 'work-item'
  | 'work-item-comment';

export interface ContributionIdentity {
  id: string;
  displayName: string;
  account: string;
  imageUrl?: string;
}

export interface ContributionRepository {
  id: string;
  name: string;
  project: string;
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
  repository?: string;
  type?: ContributionEventType;
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
  skipped?: boolean;
}

export interface ContributionSnapshot {
  identity: ContributionIdentity;
  events: ContributionEvent[];
  statuses: ContributionSourceStatus[];
  projects: string[];
  repositories: ContributionRepository[];
  fetchedAt: number;
}

const EVENT_TYPES: ContributionEventType[] = [
  'commit',
  'pull-request',
  'pull-request-review',
  'pull-request-comment',
  'work-item',
  'work-item-comment',
];
const PAGE_SIZE = 100;
const MAX_CONCURRENCY = 6;
const MAX_PR_THREAD_SCAN = 2_000;
const SNAPSHOT_CACHE = new TimedLruCache<ContributionSnapshot>(8, 5 * 60_000);

export function localDayKey(value: string | number | Date, timezoneOffsetMinutes?: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (timezoneOffsetMinutes !== undefined) {
    const local = new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(
      local.getUTCDate(),
    ).padStart(2, '0')}`;
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

interface LoadOptions {
  range: ContributionRange;
  filters?: ContributionFilter;
  signal?: AbortSignal;
  onProgress?: (snapshot: ContributionSnapshot) => void;
  force?: boolean;
  connectionRevision?: number;
}

interface CategoryOutcome {
  successes: number;
  failures: string[];
  warnings: string[];
}

function emptyOutcome(): CategoryOutcome {
  return { successes: 0, failures: [], warnings: [] };
}

function abortError(signal?: AbortSignal): never | void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('贡献加载已取消', 'AbortError');
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  signal: AbortSignal | undefined,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      abortError(signal);
      const index = cursor;
      if (index >= values.length) return;
      cursor += 1;
      results[index] = await task(values[index], index);
      abortError(signal);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseLocalDay(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`无效日期：${day}`);
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(year, month - 1, date);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== date
  ) {
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

function inRange(value: unknown, bounds: { from: string; toExclusive: string }): value is string {
  if (typeof value !== 'string') return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= Date.parse(bounds.from) && time < Date.parse(bounds.toExclusive);
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '未知错误');
  return message.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://').slice(0, 240);
}

function cleanSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? `${text.slice(0, 180)}${text.length > 180 ? '…' : ''}` : undefined;
}

function identityId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' ? id.toLowerCase() : '';
}

function isHumanIdentity(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return identity.isContainer !== true && identity.isDeletedInOrigin !== true && !!identityId(value);
}

function sameIdentity(value: unknown, id: string): boolean {
  return isHumanIdentity(value) && identityId(value) === id.toLowerCase();
}

function propertyValue(properties: unknown, key: string): unknown {
  if (!properties || typeof properties !== 'object') return undefined;
  const value = (properties as Record<string, unknown>)[key];
  if (value && typeof value === 'object' && '$value' in value) {
    return (value as { $value?: unknown }).$value;
  }
  return value;
}

function selected(type: ContributionEventType, filter: ContributionFilter): boolean {
  return !filter.type || filter.type === type;
}

function statusMap(filter: ContributionFilter): Map<ContributionEventType, ContributionSourceStatus> {
  return new Map(EVENT_TYPES.map((type) => [type, {
    type,
    state: 'complete',
    count: 0,
    warnings: [],
    ...(!selected(type, filter) ? { skipped: true } : {}),
  }]));
}

function applyOutcome(
  status: ContributionSourceStatus,
  outcome: CategoryOutcome,
): void {
  status.warnings = Array.from(new Set([...status.warnings, ...outcome.warnings, ...outcome.failures]));
  if (outcome.failures.length > 0) {
    status.state = outcome.successes > 0 ? 'partial' : 'unavailable';
  } else if (outcome.warnings.length > 0) {
    status.state = 'partial';
  }
}

function eventUrlBase(cfg: DirectConfig): string {
  return cfg.adoBase.replace(/\/+$/, '');
}

function snapshotOf(
  identity: ContributionIdentity,
  events: Map<string, ContributionEvent>,
  statuses: Map<ContributionEventType, ContributionSourceStatus>,
  projects: AdoProjectRef[],
  repositories: AdoRepositoryRef[],
): ContributionSnapshot {
  const orderedEvents = [...events.values()].sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt));
  for (const status of statuses.values()) {
    status.count = orderedEvents.filter((event) => event.type === status.type).length;
  }
  return {
    identity,
    events: orderedEvents,
    statuses: [...statuses.values()].map((status) => ({ ...status, warnings: [...status.warnings] })),
    projects: projects.map((project) => project.name),
    repositories: repositories.map((repository) => ({
      id: repository.id,
      name: repository.name,
      project: repository.project.name,
    })),
    fetchedAt: Date.now(),
  };
}

async function fetchCommitEvents(
  cfg: DirectConfig,
  identity: ContributionIdentity,
  repositories: AdoRepositoryRef[],
  bounds: { from: string; toExclusive: string },
  events: Map<string, ContributionEvent>,
  signal?: AbortSignal,
): Promise<CategoryOutcome> {
  const outcome = emptyOutcome();
  const aliases = Array.from(new Set([identity.account, identity.displayName].map((value) => value.trim()).filter(Boolean)));
  outcome.warnings.push('Git commits API 仅支持 account/displayName 作者别名，无法使用稳定 identity id；结果可能不完整。');
  if (aliases.length === 0) {
    outcome.failures.push('当前身份没有可用于 Git commits API 的 account/displayName。');
    return outcome;
  }
  await mapLimit(repositories, MAX_CONCURRENCY, signal, async (repository) => {
    let repositorySucceeded = false;
    for (const author of aliases) {
      try {
        for (let skip = 0; ; skip += PAGE_SIZE) {
          abortError(signal);
          const page = await directGetCommitPage(
            cfg,
            repository.project.name,
            repository.id,
            { author, fromDate: bounds.from, toDate: bounds.toExclusive, top: PAGE_SIZE, skip, signal },
          );
          repositorySucceeded = true;
          for (const commit of page) {
            const occurredAt = commit.author?.date ?? commit.committer?.date;
            const commitId = typeof commit.commitId === 'string' ? commit.commitId : '';
            if (!commitId || !inRange(occurredAt, bounds)) continue;
            const id = `commit:${repository.project.id || repository.project.name}:${repository.id}:${commitId}`;
            events.set(id, {
              id,
              type: 'commit',
              occurredAt,
              day: localDayKey(occurredAt),
              project: repository.project.name,
              repository: repository.name,
              repositoryId: repository.id,
              title: cleanSummary(commit.comment)?.split('\n')[0] || commitId.slice(0, 8),
              summary: cleanSummary(commit.comment),
              url: commit.remoteUrl || `${eventUrlBase(cfg)}/${encodeURIComponent(repository.project.name)}/_git/${encodeURIComponent(repository.name)}/commit/${commitId}`,
            });
          }
          if (page.length < PAGE_SIZE) break;
        }
      } catch (err) {
        abortError(signal);
        outcome.failures.push(`${repository.project.name}/${repository.name}（${author}）：${describeError(err)}`);
      }
    }
    if (repositorySucceeded) outcome.successes += 1;
  });
  return outcome;
}

function pullRequestRef(pr: Record<string, any>): {
  id: number;
  title: string;
  project: string;
  projectId: string;
  repository: string;
  repositoryId: string;
  createdAt: string;
} | null {
  const id = Number(pr.pullRequestId);
  const repositoryId = typeof pr.repository?.id === 'string' ? pr.repository.id : '';
  const project = typeof pr.repository?.project?.name === 'string' ? pr.repository.project.name : '';
  if (!Number.isInteger(id) || id <= 0 || !repositoryId || !project) return null;
  return {
    id,
    title: typeof pr.title === 'string' ? pr.title : `PR #${id}`,
    project,
    projectId: typeof pr.repository?.project?.id === 'string' ? pr.repository.project.id : project,
    repository: typeof pr.repository?.name === 'string' ? pr.repository.name : repositoryId,
    repositoryId,
    createdAt: typeof pr.creationDate === 'string' ? pr.creationDate : '',
  };
}

function pullRequestUrl(cfg: DirectConfig, pr: NonNullable<ReturnType<typeof pullRequestRef>>): string {
  return `${eventUrlBase(cfg)}/${encodeURIComponent(pr.project)}/_git/${encodeURIComponent(pr.repository)}/pullrequest/${pr.id}`;
}

async function fetchCreatedPullRequests(
  cfg: DirectConfig,
  identity: ContributionIdentity,
  projects: AdoProjectRef[],
  bounds: { from: string; toExclusive: string },
  events: Map<string, ContributionEvent>,
  signal?: AbortSignal,
): Promise<CategoryOutcome> {
  const outcome = emptyOutcome();
  await mapLimit(projects, MAX_CONCURRENCY, signal, async (project) => {
    try {
      for (let skip = 0; ; skip += PAGE_SIZE) {
        const page = await directGetPullRequestPage(cfg, {
          project: project.name,
          creatorId: identity.id,
          status: 'all',
          minTime: bounds.from,
          maxTime: bounds.toExclusive,
          queryTimeRangeType: 'created',
          top: PAGE_SIZE,
          skip,
          signal,
        });
        for (const raw of page) {
          const pr = pullRequestRef(raw);
          if (!pr || !inRange(pr.createdAt, bounds)) continue;
          const id = `pr:${pr.projectId}:${pr.repositoryId}:${pr.id}:created`;
          events.set(id, {
            id,
            type: 'pull-request',
            occurredAt: pr.createdAt,
            day: localDayKey(pr.createdAt),
            project: pr.project,
            repository: pr.repository,
            repositoryId: pr.repositoryId,
            title: pr.title,
            summary: `PR #${pr.id}`,
            url: pullRequestUrl(cfg, pr),
          });
        }
        if (page.length < PAGE_SIZE) break;
      }
      outcome.successes += 1;
    } catch (err) {
      abortError(signal);
      outcome.failures.push(`${project.name}：${describeError(err)}`);
    }
  });
  return outcome;
}

async function fetchPullRequestActivity(
  cfg: DirectConfig,
  identity: ContributionIdentity,
  repositories: AdoRepositoryRef[],
  bounds: { from: string; toExclusive: string },
  events: Map<string, ContributionEvent>,
  signal?: AbortSignal,
): Promise<{ comments: CategoryOutcome; reviews: CategoryOutcome }> {
  const comments = emptyOutcome();
  const reviews = emptyOutcome();
  const candidates = new Map<string, NonNullable<ReturnType<typeof pullRequestRef>>>();
  let capped = false;
  await mapLimit(repositories, MAX_CONCURRENCY, signal, async (repository) => {
    try {
      for (let skip = 0; ; skip += PAGE_SIZE) {
        const page = await directGetPullRequestPage(cfg, {
          project: repository.project.name,
          repositoryId: repository.id,
          status: 'all',
          maxTime: bounds.toExclusive,
          queryTimeRangeType: 'created',
          top: PAGE_SIZE,
          skip,
          signal,
        });
        for (const raw of page) {
          const pr = pullRequestRef(raw);
          if (!pr) continue;
          if (candidates.size >= MAX_PR_THREAD_SCAN) {
            capped = true;
            break;
          }
          candidates.set(`${pr.repositoryId}:${pr.id}`, pr);
        }
        if (capped || page.length < PAGE_SIZE) break;
      }
      comments.successes += 1;
      reviews.successes += 1;
    } catch (err) {
      abortError(signal);
      const message = `${repository.project.name}/${repository.name} PR 列表：${describeError(err)}`;
      comments.failures.push(message);
      reviews.failures.push(message);
    }
  });
  if (capped) {
    const warning = `PR thread 扫描达到 ${MAX_PR_THREAD_SCAN} 条保护上限，更早 PR 中的近期评论或评审可能缺失。`;
    comments.warnings.push(warning);
    reviews.warnings.push(warning);
  }

  await mapLimit([...candidates.values()], MAX_CONCURRENCY, signal, async (pr) => {
    try {
      const threads = await directGetPullRequestThreads(
        cfg,
        pr.project,
        pr.repositoryId,
        pr.id,
        { signal },
      );
      comments.successes += 1;
      reviews.successes += 1;
      for (const thread of threads) {
        if (thread?.isDeleted === true) continue;
        const threadId = Number(thread?.id);
        const reviewType = String(propertyValue(thread?.properties, 'CodeReviewThreadType') ?? '').toLowerCase();
        const votedBy = String(propertyValue(thread?.properties, 'CodeReviewVotedByTfId') ?? '').toLowerCase();
        const threadDate = thread?.publishedDate ?? thread?.comments?.[0]?.publishedDate;
        if (reviewType === 'voteupdate' && votedBy === identity.id.toLowerCase() && inRange(threadDate, bounds)) {
          const vote = Number(propertyValue(thread?.properties, 'CodeReviewVoteResult'));
          const id = `pr:${pr.projectId}:${pr.repositoryId}:${pr.id}:thread:${threadId}:vote`;
          events.set(id, {
            id,
            type: 'pull-request-review',
            occurredAt: threadDate,
            day: localDayKey(threadDate),
            project: pr.project,
            repository: pr.repository,
            repositoryId: pr.repositoryId,
            title: pr.title,
            summary: Number.isFinite(vote) ? `PR #${pr.id}，评审票值 ${vote}` : `PR #${pr.id} 评审`,
            url: `${pullRequestUrl(cfg, pr)}?discussionId=${threadId}`,
          });
        }
        for (const comment of thread?.comments ?? []) {
          const commentType = String(comment?.commentType ?? '').toLowerCase();
          const occurredAt = comment?.publishedDate;
          if (
            comment?.isDeleted === true ||
            (commentType !== 'text' && commentType !== '1') ||
            !sameIdentity(comment?.author, identity.id) ||
            !inRange(occurredAt, bounds)
          ) continue;
          const commentId = Number(comment?.id);
          const id = `pr:${pr.projectId}:${pr.repositoryId}:${pr.id}:thread:${threadId}:comment:${commentId}`;
          const filePath = typeof thread?.threadContext?.filePath === 'string'
            ? thread.threadContext.filePath
            : undefined;
          events.set(id, {
            id,
            type: 'pull-request-comment',
            occurredAt,
            day: localDayKey(occurredAt),
            project: pr.project,
            repository: pr.repository,
            repositoryId: pr.repositoryId,
            title: pr.title,
            summary: cleanSummary(filePath ? `${filePath}：${comment?.content ?? ''}` : comment?.content),
            url: `${pullRequestUrl(cfg, pr)}?discussionId=${threadId}`,
          });
        }
      }
    } catch (err) {
      abortError(signal);
      const message = `${pr.project}/${pr.repository} PR #${pr.id} threads：${describeError(err)}`;
      comments.failures.push(message);
      reviews.failures.push(message);
    }
  });
  return { comments, reviews };
}

async function fetchRevisionPages(
  cfg: DirectConfig,
  project: string,
  bounds: { from: string; toExclusive: string },
  discussion: boolean,
  signal?: AbortSignal,
): Promise<Record<string, any>[]> {
  const values: Record<string, any>[] = [];
  let continuationToken: string | undefined;
  for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
    abortError(signal);
    const page = await directGetWorkItemRevisionPage(cfg, project, {
      fields: discussion
        ? ['System.Title', 'System.TeamProject', 'System.ChangedDate', 'System.ChangedBy']
        : ['System.Title', 'System.WorkItemType', 'System.TeamProject', 'System.CreatedDate', 'System.CreatedBy'],
      ...(!continuationToken ? { startDateTime: bounds.from } : {}),
      continuationToken,
      includeDiscussionChangesOnly: discussion,
      includeIdentityRef: true,
      pageSize: 1_000,
      signal,
    });
    values.push(...page.values);
    if (!page.continuationToken) {
      if (page.isLastBatch === false) throw new Error('reporting work item revisions 分页缺少 continuationToken');
      return values;
    }
    continuationToken = page.continuationToken;
  }
  throw new Error('reporting work item revisions 分页超过安全上限');
}

async function fetchCreatedWorkItems(
  cfg: DirectConfig,
  identity: ContributionIdentity,
  projects: AdoProjectRef[],
  bounds: { from: string; toExclusive: string },
  events: Map<string, ContributionEvent>,
  signal?: AbortSignal,
): Promise<CategoryOutcome> {
  const outcome = emptyOutcome();
  await mapLimit(projects, MAX_CONCURRENCY, signal, async (project) => {
    try {
      const revisions = await fetchRevisionPages(cfg, project.name, bounds, false, signal);
      for (const revision of revisions) {
        const fields = revision.fields ?? {};
        const occurredAt = fields['System.CreatedDate'];
        const idValue = Number(revision.id);
        if (
          !Number.isInteger(idValue) ||
          idValue <= 0 ||
          !sameIdentity(fields['System.CreatedBy'], identity.id) ||
          !inRange(occurredAt, bounds)
        ) continue;
        const teamProject = fields['System.TeamProject'] || project.name;
        const id = `wit:${idValue}:created`;
        events.set(id, {
          id,
          type: 'work-item',
          occurredAt,
          day: localDayKey(occurredAt),
          project: teamProject,
          title: fields['System.Title'] || `工作项 #${idValue}`,
          summary: fields['System.WorkItemType'] ? `${fields['System.WorkItemType']} #${idValue}` : `工作项 #${idValue}`,
          url: `${eventUrlBase(cfg)}/${encodeURIComponent(teamProject)}/_workitems/edit/${idValue}`,
        });
      }
      outcome.successes += 1;
    } catch (err) {
      abortError(signal);
      outcome.failures.push(`${project.name} 工作项创建：${describeError(err)}`);
    }
  });
  return outcome;
}

async function fetchWorkItemComments(
  cfg: DirectConfig,
  identity: ContributionIdentity,
  projects: AdoProjectRef[],
  bounds: { from: string; toExclusive: string },
  events: Map<string, ContributionEvent>,
  signal?: AbortSignal,
): Promise<CategoryOutcome> {
  const outcome = emptyOutcome();
  const candidates = new Map<number, { project: string; title?: string }>();
  await mapLimit(projects, MAX_CONCURRENCY, signal, async (project) => {
    try {
      const revisions = await fetchRevisionPages(cfg, project.name, bounds, true, signal);
      for (const revision of revisions) {
        const fields = revision.fields ?? {};
        const id = Number(revision.id);
        if (!Number.isInteger(id) || id <= 0 || !inRange(fields['System.ChangedDate'], bounds)) continue;
        candidates.set(id, {
          project: fields['System.TeamProject'] || project.name,
          title: fields['System.Title'],
        });
      }
      outcome.successes += 1;
    } catch (err) {
      abortError(signal);
      outcome.failures.push(`${project.name} discussion revisions：${describeError(err)}`);
    }
  });

  let commentSuccesses = 0;
  let commentFailures = 0;
  await mapLimit([...candidates.entries()], MAX_CONCURRENCY, signal, async ([workItemId, candidate]) => {
    try {
      let continuationToken: string | undefined;
      for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
        const page = await directGetWorkItemCommentsPage(cfg, candidate.project, workItemId, {
          continuationToken,
          top: PAGE_SIZE,
          signal,
        });
        for (const comment of page.comments) {
          const occurredAt = comment?.createdDate;
          const commentId = Number(comment?.commentId ?? comment?.id);
          if (
            !Number.isInteger(commentId) ||
            comment?.isDeleted === true ||
            !sameIdentity(comment?.createdBy, identity.id) ||
            !inRange(occurredAt, bounds)
          ) continue;
          const id = `wit:${workItemId}:comment:${commentId}`;
          events.set(id, {
            id,
            type: 'work-item-comment',
            occurredAt,
            day: localDayKey(occurredAt),
            project: candidate.project,
            title: candidate.title || `工作项 #${workItemId}`,
            summary: cleanSummary(comment?.text),
            url: `${eventUrlBase(cfg)}/${encodeURIComponent(candidate.project)}/_workitems/edit/${workItemId}`,
          });
        }
        if (!page.continuationToken) break;
        continuationToken = page.continuationToken;
        if (pageIndex === 999) throw new Error('Work Item Comments 分页超过安全上限');
      }
      commentSuccesses += 1;
    } catch (err) {
      abortError(signal);
      commentFailures += 1;
      outcome.failures.push(`${candidate.project} #${workItemId} Work Item Comments API：${describeError(err)}`);
    }
  });
  outcome.successes += commentSuccesses;
  if (commentFailures > 0 && commentSuccesses === 0) outcome.successes = 0;
  return outcome;
}

export async function loadAdoContributions(
  cfg: DirectConfig,
  options: LoadOptions,
): Promise<ContributionSnapshot> {
  abortError(options.signal);
  const bounds = rangeBounds(options.range);
  const filter = options.filters ?? {};
  const identity = await directGetIdentity(cfg, { signal: options.signal });
  if (!identity.id) throw new Error('Azure DevOps 未返回当前身份的稳定 ID');
  const cacheKey = JSON.stringify({
    adoBase: cfg.adoBase.trim().replace(/\/+$/, '').toLowerCase(),
    auth: cfg.auth ?? 'pat',
    connectionRevision: options.connectionRevision ?? 0,
    identity: identity.id.toLowerCase(),
    range: options.range,
    filter: {
      project: filter.project ?? '',
      repository: filter.repository ?? '',
      type: filter.type ?? '',
    },
  });
  if (!options.force) {
    const cached = SNAPSHOT_CACHE.get(cacheKey);
    if (cached.hit) return cached.value;
  }

  const allProjects = await directGetProjectRefs(cfg, { signal: options.signal });
  const projects = allProjects.filter((project) => !filter.project || project.name === filter.project);
  const repositoryFailures: string[] = [];
  const repositoryLists = await mapLimit(projects, MAX_CONCURRENCY, options.signal, async (project) => {
    try {
      return await directGetRepositoriesForProject(cfg, project, { signal: options.signal });
    } catch (err) {
      abortError(options.signal);
      repositoryFailures.push(`${project.name} 仓库：${describeError(err)}`);
      return [];
    }
  });
  const allRepositories = repositoryLists.flat();
  const repositories = allRepositories.filter((repository) =>
    !filter.repository || repository.id === filter.repository || repository.name === filter.repository);
  const statuses = statusMap(filter);
  const events = new Map<string, ContributionEvent>();
  const publish = () => {
    if (!options.onProgress) return;
    try {
      options.onProgress(snapshotOf(identity, events, statuses, allProjects, allRepositories));
    } catch {
      // 进度监听器不能破坏数据加载。
    }
  };

  if (selected('commit', filter)) {
    const outcome = await fetchCommitEvents(cfg, identity, repositories, bounds, events, options.signal);
    outcome.failures.push(...repositoryFailures);
    applyOutcome(statuses.get('commit')!, outcome);
    publish();
  }
  if (selected('pull-request', filter)) {
    const outcome = await fetchCreatedPullRequests(cfg, identity, projects, bounds, events, options.signal);
    applyOutcome(statuses.get('pull-request')!, outcome);
    publish();
  }
  if (selected('pull-request-comment', filter) || selected('pull-request-review', filter)) {
    const outcome = await fetchPullRequestActivity(cfg, identity, repositories, bounds, events, options.signal);
    outcome.comments.failures.push(...repositoryFailures);
    outcome.reviews.failures.push(...repositoryFailures);
    if (selected('pull-request-comment', filter)) {
      applyOutcome(statuses.get('pull-request-comment')!, outcome.comments);
    }
    if (selected('pull-request-review', filter)) {
      applyOutcome(statuses.get('pull-request-review')!, outcome.reviews);
    }
    publish();
  }
  if (selected('work-item', filter)) {
    applyOutcome(
      statuses.get('work-item')!,
      await fetchCreatedWorkItems(cfg, identity, projects, bounds, events, options.signal),
    );
    publish();
  }
  if (selected('work-item-comment', filter)) {
    applyOutcome(
      statuses.get('work-item-comment')!,
      await fetchWorkItemComments(cfg, identity, projects, bounds, events, options.signal),
    );
    publish();
  }

  abortError(options.signal);
  const snapshot = snapshotOf(identity, events, statuses, allProjects, allRepositories);
  SNAPSHOT_CACHE.set(cacheKey, snapshot);
  return snapshot;
}
