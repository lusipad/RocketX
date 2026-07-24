import assert from 'node:assert/strict';
import test from 'node:test';
import { directGetWorkItems, directRunSavedQuery } from '../../apps/web/src/lib/adoDirect';
import { workItemTreeRows } from '../../apps/web/src/lib/workItemTree';
import type { WorkItem } from '../../apps/web/src/stores/workbench';

const item = (id: number, parentId?: number): WorkItem => ({
  id,
  parentId,
  title: `工作项 ${id}`,
  type: 'Task',
  state: 'Active',
  project: 'RocketX',
  webUrl: `http://ado/RocketX/_workitems/edit/${id}`,
});

test('工作项按当前结果集的父子关系展开，孤立子项保持为根', () => {
  const items = [item(1), item(2, 1), item(3, 2), item(4, 99)];
  const rows = workItemTreeRows(items, new Set(items.map((entry) => entry.id)), new Set(), false);
  assert.deepEqual(
    rows.map((row) => [row.item.id, row.depth, row.hasChildren]),
    [[1, 0, true], [2, 1, true], [3, 2, false], [4, 0, false]],
  );
});

test('父项可折叠，筛选时仍展示命中项及祖先路径', () => {
  const items = [item(1), item(2, 1), item(3, 2), item(4)];
  assert.deepEqual(
    workItemTreeRows(items, new Set([1, 2, 3, 4]), new Set([1]), false).map((row) => row.item.id),
    [1, 4],
  );
  assert.deepEqual(
    workItemTreeRows(items, new Set([3]), new Set([1, 2]), true).map((row) => [row.item.id, row.depth]),
    [[1, 0], [2, 1], [3, 2]],
  );
});

test('直连工作项请求并映射 System.Parent', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes('/_apis/wit/wiql')
      ? { workItems: [{ id: 2 }] }
      : {
          value: [{
            id: 2,
            fields: {
              'System.Parent': 1,
              'System.Title': '子项',
              'System.WorkItemType': 'Task',
              'System.State': 'Active',
              'System.TeamProject': 'RocketX',
            },
          }],
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const cfg = { adoBase: 'http://ado/DefaultCollection', pat: '', auth: 'none' as const };
    const direct = await directGetWorkItems(cfg, '', 1);
    assert.equal(direct[0]?.parentId, 1);
    assert.equal(calls.filter((url) => url.includes('fields=') && url.includes('System.Parent')).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('树查询先去重再应用结果上限，重复关系不会挤掉后续工作项', async () => {
  const originalFetch = globalThis.fetch;
  let detailUrl = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/wit/wiql/')) {
      return new Response(JSON.stringify({
        workItemRelations: [
          { target: { id: 2 } },
          { target: { id: 2 } },
          { target: { id: 3 } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    detailUrl = url;
    return new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await directRunSavedQuery(
      { adoBase: 'http://ado/DefaultCollection', pat: '', auth: 'none' },
      'query-id',
      undefined,
      2,
    );
    assert.match(detailUrl, /ids=2,3(?:&|$)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
