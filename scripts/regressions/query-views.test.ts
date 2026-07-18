import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '../../apps/web/src/stores/workbench';
import { boardColumns, wbsStats, wbsSummary, workItemRisk } from '../../apps/web/src/lib/queryViews';
import { updateWorkItemStateRequest } from '../../apps/web/src/lib/adoDirect';

const TODAY = '2026-07-18';

function item(overrides: Partial<WorkItem> & { id: number }): WorkItem {
  return {
    title: `工作项 ${overrides.id}`,
    type: 'Task',
    state: 'Active',
    project: 'Alpha',
    webUrl: `http://ado/_workitems/edit/${overrides.id}`,
    ...overrides,
  };
}

test('看板列按 新建→进行中→已解决→完成 归类排序，中英文状态都认（issue #82）', () => {
  const columns = boardColumns(
    [
      item({ id: 1, state: '已关闭' }),
      item({ id: 2, state: 'Active' }),
      item({ id: 3, state: 'New' }),
      item({ id: 4, state: '已解决' }),
      item({ id: 5, state: 'Active' }),
      item({ id: 6, state: '自定义状态' }),
    ],
    TODAY,
  );

  assert.deepEqual(
    columns.map((c) => c.state),
    ['New', 'Active', '已解决', '已关闭', '自定义状态'],
  );
  assert.deepEqual(columns.find((c) => c.state === 'Active')?.items.map((w) => w.id), [2, 5]);
});

test('看板列内逾期卡片排最前，然后按截止日和优先级', () => {
  const columns = boardColumns(
    [
      item({ id: 1, priority: 1 }),
      item({ id: 2, dueDate: '2026-07-20T00:00:00Z' }),
      item({ id: 3, dueDate: '2026-07-10T00:00:00Z' }),
      item({ id: 4 }),
    ],
    TODAY,
  );

  assert.deepEqual(columns[0].items.map((w) => w.id), [3, 2, 1, 4]);
});

test('风险信号：逾期/停滞/未指派只对未完成项生效（issue #83）', () => {
  const opts = { today: TODAY, staleDays: 7 };
  const overdueItem = item({ id: 1, dueDate: '2026-07-01T00:00:00Z', assignedTo: 'alice', changedDate: '2026-07-17T00:00:00Z' });
  assert.deepEqual(workItemRisk(overdueItem, opts), { overdue: true, stale: false, unassigned: false });

  const staleItem = item({ id: 2, assignedTo: 'alice', changedDate: '2026-07-01T00:00:00Z' });
  assert.deepEqual(workItemRisk(staleItem, opts), { overdue: false, stale: true, unassigned: false });

  const unassignedItem = item({ id: 3, changedDate: '2026-07-17T00:00:00Z' });
  assert.deepEqual(workItemRisk(unassignedItem, opts), { overdue: false, stale: false, unassigned: true });

  // 已完成：即使截止日已过、很久没更新、没负责人，都不算风险
  const doneItem = item({ id: 4, state: '已关闭', dueDate: '2026-07-01T00:00:00Z', changedDate: '2026-06-01T00:00:00Z' });
  assert.deepEqual(workItemRisk(doneItem, opts), { overdue: false, stale: false, unassigned: false });
});

test('WBS 子树汇总：进度和风险沿父子链向上累计', () => {
  const opts = { today: TODAY, staleDays: 7 };
  const items = [
    item({ id: 10, type: 'Feature', assignedTo: 'alice', changedDate: '2026-07-17T00:00:00Z' }),
    item({ id: 11, type: 'User Story', parentId: 10, assignedTo: 'alice', changedDate: '2026-07-17T00:00:00Z' }),
    item({ id: 12, parentId: 11, state: 'Closed', assignedTo: 'alice' }),
    item({ id: 13, parentId: 11, dueDate: '2026-07-01T00:00:00Z', assignedTo: 'alice', changedDate: '2026-07-17T00:00:00Z' }),
    // 父项不在查询结果里：当根算，不影响其它子树
    item({ id: 20, parentId: 999, changedDate: '2026-07-17T00:00:00Z' }),
  ];
  const stats = wbsStats(items, opts);

  assert.deepEqual(stats.get(11), { total: 3, done: 1, overdue: 1, stale: 0, unassigned: 0 });
  assert.deepEqual(stats.get(10), { total: 4, done: 1, overdue: 1, stale: 0, unassigned: 0 });
  assert.deepEqual(stats.get(20), { total: 1, done: 0, overdue: 0, stale: 0, unassigned: 1 });

  const summary = wbsSummary(items, opts);
  assert.deepEqual(summary, { total: 5, done: 1, overdue: 1, stale: 0, unassigned: 1 });
});

test('看板拖拽改状态走 json-patch，只改 System.State 一个字段', () => {
  const request = updateWorkItemStateRequest(123, '已解决');

  assert.equal(request.path, '/_apis/wit/workitems/123?api-version=7.0');
  assert.equal(request.contentType, 'application/json-patch+json');
  assert.deepEqual(request.body, [{ op: 'add', path: '/fields/System.State', value: '已解决' }]);

  assert.throws(() => updateWorkItemStateRequest(0, 'Active'), /编号无效/);
  assert.throws(() => updateWorkItemStateRequest(123, '  '), /不能为空/);
});

test('脏数据里的父子环不会死循环', () => {
  const items = [
    item({ id: 1, parentId: 2, changedDate: '2026-07-17T00:00:00Z', assignedTo: 'a' }),
    item({ id: 2, parentId: 1, changedDate: '2026-07-17T00:00:00Z', assignedTo: 'a' }),
  ];
  const stats = wbsStats(items, { today: TODAY });
  assert.ok(stats.get(1));
  assert.ok(stats.get(2));
});
