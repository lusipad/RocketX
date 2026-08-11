import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultContributionRange,
  loadAdoContributions,
  localDayKey,
  type ContributionEventType,
  type ContributionSnapshot,
} from '../../apps/web/src/lib/adoContributions';
import {
  directGetWorkItemCommentsPage,
  directGetWorkItemRevisionPage,
  type DirectConfig,
} from '../../apps/web/src/lib/adoDirect';

const originalFetch = globalThis.fetch;

function cfg(scope: string): DirectConfig {
  return {
    adoBase: `http://ado/${scope}`,
    pat: 'top-secret',
    auth: 'none',
  };
}

function adoJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function adoText(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function statusOf(snapshot: ContributionSnapshot, type: ContributionEventType) {
  const status = snapshot.statuses.find((item) => item.type === type);
  assert.ok(status, `缺少 ${type} 状态`);
  return status;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('localDayKey 按本地时区分桶，默认范围至少覆盖今天', () => {
  assert.equal(localDayKey('2026-08-10T23:30:00Z', -480), '2026-08-11');
  assert.equal(localDayKey('2026-08-10T00:30:00Z', 330), '2026-08-09');

  const range = defaultContributionRange();
  assert.match(range.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(range.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(range.from <= range.to);
});

test('贡献聚合处理分页、去重、系统身份过滤，并产出全部六类事件', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) {
      return adoJson({
        authenticatedUser: {
          id: 'user-1',
          customDisplayName: 'Alice',
          properties: { Account: { $value: 'corp\\alice' } },
        },
      });
    }
    if (url.includes('/_apis/projects') && url.includes('$skip=0')) {
      return adoJson({ value: [{ name: 'Alpha' }] });
    }
    if (url.includes('/Alpha/_apis/git/repositories?')) {
      return adoJson({
        value: [
          { id: 'repo-a', name: 'RepoA', project: { name: 'Alpha' } },
          { id: 'repo-b', name: 'RepoB', project: { name: 'Alpha' } },
        ],
      });
    }
    if (url.includes('repo-a/commits') && url.includes('author=corp%5Calice')) {
      return adoJson({
        value: [{
          commitId: 'c1',
          comment: 'ship feature',
          author: { name: 'corp\\alice', date: '2026-08-10T23:30:00Z' },
        }],
      });
    }
    if (url.includes('repo-a/commits') && url.includes('author=Alice')) {
      return adoJson({
        value: [{
          commitId: 'c1',
          comment: 'ship feature',
          author: { name: 'Alice', date: '2026-08-10T23:30:00Z' },
        }],
      });
    }
    if (url.includes('repo-b/commits')) return adoJson({ value: [] });
    if (url.includes('/Alpha/_apis/git/pullrequests?') && url.includes('creatorId=user-1')) {
      return adoJson({
        value: [{
          pullRequestId: 101,
          title: 'Improve onboarding',
          creationDate: '2026-08-09T08:00:00Z',
          createdBy: { id: 'user-1', displayName: 'Alice' },
          repository: { id: 'repo-a', name: 'RepoA', project: { name: 'Alpha' } },
        }],
      });
    }
    if (url.includes('/Alpha/_apis/git/pullrequests?') && url.includes('repositoryId=repo-a')) {
      return adoJson({
        value: [{
          pullRequestId: 101,
          title: 'Improve onboarding',
          creationDate: '2026-08-09T08:00:00Z',
          createdBy: { id: 'user-1', displayName: 'Alice' },
          repository: { id: 'repo-a', name: 'RepoA', project: { name: 'Alpha' } },
        }],
      });
    }
    if (url.includes('/Alpha/_apis/git/pullrequests?') && url.includes('repositoryId=repo-b')) {
      return adoJson({ value: [] });
    }
    if (url.includes('/pullRequests/101/threads')) {
      return adoJson([
        {
          id: 11,
          publishedDate: '2026-08-09T09:00:00Z',
          comments: [
            {
              id: 1,
              author: { id: 'user-1', displayName: 'Alice' },
              commentType: 'text',
              content: 'Looks good',
              isDeleted: false,
              publishedDate: '2026-08-09T09:00:00Z',
            },
            {
              id: 2,
              author: { id: 'service-1', displayName: 'Project Collection Service Accounts', isContainer: true },
              commentType: 'system',
              content: 'system',
              isDeleted: false,
              publishedDate: '2026-08-09T09:00:00Z',
            },
          ],
        },
        {
          id: 12,
          publishedDate: '2026-08-09T10:00:00Z',
          comments: [{
            id: 1,
            author: { id: 'service-1', displayName: 'Project Collection Service Accounts', isContainer: true },
            commentType: 'system',
            content: 'Alice voted 10',
            isDeleted: false,
            publishedDate: '2026-08-09T10:00:00Z',
          }],
          properties: {
            CodeReviewThreadType: { $value: 'VoteUpdate' },
            CodeReviewVotedByTfId: { $value: 'user-1' },
            CodeReviewVoteResult: { $value: '10' },
          },
        },
      ]);
    }
    if (url.includes('/Alpha/_apis/wit/reporting/workItemRevisions?') && !url.includes('includeDiscussionChangesOnly=true')) {
      return adoJson({
        values: [
          {
            id: 41,
            rev: 1,
            fields: {
              'System.Title': 'Fix flaky test',
              'System.WorkItemType': 'Task',
              'System.TeamProject': 'Alpha',
              'System.CreatedDate': '2026-08-08T02:00:00Z',
              'System.CreatedBy': { id: 'user-1', displayName: 'Alice' },
            },
          },
          {
            id: 42,
            rev: 1,
            fields: {
              'System.Title': 'Service noise',
              'System.WorkItemType': 'Task',
              'System.TeamProject': 'Alpha',
              'System.CreatedDate': '2026-08-08T03:00:00Z',
              'System.CreatedBy': { id: 'service-1', displayName: 'Project Collection Service Accounts', isContainer: true },
            },
          },
        ],
      });
    }
    if (url.includes('/Alpha/_apis/wit/reporting/workItemRevisions?') && url.includes('includeDiscussionChangesOnly=true')) {
      return adoJson({
        values: [
          {
            id: 41,
            rev: 2,
            fields: {
              'System.TeamProject': 'Alpha',
              'System.ChangedDate': '2026-08-08T04:00:00Z',
            },
          },
          {
            id: 41,
            rev: 3,
            fields: {
              'System.TeamProject': 'Alpha',
              'System.ChangedDate': '2026-08-08T04:30:00Z',
            },
          },
        ],
      });
    }
    if (url.includes('/Alpha/_apis/wit/workItems/41/comments')) {
      return adoJson({
        comments: [
          {
            commentId: 7,
            text: 'Need to adjust retries',
            createdDate: '2026-08-08T04:05:00Z',
            isDeleted: false,
            createdBy: { id: 'user-1', displayName: 'Alice' },
          },
          {
            commentId: 8,
            text: 'deleted',
            createdDate: '2026-08-08T04:06:00Z',
            isDeleted: true,
            createdBy: { id: 'user-1', displayName: 'Alice' },
          },
        ],
      });
    }
    throw new Error(`未处理请求: ${url}`);
  }) as typeof fetch;

  const snapshot = await loadAdoContributions(cfg('aggregate'), {
    range: { from: '2026-08-08', to: '2026-08-11' },
    filters: {},
  });

  assert.deepEqual(snapshot.projects, ['Alpha']);
  assert.deepEqual(snapshot.repositories, [
    { id: 'repo-a', name: 'RepoA', project: 'Alpha' },
    { id: 'repo-b', name: 'RepoB', project: 'Alpha' },
  ]);
  assert.equal(snapshot.identity.id, 'user-1');
  assert.deepEqual(snapshot.events.map((event) => event.type).sort(), [
    'commit',
    'pull-request',
    'pull-request-comment',
    'pull-request-review',
    'work-item',
    'work-item-comment',
  ]);
  assert.ok(snapshot.events.every((event) => event.day === localDayKey(event.occurredAt)));
  assert.equal(snapshot.events.filter((event) => event.type === 'commit').length, 1);
  assert.match(statusOf(snapshot, 'commit').warnings.join('\n'), /account\/displayName/i);
});

test('工作项评论 API 不可用时仅该类别标记 unavailable，不误报 0 且不拖垮其他类别', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) {
      return adoJson({
        authenticatedUser: {
          id: 'user-1',
          customDisplayName: 'Alice',
          properties: { Account: { $value: 'corp\\alice' } },
        },
      });
    }
    if (url.includes('/_apis/projects')) return adoJson({ value: [{ name: 'Alpha' }] });
    if (url.includes('/Alpha/_apis/git/repositories?')) return adoJson({ value: [] });
    if (url.includes('creatorId=user-1')) return adoJson({ value: [] });
    if (url.includes('reporting/workItemRevisions?') && !url.includes('includeDiscussionChangesOnly=true')) {
      return adoJson({
        values: [{
          id: 41,
          rev: 1,
          fields: {
            'System.Title': 'Fix flaky test',
            'System.WorkItemType': 'Task',
            'System.TeamProject': 'Alpha',
            'System.CreatedDate': '2026-08-08T02:00:00Z',
            'System.CreatedBy': { id: 'user-1', displayName: 'Alice' },
          },
        }],
      });
    }
    if (url.includes('includeDiscussionChangesOnly=true')) {
      return adoJson({
        values: [{
          id: 41,
          rev: 2,
          fields: {
            'System.TeamProject': 'Alpha',
            'System.ChangedDate': '2026-08-08T04:00:00Z',
          },
        }],
      });
    }
    if (url.includes('/Alpha/_apis/wit/workItems/41/comments')) {
      return adoText('route missing', 404);
    }
    throw new Error(`未处理请求: ${url}`);
  }) as typeof fetch;

  const snapshot = await loadAdoContributions(cfg('comments-unavailable'), {
    range: { from: '2026-08-08', to: '2026-08-11' },
    filters: {},
  });

  assert.equal(snapshot.events.filter((event) => event.type === 'work-item').length, 1);
  assert.equal(snapshot.events.filter((event) => event.type === 'work-item-comment').length, 0);
  assert.equal(statusOf(snapshot, 'work-item').state, 'complete');
  assert.equal(statusOf(snapshot, 'work-item-comment').state, 'unavailable');
  assert.match(statusOf(snapshot, 'work-item-comment').warnings.join('\n'), /comments/i);
});

test('ADO 分页链接缺少 continuationToken 时明确失败，不静默截断为完整结果', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/comments?')) {
      return adoJson({
        comments: [],
        nextPage: 'http://ado/pagination/Alpha/_apis/wit/workItems/41/comments?foo=bar',
      });
    }
    if (url.includes('/reporting/workItemRevisions?')) {
      return adoJson({
        values: [],
        nextLink: 'http://ado/pagination/Alpha/_apis/wit/reporting/workItemRevisions?foo=bar',
        isLastBatch: false,
      });
    }
    throw new Error(`未处理请求: ${url}`);
  }) as typeof fetch;

  await assert.rejects(
    directGetWorkItemCommentsPage(cfg('pagination'), 'Alpha', 41),
    /分页链接缺少 continuationToken/,
  );
  await assert.rejects(
    directGetWorkItemRevisionPage(cfg('pagination'), 'Alpha', { fields: ['System.Title'] }),
    /分页链接缺少 continuationToken/,
  );
});

test('取消后停止后续批次并保持并发不超过 6', async () => {
  let active = 0;
  let maxActive = 0;
  const touchedRepos: string[] = [];
  const commitResolvers = new Map<string, () => void>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) {
      return adoJson({
        authenticatedUser: {
          id: 'user-1',
          customDisplayName: 'corp\\alice',
          properties: { Account: { $value: 'corp\\alice' } },
        },
      });
    }
    if (url.includes('/_apis/projects')) return adoJson({ value: [{ name: 'Alpha' }] });
    if (url.includes('/Alpha/_apis/git/repositories?')) {
      return adoJson({
        value: Array.from({ length: 10 }, (_, index) => ({
          id: `repo-${index + 1}`,
          name: `Repo${index + 1}`,
          project: { name: 'Alpha' },
        })),
      });
    }
    if (url.includes('creatorId=user-1')) return adoJson({ value: [] });
    if (url.includes('/commits?')) {
      const repo = /repositories\/([^/]+)\/commits/.exec(url)?.[1] ?? 'unknown';
      touchedRepos.push(repo);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        commitResolvers.set(repo, () => {
          active -= 1;
          resolve();
        });
      });
      return adoJson({ value: [] });
    }
    throw new Error(`未处理请求: ${url}`);
  }) as typeof fetch;

  const controller = new AbortController();
  const pending = loadAdoContributions(cfg('abort'), {
    range: { from: '2026-08-08', to: '2026-08-11' },
    filters: { type: 'commit' },
    signal: controller.signal,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  for (const resolve of commitResolvers.values()) resolve();

  await assert.rejects(pending, /abort/i);
  assert.ok(maxActive <= 6, `最大并发应 <= 6，实际 ${maxActive}`);
  assert.ok(touchedRepos.length <= 6, `取消后不应继续排后续 repo，请求数 ${touchedRepos.length}`);
});

test('局部失败标记 partial；缓存按连接修订隔离且 force 会绕过缓存', async () => {
  const calls = { commits: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) {
      return adoJson({
        authenticatedUser: {
          id: 'user-1',
          customDisplayName: 'corp\\alice',
          properties: { Account: { $value: 'corp\\alice' } },
        },
      });
    }
    if (url.includes('/_apis/projects')) return adoJson({ value: [{ name: 'Alpha' }] });
    if (url.includes('/Alpha/_apis/git/repositories?')) {
      return adoJson({
        value: [
          { id: 'repo-a', name: 'RepoA', project: { name: 'Alpha' } },
          { id: 'repo-b', name: 'RepoB', project: { name: 'Alpha' } },
        ],
      });
    }
    if (url.includes('creatorId=user-1')) return adoJson({ value: [] });
    if (url.includes('repo-a/commits')) {
      calls.commits += 1;
      return adoJson({
        value: [{
          commitId: 'c1',
          comment: 'ok',
          author: { name: 'corp\\alice', date: '2026-08-10T01:00:00Z' },
        }],
      });
    }
    if (url.includes('repo-b/commits')) {
      calls.commits += 1;
      return adoText('boom', 500);
    }
    throw new Error(`未处理请求: ${url}`);
  }) as typeof fetch;

  const options = {
    range: { from: '2026-08-08', to: '2026-08-11' },
    filters: { type: 'commit' as const },
    connectionRevision: 1,
  };
  const first = await loadAdoContributions(cfg('cache'), options);
  const second = await loadAdoContributions(cfg('cache'), options);
  const changedConnection = await loadAdoContributions(cfg('cache'), {
    ...options,
    connectionRevision: 2,
  });
  const forced = await loadAdoContributions(cfg('cache'), {
    ...options,
    connectionRevision: 2,
    force: true,
  });

  assert.equal(statusOf(first, 'commit').state, 'partial');
  assert.equal(statusOf(first, 'commit').count, 1);
  assert.equal(calls.commits, 6);
  assert.equal(second.events.length, first.events.length);
  assert.equal(changedConnection.events.length, first.events.length);
  assert.equal(forced.events.length, first.events.length);
});
