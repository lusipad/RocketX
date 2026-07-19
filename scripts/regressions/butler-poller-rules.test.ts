import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveIterationProject } from '../../apps/web/src/lib/butlerPoller';
import { evaluateRules } from '../../apps/web/src/lib/butlerRules';
import type { Todo } from '../../apps/web/src/stores/todos';
import type { WorkItem } from '../../apps/web/src/stores/workbench';

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
