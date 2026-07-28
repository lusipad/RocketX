import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeButlerAttentionState } from '../../apps/web/src/stores/butlerAttention';
import { buildButlerWorkspaceModel } from '../../apps/web/src/lib/butlerWorkspace';

test('注意力确认状态过滤损坏值、去重并限制历史长度', () => {
  const state = normalizeButlerAttentionState({
    acknowledgedNeedIds: [null, '', 'need:1', 'need:1', ...Array.from(
      { length: 210 },
      (_, index) => `need:${index + 2}`,
    )],
  });

  assert.equal(state.acknowledgedNeedIds.length, 200);
  assert.equal(new Set(state.acknowledgedNeedIds).size, 200);
  assert.equal(state.acknowledgedNeedIds.at(-1), 'need:211');
});

test('知道了只隐藏当前 Need to Know，不会关闭原任务', () => {
  const now = new Date(2026, 6, 28, 10).getTime();
  const todo = {
    id: 'commitment-1',
    note: '交付说明',
    committedTo: '研发群',
    due: '2026-07-27',
    done: false,
    createdAt: now - 86_400_000,
  };
  const first = buildButlerWorkspaceModel({
    errands: [],
    todos: [todo],
    routines: [],
    eventCards: [],
    rounds: null,
    now,
  });
  const needId = first.needToKnow[0]?.id;
  assert.ok(needId);

  const acknowledged = buildButlerWorkspaceModel({
    errands: [],
    todos: [todo],
    routines: [],
    eventCards: [],
    rounds: null,
    acknowledgedNeedIds: [needId],
    now,
  });
  assert.equal(acknowledged.needToKnow.length, 0);
  assert.equal(acknowledged.tasks.length, 1);
  assert.equal(acknowledged.tasks[0]?.todo?.done, false);
});

