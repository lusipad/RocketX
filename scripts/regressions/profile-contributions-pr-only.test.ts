import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAdoContributions } from '../../apps/web/src/lib/adoContributions';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('我的贡献只统计当前用户创建的 ADO PR，不扫描仓库和其他活动（issue #298）', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/_apis/connectionData')) {
      return Response.json({
        authenticatedUser: {
          id: 'user-1',
          customDisplayName: 'Alice',
          properties: { Account: { $value: 'corp\\alice' } },
        },
      });
    }
    if (url.includes('/_apis/projects')) {
      return Response.json({ value: [{ id: 'project-1', name: 'Alpha' }] });
    }
    if (url.includes('/Alpha/_apis/git/pullrequests?')) {
      return Response.json({
        value: [{
          pullRequestId: 101,
          title: 'Improve contribution profile',
          creationDate: '2026-08-10T08:00:00Z',
          repository: { id: 'repo-a', name: 'RepoA', project: { id: 'project-1', name: 'Alpha' } },
        }],
      });
    }
    throw new Error(`不应请求：${url}`);
  }) as typeof fetch;

  const snapshot = await loadAdoContributions(
    { adoBase: 'http://ado', pat: 'secret', auth: 'none' },
    {
      range: { from: '2026-08-01', to: '2026-08-12' },
      filters: {},
      force: true,
    },
  );

  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.type, 'pull-request');
  assert.deepEqual(snapshot.statuses.map((status) => status.type), ['pull-request']);
  assert.equal(requests.some((url) => /repositories\?|\/commits\?|\/threads\?|\/_apis\/wit\//.test(url)), false);
});
