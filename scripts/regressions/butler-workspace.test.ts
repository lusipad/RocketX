import assert from 'node:assert/strict';
import test from 'node:test';
import { buildButlerWorkspaceModel } from '../../apps/web/src/lib/butlerWorkspace';
import type { ButlerErrandRun } from '../../apps/web/src/lib/butlerErrands';
import type { StoredRoundsResult } from '../../apps/web/src/lib/butlerRoundsRunner';
import type { Routine } from '../../apps/web/src/stores/routines';
import type { Todo } from '../../apps/web/src/stores/todos';

const now = new Date(2026, 6, 28, 10, 0).getTime();

function errand(overrides: Partial<ButlerErrandRun> = {}): ButlerErrandRun {
  return {
    id: 'run-1',
    title: '核对发布风险',
    threadId: 'thread-1',
    workspaceRoot: 'D:\\Repos\\rocketchatx',
    workspaceName: 'RocketX',
    readOnly: true,
    startedAt: now - 60_000,
    status: 'running',
    approvals: [],
    traces: [],
    ...overrides,
  };
}

function todo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 'todo-1',
    note: '提交发布说明',
    done: false,
    createdAt: now - 86_400_000,
    ...overrides,
  };
}

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'routine-1',
    name: '发布守护',
    trigger: { kind: 'daily', time: '09:00' },
    delivery: 'today',
    enabled: true,
    createdAt: now - 86_400_000,
    runs: [],
    ...overrides,
  };
}

test('工作区把必须知道、决定、建议、委托、个人待办和定时健康分开投影', () => {
  const approvalRun = errand({
    status: 'awaiting-approval',
    approvals: [{
      id: 'approval-1',
      method: 'send_message',
      policy: {} as never,
      params: {},
      at: now,
    }],
  });
  const failedRoutine = routine({
    runs: [{ id: 'routine-run-1', at: now - 3_600_000, status: 'error', text: '连接失败' }],
  });
  const rounds: StoredRoundsResult = {
    generatedAt: new Date(now).toISOString(),
    checkedCount: 1,
    refTitles: { 'pr:248': 'PR #248 缺少回滚说明' },
    result: {
      summary: '发现一项',
      log: [],
      proposals: [],
      items: [{
        ref: 'pr:248',
        why: '发布窗口在今天',
        suggestedAction: '核对回滚步骤',
      }],
    },
  };

  const model = buildButlerWorkspaceModel({
    errands: [approvalRun],
    todos: [todo({ due: '2026-07-27', committedTo: '研发群' })],
    routines: [failedRoutine],
    eventCards: [{
      id: 'mention-1',
      kind: 'mention-stale',
      title: '@我未回应：研发',
      detail: '3 小时前有一条 @我',
      at: now - 10_800_000,
    }],
    rounds,
    now,
  });

  assert.deepEqual(
    model.needToKnow.map((item) => item.kind).sort(),
    ['overdue-commitment', 'routine-failure', 'stale-mention'],
  );
  assert.equal(model.decisions[0]?.run.id, approvalRun.id);
  assert.equal(model.suggestions[0]?.sourceRef, 'pr:248');
  assert.equal(model.delegations.length, 1);
  assert.equal(model.delegations[0]?.kind, 'errand');
  assert.equal(model.personalTasks.length, 1);
  assert.equal(model.personalTasks[0]?.kind, 'todo');
  assert.equal(model.routines[0]?.health, 'failing');
  assert.deepEqual(model.summary, {
    watched: 1,
    needsAttention: 4,
    activeDelegations: 0,
    routineFailures: 1,
    activationNeeded: false,
  });
});

test('建议遵守隐藏和三条上限，暂停的例行不制造虚假故障', () => {
  const rounds: StoredRoundsResult = {
    generatedAt: new Date(now).toISOString(),
    checkedCount: 5,
    refTitles: {},
    snoozedRefs: ['ref:2'],
    result: {
      summary: '建议',
      log: [],
      proposals: [],
      items: [1, 2, 3, 4, 5].map((value) => ({
        ref: `ref:${value}`,
        why: `原因 ${value}`,
        suggestedAction: `动作 ${value}`,
      })),
    },
  };
  const model = buildButlerWorkspaceModel({
    errands: [errand({ archivedAt: now })],
    todos: [todo({ done: true })],
    routines: [routine({
      enabled: false,
      runs: [{ id: 'failed', at: now, status: 'error', text: '旧错误' }],
    })],
    eventCards: [],
    rounds,
    now,
  });

  assert.deepEqual(model.suggestions.map((item) => item.sourceRef), ['ref:1', 'ref:3', 'ref:4']);
  assert.equal(model.delegations.length, 0);
  assert.equal(model.personalTasks.length, 0);
  assert.equal(model.needToKnow.length, 0);
  assert.equal(model.routines[0]?.health, 'paused');
  assert.equal(model.summary.needsAttention, 0);
  assert.equal(model.summary.activationNeeded, false);
});

test('paused errand 进入需要我分组，而不是被投影成 failed', () => {
  const pausedRun = errand({
    id: 'run-paused',
    status: 'paused',
    error: '等你确认下一步',
  });
  const model = buildButlerWorkspaceModel({
    errands: [pausedRun],
    todos: [],
    routines: [],
    eventCards: [],
    rounds: null,
    now,
  });

  assert.equal(model.delegations[0]?.state, 'needs-user');
  assert.equal(model.delegations[0]?.statusLabel, '等你确认下一步');
});

test('全新账号没有责任、建议和例行照看时进入首次价值引导', () => {
  const model = buildButlerWorkspaceModel({
    errands: [],
    todos: [],
    routines: [],
    eventCards: [],
    rounds: null,
    now,
  });

  assert.equal(model.summary.activationNeeded, true);
});
