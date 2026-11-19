import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionStopReason,
  createMessageWatermarks,
  createWorkSupervisor,
  runWorkspaceDispatch,
} from '../../apps/web/src/agent/workSupervisor';
import type { NativeDispatchActionRecord, NativeWorkCard, NativeWorkLedgerSnapshot } from '../../apps/web/src/platform/desktopCommands';

function card(id = 'work-1', overrides: Record<string, unknown> = {}): NativeWorkCard {
  return { id, title: id, done: false, state: {
    todoId: id, requirementsVersion: 1, contentVersion: 1, goal: '完成修复', acceptance: ['测试通过'],
    stage: 'in_progress', waitState: 'none', waitReason: null, autonomyMode: 'autonomous',
    dependsOn: [], nextCheckAt: null, maxAutoTurns: 3, autoTurnsUsed: 0, consecutiveFailures: 0,
    revokedAt: null, updatedAt: 1, ...overrides,
  } } as NativeWorkCard;
}
function action(overrides: Partial<NativeDispatchActionRecord> = {}): NativeDispatchActionRecord {
  return { id: 'action-1', todoId: 'work-1', actionKind: 'session_prompt', state: 'prepared',
    specJson: JSON.stringify({ requirementsVersion: 1, contentVersion: 1, specText: '检查' }),
    createdAt: 10, ...overrides } as NativeDispatchActionRecord;
}
function snapshot(cards = [card()]): NativeWorkLedgerSnapshot {
  return { cards, sessions: [], actions: [], events: [], links: [], evidences: [] };
}

test('旧版本、无版本、暂停、撤销、截止、普通待办均不能继续执行', () => {
  assert.equal(actionStopReason(card(), action(), 20), null);
  assert.match(actionStopReason(card('work-1', { requirementsVersion: 2 }), action(), 20)!, /要求版本/);
  assert.match(actionStopReason(card(), action({ specJson: '{}' }), 20)!, /版本/);
  assert.match(actionStopReason(card('work-1', { waitState: 'paused' }), action(), 20)!, /暂停/);
  assert.match(actionStopReason(card('work-1', { revokedAt: 11 }), action(), 20)!, /撤销/);
  assert.match(actionStopReason(card('work-1', { deadlineAt: 20 }), action(), 20)!, /截止/);
  assert.match(actionStopReason(card('work-1', { requirementsVersion: 0 }), action(), 20)!, /未纳入/);
  assert.match(actionStopReason(card(), action({ state: 'verifying_delivery' }), 20)!, /待派发/);
});

test('收件水位：首次历史只建基线，重启补偿新事件、同毫秒事件且重复不重投', async () => {
  let persisted: Record<string, { at: number; ids: string[] }> = {};
  const seen: string[] = [];
  const options = { read: () => persisted, write: (next: typeof persisted) => { persisted = structuredClone(next); }, now: () => 10,
    ingest: async (message: { id: string; at: number }) => { seen.push(message.id); } };
  let inbox = createMessageWatermarks(options);
  await inbox.observe('room', [{ id: 'old', at: 1 }]);
  assert.deepEqual(seen, []);
  await inbox.observe('room', [{ id: 'new', at: 11 }]);
  inbox = createMessageWatermarks(options);
  await inbox.observe('room', [{ id: 'old', at: 1 }, { id: 'new', at: 11 }, { id: 'late', at: 11 }, { id: 'newer', at: 12 }]);
  await inbox.observe('room', [{ id: 'newer', at: 12 }]);
  assert.deepEqual(seen, ['new', 'late', 'newer']);
});

test('收件失败不推进持久水位，重试由事件幂等身份消重', async () => {
  let persisted = { room: { at: 10, ids: [] as string[] } };
  let fail = true;
  const inbox = createMessageWatermarks({ read: () => persisted, write: (next) => { persisted = next as typeof persisted; }, now: () => 10,
    ingest: async () => { if (fail) throw new Error('落盘失败'); } });
  await assert.rejects(inbox.observe('room', [{ id: 'new', at: 11 }]), /落盘/);
  assert.equal(persisted.room.at, 10);
  fail = false;
  await inbox.observe('room', [{ id: 'new', at: 11 }]);
  assert.equal(persisted.room.at, 11);
});

test('未加载历史的房间首条实时消息也会持久收件', async () => {
  let persisted = {};
  const seen: string[] = [];
  const inbox = createMessageWatermarks({ read: () => persisted, write: (next) => { persisted = next; }, now: () => 100,
    ingest: async (message: { id: string; at: number }) => { seen.push(message.id); } });
  await inbox.observe('new-room', [{ id: 'live', at: 99 }], false);
  assert.deepEqual(seen, ['live']);
});

test('同一工作区单写，不同工作区最多两路，排队原因可见', async () => {
  const release: Array<() => void> = [];
  const started: string[] = [];
  const queued: string[] = [];
  const run = (id: string, workspaceRoot: string) => runWorkspaceDispatch({ actionId: id, workspaceRoot }, async () => {
    started.push(id);
    await new Promise<void>((resolve) => release.push(resolve));
  }, (reason) => { if (reason) queued.push(`${id}:${reason}`); });
  const a = run('a', 'D:/repo');
  const b = run('b', 'd:\\repo');
  const c = run('c', '/project-c');
  const d = run('d', '/project-d');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(started, ['a', 'c']);
  assert.ok(queued.some((item) => item.startsWith('b:') && /工作区/.test(item)));
  assert.ok(queued.some((item) => item.startsWith('d:') && /并发/.test(item)));
  release.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(started.includes('b'));
  release.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 5));
  while (release.length) release.shift()!();
  await Promise.all([a, b, c, d]);
});

function supervisorHarness(initial: NativeWorkLedgerSnapshot) {
  const current = initial;
  const dispatched: string[] = [];
  const notified: string[] = [];
  const notices: Record<string, string> = {};
  const supervisor = createWorkSupervisor({
    snapshot: () => current, now: () => 100,
    updateCard: async (id, patch) => { const item = current.cards.find((c) => c.id === id)!; Object.assign(item.state, patch); return item; },
    prepare: async (input) => {
      const existing = current.actions.find((a) => a.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;
      const created = action({ ...input, id: `action-${current.actions.length}`, state: input.requireConfirmation ? 'awaiting_approval' : 'prepared' });
      current.actions.push(created); return created;
    },
    transition: async (input) => { const item = current.actions.find((a) => a.id === input.id)!; Object.assign(item, input); return item; },
    execute: async (item) => { dispatched.push(item.id); item.state = 'acknowledged'; },
    notify: async (item, reason) => { notified.push(`${item.id}:${reason}`); },
    readNotices: () => notices, writeNotices: (value) => {
      for (const key of Object.keys(notices)) delete notices[key];
      Object.assign(notices, value);
    },
  });
  return { current, supervisor, dispatched, notified };
}

test('后台恢复只执行prepared，unknown保持待核对，重复tick不重复派发', async () => {
  const state = snapshot();
  state.actions = [action(), action({ id: 'unknown', todoId: 'other-work', state: 'verifying_delivery' })];
  const h = supervisorHarness(state);
  await h.supervisor.tick(); await h.supervisor.tick();
  assert.deepEqual(h.dispatched, ['action-1']);
  assert.equal(state.actions[1].state, 'verifying_delivery');
});

test('同一工作有未知结果时，后续prepared保留排队而不越过核对', async () => {
  const h = supervisorHarness(snapshot());
  h.current.actions = [action(), action({ id: 'unknown', state: 'verifying_delivery' })];
  await h.supervisor.tick();
  assert.deepEqual(h.dispatched, []);
  assert.match(h.current.actions[0].errorMessage!, /送达结果待核对/);
});

test('预算耗尽和截止仅转需人处理、去重通知，不继续新派发', async () => {
  const h = supervisorHarness(snapshot([card('budget', { autoTurnsUsed: 3, nextCheckAt: 90 }), card('deadline', { deadlineAt: 100 })]));
  await h.supervisor.tick(); await h.supervisor.tick();
  assert.deepEqual(h.dispatched, []);
  assert.equal(h.current.cards[0].state.waitState, 'waiting_input');
  assert.equal(h.current.cards[1].state.waitState, 'waiting_input');
  assert.equal(h.notified.length, 2);
});

test('无变化保持静默，已解决后再次出现的需人状态会重新提醒', async () => {
  const h = supervisorHarness(snapshot([card('work', { waitState: 'waiting_input', waitReason: '需要选择执行环境' })]));
  await h.supervisor.tick(); await h.supervisor.tick();
  assert.equal(h.notified.length, 1);
  h.current.cards[0].state.waitState = 'none';
  await h.supervisor.tick();
  h.current.cards[0].state.waitState = 'waiting_input';
  await h.supervisor.tick();
  assert.equal(h.notified.length, 2);
});

test('等待复查和依赖完成唤醒只生成同身份的一次检查，未纳入待办不执行', async () => {
  const h = supervisorHarness(snapshot([
    card('timed', { waitState: 'waiting_external', nextCheckAt: 90 }),
    card('dependency', { waitState: 'waiting_external', dependsOn: ['done'] }),
    card('done', { stage: 'done' }), card('todo', { requirementsVersion: 0, nextCheckAt: 90 }),
  ]));
  h.current.sessions = ['timed', 'dependency'].map((todoId) => ({ id: `session-${todoId}`, todoId,
    workspaceRoot: `/workspace/${todoId}`, controlMode: 'controllable', runtimeStatus: 'idle' } as NativeWorkLedgerSnapshot['sessions'][number]));
  await h.supervisor.tick(); await h.supervisor.tick();
  assert.equal(h.current.actions.length, 2);
  assert.equal(h.dispatched.length, 2);
  assert.ok(h.current.actions.every((a) => a.todoId !== 'todo'));
});

test('排队时改口或取消的旧动作被取消，停止后不再派发', async () => {
  const h = supervisorHarness(snapshot([card('work-1', { requirementsVersion: 2 })]));
  h.current.actions = [action()];
  await h.supervisor.tick();
  assert.equal(h.current.actions[0].state, 'canceled');
  h.supervisor.stop();
  h.current.actions.push(action({ id: 'new', specJson: JSON.stringify({ requirementsVersion: 2, contentVersion: 1 }) }));
  await h.supervisor.tick();
  assert.deepEqual(h.dispatched, []);
});

test('NativeHost 工作的事件、复查、预算与 prepared 命令均不进入旧监督器', async () => {
  const h = supervisorHarness(snapshot([card('work-1', { nextCheckAt: 90, deadlineAt: 100, autoTurnsUsed: 3 })]));
  h.current.sessions = [{ id: 'host', todoId: 'work-1', controlMode: 'readonly',
    configSnapshotJson: JSON.stringify({ nativeHost: { schema: 'rocketx.native-codex-binding.v1', owner: 'native_host', bindingVersion: 1 } }),
  } as NativeWorkLedgerSnapshot['sessions'][number]];
  h.current.actions = [action({ idempotencyKey: 'native-codex:v1:request', specJson: JSON.stringify({
    schema: 'rocketx.native-codex-command.v1', executor: 'native_host', expected: { requirementsVersion: 1, contentVersion: 1 },
  }) }), action({ id: 'legacy-prepared', sessionId: 'host' })];
  h.current.events = [{ id: 'event', todoId: 'work-1', status: 'correlated', occurredAt: 90 } as NativeWorkLedgerSnapshot['events'][number]];
  const before = structuredClone(h.current);
  await h.supervisor.tick(); await h.supervisor.tick();
  assert.deepEqual(h.current, before);
  assert.deepEqual(h.dispatched, []);
  assert.deepEqual(h.notified, []);
});

test('未知版本 NativeHost 命令即使尚无绑定投影，也不能被旧监督器取消或执行', async () => {
  const h = supervisorHarness(snapshot());
  h.current.actions = [action({ specJson: JSON.stringify({ schema: 'rocketx.native-codex-command.v2' }) })];
  await h.supervisor.tick();
  assert.equal(h.current.actions[0].state, 'prepared');
  assert.deepEqual(h.dispatched, []);
});
