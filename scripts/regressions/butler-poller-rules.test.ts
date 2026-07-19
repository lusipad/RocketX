import assert from 'node:assert/strict';
import test from 'node:test';
import { expressAlerts } from '../../apps/web/src/lib/butlerExpression';
import { evaluateRules, type ButlerAlert } from '../../apps/web/src/lib/butlerRules';
import type { WorkItem } from '../../apps/web/src/stores/workbench';

class MemoryStorage {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const localStorageMock = new MemoryStorage();
(globalThis as { localStorage?: MemoryStorage }).localStorage = localStorageMock;

function makeWorkItem(id: number, priority: number, changedDate: string, project = 'Alpha'): WorkItem {
  return {
    id,
    title: `工作项 ${id}`,
    type: '任务',
    state: '活动',
    priority,
    project,
    changedDate,
    webUrl: `https://ado.example/workitems/${id}`,
  };
}

function baseAlertsInput(overrides: Partial<Parameters<typeof evaluateRules>[0]> = {}) {
  return {
    todos: [],
    workItems: [],
    pullRequests: [],
    builds: [],
    adoAccount: '',
    iterationEndDate: null,
    seenAlertIds: new Set<string>(),
    now: Date.parse('2026-07-19T12:00:00+08:00'),
    ...overrides,
  };
}

test('首次启动只建立基线，不提醒历史存量 P1/P2', () => {
  const alerts = evaluateRules(baseAlertsInput({
    workItems: [
      makeWorkItem(1, 1, '2026-07-18T10:00:00Z'),
      makeWorkItem(2, 2, '2026-07-18T11:00:00Z'),
    ],
    lastPollAt: null,
  }));

  assert.equal(alerts.filter((alert) => alert.kind === 'new-high-priority').length, 0);
});

test('增量高优先级提醒区分 P1/P2，且 2 天后迭代文案准确', () => {
  const alerts = evaluateRules(baseAlertsInput({
    workItems: [
      makeWorkItem(11, 1, '2026-07-19T01:00:00Z'),
      makeWorkItem(12, 2, '2026-07-19T02:00:00Z'),
      { ...makeWorkItem(13, 3, '2026-07-19T03:00:00Z'), title: '不会提醒的 P3' },
    ],
    iterationEndDate: '2026-07-21',
    lastPollAt: Date.parse('2026-07-19T00:00:00Z'),
  }));

  const p1 = alerts.find((alert) => alert.id.startsWith('high-priority:11:'));
  const p2 = alerts.find((alert) => alert.id.startsWith('high-priority:12:'));
  const iteration = alerts.find((alert) => alert.kind === 'iteration-pressure');

  assert.ok(p1);
  assert.ok(p2);
  assert.equal(p1.level, 'immediate');
  assert.equal(p2.level, 'coffee');
  assert.equal(p2.detail, 'P2 · Alpha · 活动');
  assert.equal(p2.ctx?.priority, 2);
  assert.match(iteration?.title ?? '', /2 天后结束/);
});

test('P2 的随意语气文案不能伪装成 P1', () => {
  localStorageMock.clear();
  localStorageMock.setItem('rcx-butler-personality', JSON.stringify({
    verbosity: 2,
    depth: 3,
    tone: 5,
    urgency: 2,
  }));
  const [styled] = expressAlerts([
    {
      id: 'high-priority:12:2026-07-19T02:00:00Z',
      level: 'coffee',
      kind: 'new-high-priority',
      title: '高优先级工作项：#12 工作项 12',
      detail: 'P2 · Alpha · 活动',
      at: Date.now(),
      ctx: { name: '#12 工作项 12', priority: 2, subjectType: 'workitem' },
    } satisfies ButlerAlert,
  ]);

  assert.match(styled.title, /P2/);
  assert.doesNotMatch(styled.title, /P1/);
});

test('迭代项目只在唯一项目时才解析', async () => {
  const { resolveIterationProject } = await import('../../apps/web/src/lib/butlerPoller');

  assert.equal(resolveIterationProject([]), null);
  assert.equal(resolveIterationProject([
    makeWorkItem(21, 1, '2026-07-19T01:00:00Z', 'Alpha'),
    makeWorkItem(22, 2, '2026-07-19T02:00:00Z', 'Alpha'),
  ]), 'Alpha');
  assert.equal(resolveIterationProject([
    makeWorkItem(23, 1, '2026-07-19T01:00:00Z', 'Alpha'),
    makeWorkItem(24, 2, '2026-07-19T02:00:00Z', 'Beta'),
  ]), null);
});

test('活跃视图只保留已被轮询确认过的高优先级事件', async () => {
  const { filterActiveAlertsForView } = await import('../../apps/web/src/lib/butlerPoller');
  const alerts = evaluateRules(baseAlertsInput({
    workItems: [makeWorkItem(31, 2, '2026-07-19T02:00:00Z')],
    lastPollAt: 0,
  }));

  assert.equal(filterActiveAlertsForView(alerts, new Set()).length, 0);
  assert.deepEqual(
    filterActiveAlertsForView(alerts, new Set(alerts.map((alert) => alert.id))).map((alert) => alert.id),
    alerts.map((alert) => alert.id),
  );
});
