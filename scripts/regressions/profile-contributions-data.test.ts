import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultContributionRange,
  loadAdoContributions,
  localDayKey,
} from '../../apps/web/src/lib/adoContributions';

const originalFetch = globalThis.fetch;

function adoJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function identity() {
  return {
    authenticatedUser: {
      id: 'user-1',
      customDisplayName: 'Alice',
      properties: { Account: { $value: 'corp\\alice' } },
    },
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('localDayKey 按本地时区分桶，默认范围为最近一年（issue #307）', () => {
  assert.equal(localDayKey('2026-08-10T23:30:00Z', -480), '2026-08-11');
  assert.equal(localDayKey('2026-08-10T00:30:00Z', 330), '2026-08-09');

  const range = defaultContributionRange();
  const today = new Date();
  const expectedFrom = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1, 12);
  assert.equal(range.from, localDayKey(expectedFrom));
  assert.equal(range.to, localDayKey(today));
});

test('PR 统计按项目分页、按创建时间过滤并去重', async () => {
  let pullRequestCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) return adoJson(identity());
    if (url.includes('/_apis/projects')) return adoJson({ value: [{ id: 'p1', name: 'Alpha' }] });
    if (url.includes('/Alpha/_apis/git/pullrequests?')) {
      pullRequestCalls += 1;
      const skip = new URL(url).searchParams.get('$skip');
      if (skip === '0') {
        return adoJson({
          value: Array.from({ length: 100 }, (_, index) => ({
            pullRequestId: index + 1,
            title: `PR ${index + 1}`,
            creationDate: '2026-08-10T08:00:00Z',
            repository: { id: 'r1', name: 'Repo', project: { id: 'p1', name: 'Alpha' } },
          })),
        });
      }
      return adoJson({
        value: [{
          pullRequestId: 101,
          title: 'PR 101',
          creationDate: '2026-08-11T08:00:00Z',
          repository: { id: 'r1', name: 'Repo', project: { id: 'p1', name: 'Alpha' } },
        }],
      });
    }
    throw new Error(`未处理请求：${url}`);
  }) as typeof fetch;

  const snapshot = await loadAdoContributions(
    { adoBase: 'http://ado/paging', pat: '', auth: 'none' },
    { range: { from: '2026-08-01', to: '2026-08-12' }, filters: {}, force: true },
  );

  assert.equal(pullRequestCalls, 2);
  assert.equal(snapshot.events.length, 101);
  assert.equal(snapshot.statuses[0]?.count, 101);
  assert.equal(snapshot.statuses[0]?.state, 'complete');
});

test('部分项目失败时只把 PR 覆盖标记为 partial', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) return adoJson(identity());
    if (url.includes('/_apis/projects')) {
      return adoJson({ value: [{ name: 'Alpha' }, { name: 'Beta' }] });
    }
    if (url.includes('/Alpha/_apis/git/pullrequests?')) {
      return adoJson({
        value: [{
          pullRequestId: 1,
          title: 'Visible PR',
          creationDate: '2026-08-10T08:00:00Z',
          repository: { id: 'r1', name: 'Repo', project: { name: 'Alpha' } },
        }],
      });
    }
    if (url.includes('/Beta/_apis/git/pullrequests?')) return adoJson({ message: 'denied' }, 403);
    throw new Error(`未处理请求：${url}`);
  }) as typeof fetch;

  const snapshot = await loadAdoContributions(
    { adoBase: 'http://ado/partial', pat: '', auth: 'none' },
    { range: { from: '2026-08-01', to: '2026-08-12' }, filters: {}, force: true },
  );

  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.statuses[0]?.state, 'partial');
  assert.match(snapshot.statuses[0]?.warnings.join('\n') ?? '', /Beta.*403/);
});

test('缓存按连接修订隔离，force 会重新统计 PR', async () => {
  let pullRequestCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) return adoJson(identity());
    if (url.includes('/_apis/projects')) return adoJson({ value: [{ name: 'Alpha' }] });
    if (url.includes('/_apis/git/pullrequests?')) {
      pullRequestCalls += 1;
      return adoJson({ value: [] });
    }
    throw new Error(`未处理请求：${url}`);
  }) as typeof fetch;

  const cfg = { adoBase: 'http://ado/cache', pat: '', auth: 'none' as const };
  const base = { range: { from: '2026-08-01', to: '2026-08-12' }, filters: {} };
  await loadAdoContributions(cfg, { ...base, connectionRevision: 1 });
  await loadAdoContributions(cfg, { ...base, connectionRevision: 1 });
  assert.equal(pullRequestCalls, 1);

  await loadAdoContributions(cfg, { ...base, connectionRevision: 2 });
  await loadAdoContributions(cfg, { ...base, connectionRevision: 2, force: true });
  assert.equal(pullRequestCalls, 3);
});
