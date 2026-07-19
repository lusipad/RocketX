import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveIterationProject } from '../../apps/web/src/lib/butlerPoller';
import {
  createVisibilityRoundHandler,
  evaluatePollerWake,
  maybeEveningRound,
  maybeWakeRound,
  type ButlerRoundTriggerStorage,
} from '../../apps/web/src/lib/butlerRoundsTriggers';
import { evaluateRules } from '../../apps/web/src/lib/butlerRules';
import type { Todo } from '../../apps/web/src/stores/todos';
import type { WorkItem } from '../../apps/web/src/stores/workbench';

class MemoryStorage implements ButlerRoundTriggerStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function todo(overrides: Partial<Todo>): Todo {
  return {
    id: 't1',
    title: '提交发布说明',
    done: false,
    createdAt: 1,
    ...overrides,
  };
}

function baseInput(todos: Todo[] = []) {
  return {
    todos,
    seenAlertIds: new Set<string>(),
    now: Date.parse('2026-07-19T12:00:00+08:00'),
  };
}

test('承诺今天到期只产出 immediate 安全网通知', () => {
  const alerts = evaluateRules(baseInput([
    todo({ due: '2026-07-19', committedTo: '发布组' }),
  ]));

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'commitment-due');
  assert.equal(alerts[0].level, 'immediate');
  assert.match(alerts[0].detail, /发布组/);
});

test('承诺逾期只产出 immediate 安全网通知', () => {
  const alerts = evaluateRules(baseInput([
    todo({ due: '2026-07-18', waitingFor: 'Alice' }),
  ]));

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'commitment-overdue');
  assert.equal(alerts[0].level, 'immediate');
});

test('承诺明天到期不再提前提醒', () => {
  assert.deepEqual(evaluateRules(baseInput([
    todo({ due: '2026-07-20', committedTo: '发布组' }),
  ])), []);
});

test('普通待办逾期和已完成承诺都不走安全网', () => {
  assert.deepEqual(evaluateRules(baseInput([
    todo({ id: 'ordinary', due: '2026-07-18' }),
    todo({ id: 'done', due: '2026-07-19', committedTo: '发布组', done: true }),
  ])), []);
});

test('构建失败、新高优和工作项只改标签都不再产生规则提醒', () => {
  const legacyFacts = {
    ...baseInput(),
    builds: [{ id: 1, definition: 'CI', project: 'Alpha', result: 'failed' }],
    workItems: [{
      id: 9,
      title: '只改标签',
      state: 'Active',
      priority: 1,
      assignedTo: 'me',
      changedDate: '2026-07-19T03:00:00Z',
      tags: ['new-label'],
    }],
    lastPollAt: Date.parse('2026-07-19T00:00:00Z'),
  };

  assert.deepEqual(evaluateRules(legacyFacts), []);
});

test('已经通知过的承诺不会重复派发', () => {
  const input = baseInput([todo({ due: '2026-07-19', committedTo: '发布组' })]);
  const [first] = evaluateRules(input);
  assert.ok(first);
  assert.deepEqual(evaluateRules({ ...input, seenAlertIds: new Set([first.id]) }), []);
});

function workItem(id: number, project: string, state = 'Active'): WorkItem {
  return {
    id,
    title: `工作项 ${id}`,
    type: 'Task',
    state,
    project,
    webUrl: `https://example.test/${id}`,
  };
}

test('迭代项目只在未完成工作项唯一归属一个项目时可解析', () => {
  assert.equal(resolveIterationProject([]), null);
  assert.equal(resolveIterationProject([workItem(1, 'Alpha')]), 'Alpha');
  assert.equal(resolveIterationProject([
    workItem(1, 'Alpha'),
    workItem(2, 'Beta', 'Closed'),
  ]), 'Alpha');
  assert.equal(resolveIterationProject([
    workItem(1, 'Alpha'),
    workItem(2, 'Beta'),
  ]), null);
});

function triggerRuntime(storage: MemoryStorage, runs: string[], lastRoundsAt: string | null = null) {
  return {
    storage,
    getState: () => ({ running: false, lastRoundsAt }),
    run: async (_now: Date, reason: string) => { runs.push(reason); },
  };
}

test('离开不足两小时不触发，超过两小时回来触发一轮', async () => {
  const runs: string[] = [];
  const storage = new MemoryStorage();
  const handler = createVisibilityRoundHandler(triggerRuntime(storage, runs));
  await handler('hidden', new Date('2026-07-19T09:00:00+08:00'));
  await handler('visible', new Date('2026-07-19T10:59:00+08:00'));
  assert.equal(runs.length, 0);

  await handler('hidden', new Date('2026-07-19T11:00:00+08:00'));
  await handler('visible', new Date('2026-07-19T13:01:00+08:00'));
  assert.equal(runs.length, 1);
  assert.match(runs[0], /离开超过 2 小时/);
});

test('晚间 18 点前不触发，18 点后当天只触发一次', async () => {
  const runs: string[] = [];
  const storage = new MemoryStorage();
  const runtime = triggerRuntime(storage, runs);
  // 晚间阈值是「本地 18 点」:用本地时间分量构造,任何时区的跑者语义一致
  // (CI 是 UTC,+08:00 字面量在那边 getHours() 是 9/10,曾让本地全绿、CI 全红)
  assert.equal(await maybeEveningRound(new Date(2026, 6, 19, 17, 59), runtime), false);
  assert.equal(await maybeEveningRound(new Date(2026, 6, 19, 18, 1), runtime), true);
  assert.equal(await maybeEveningRound(new Date(2026, 6, 19, 20, 0), runtime), false);
  assert.equal(runs.length, 1);
});

test('传感器首轮只建基线，新指派和构建转红分别产生叫醒原因', () => {
  const newItemStorage = new MemoryStorage();
  assert.equal(evaluatePollerWake(
    [workItem(1, 'Alpha')],
    [{ definition: 'CI', project: 'Alpha', result: 'succeeded', finishTime: '2026-07-19T01:00:00Z' }],
    newItemStorage,
  ), null);
  assert.match(evaluatePollerWake(
    [workItem(1, 'Alpha'), workItem(2, 'Alpha')],
    [{ definition: 'CI', project: 'Alpha', result: 'succeeded', finishTime: '2026-07-19T02:00:00Z' }],
    newItemStorage,
  ) ?? '', /#2/);

  const failedBuildStorage = new MemoryStorage();
  assert.equal(evaluatePollerWake(
    [],
    [{ definition: 'CI', project: 'Alpha', result: 'succeeded', finishTime: '2026-07-19T01:00:00Z' }],
    failedBuildStorage,
  ), null);
  assert.match(evaluatePollerWake(
    [],
    [{ definition: 'CI', project: 'Alpha', result: 'failed', finishTime: '2026-07-19T02:00:00Z' }],
    failedBuildStorage,
  ) ?? '', /CI.*转红/);
});

test('传感器叫醒每小时最多一次，并服从统一十分钟冷却', async () => {
  const rateRuns: string[] = [];
  const rateStorage = new MemoryStorage();
  const runtime = triggerRuntime(rateStorage, rateRuns);
  assert.equal(await maybeWakeRound('发现新指派工作项 #2', new Date('2026-07-19T10:00:00+08:00'), runtime), true);
  assert.equal(await maybeWakeRound('发现新指派工作项 #3', new Date('2026-07-19T10:59:00+08:00'), runtime), false);
  assert.equal(await maybeWakeRound('发现新指派工作项 #4', new Date('2026-07-19T11:01:00+08:00'), runtime), true);
  assert.equal(rateRuns.length, 2);

  const cooledRuns: string[] = [];
  const cooledStorage = new MemoryStorage();
  const cooled = triggerRuntime(cooledStorage, cooledRuns, '2026-07-19T10:55:00+08:00');
  assert.equal(await maybeWakeRound('流水线转红', new Date('2026-07-19T11:00:00+08:00'), cooled), false);
  assert.equal(await maybeEveningRound(new Date('2026-07-19T18:01:00+08:00'), {
    ...cooled,
    getState: () => ({ running: false, lastRoundsAt: '2026-07-19T17:55:00+08:00' }),
  }), false);
  assert.equal(cooledRuns.length, 0);
});
