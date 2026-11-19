import assert from 'node:assert/strict';
import test from 'node:test';
import { createExternalActionExecutor, type ExternalActionDriver, type ExternalActionSpec } from '../../apps/web/src/agent/externalActionExecutor';
import type { NativeDispatchActionRecord } from '../../apps/web/src/platform/desktopCommands';

function fixture() {
  const actions = new Map<string, NativeDispatchActionRecord>();
  const messages = new Map<string, { id: string; rid: string; text: string }>();
  const history: string[] = [];
  let writes = 0;
  let revision = 3;
  let state = 'Active';
  let failSendAt = -1;
  let sendCalls = 0;
  let unknown = false;
  let requirementsVersion = 2;
  const driver: ExternalActionDriver = {
    prepare: async (spec, approved) => {
      const existing = [...actions.values()].find((a) => a.idempotencyKey === spec.operationId);
      if (existing) return existing;
      history.push('persist-intent');
      const action: NativeDispatchActionRecord = { id: spec.operationId, idempotencyKey: spec.operationId, todoId: spec.workId, actionKind: spec.kind, eventId: null, sessionId: null, specJson: JSON.stringify(spec), baselineMarker: null, state: approved ? 'prepared' : 'awaiting_approval', receiptRef: null, errorMessage: null, createdAt: 1, updatedAt: 1 };
      actions.set(action.id, action);
      return action;
    },
    transition: async (action, next, receipt, error) => {
      history.push(next);
      const updated = { ...actions.get(action.id)!, state: next, receiptRef: receipt ? JSON.stringify(receipt) : action.receiptRef, errorMessage: error ?? null };
      actions.set(action.id, updated);
      return updated;
    },
    validate: async (spec) => { if (spec.requirementsVersion !== requirementsVersion) throw new Error('要求版本已改变'); },
    writeAdo: async (spec) => {
      writes += 1;
      history.push('write');
      if (revision !== spec.expectedRevision || state !== spec.expectedState) throw new Error('版本冲突');
      state = spec.targetState;
      revision += 1;
      if (unknown) throw Object.assign(new Error('回执丢失'), { outcomeUnknown: true });
      return { revision, state };
    },
    readAdo: async () => ({ revision, state }),
    sendMessage: async (_spec, part) => {
      sendCalls += 1;
      if (sendCalls === failSendAt) throw new Error('网络断开');
      // 服务端以消息ID唯一创建，冲突时不覆盖旧内容。
      const existing = messages.get(part.id);
      if (existing) return existing;
      messages.set(part.id, { id: part.id, rid: 'room', text: part.text });
      return { id: part.id, rid: 'room', text: part.text };
    },
    readMessage: async (_spec, id) => messages.get(id) ?? null,
    isUnknownAdoError: (err) => !!(err as { outcomeUnknown?: boolean }).outcomeUnknown,
  };
  const base = { version: 1 as const, operationId: 'op', workId: 'work', requirementsVersion: 2, projectKey: 'project', actor: { userId: 'alice', server: 'https://chat', adoAccount: 'alice' }, createdAt: 1 };
  const ado: ExternalActionSpec = { ...base, kind: 'ado_state_write', adoBase: 'https://ado/collection', workItemId: 42, expectedRevision: 3, expectedState: 'Active', targetState: 'Resolved' };
  const report: ExternalActionSpec = { ...base, operationId: 'report', kind: 'rc_report', rid: 'room', reportId: 'r1', reportGeneratedAt: 1, reportTitle: '报告', parts: [{ id: 'm1', text: '第一段' }, { id: 'm2', text: '第二段' }] };
  return { driver, ado, report, actions, messages, history, setRevision: (n: number) => { revision = n; }, setUnknown: () => { unknown = true; }, setFailSendAt: (n: number) => { failSendAt = n; }, setRequirements: (n: number) => { requirementsVersion = n; }, counts: () => ({ writes, sendCalls }) };
}

test('外部写入先持久意图和发送态；同操作并发只写一次，成功后不重发', async () => {
  const f = fixture(); const executor = createExternalActionExecutor(f.driver);
  const results = await Promise.all([executor.execute(f.ado, true), executor.execute(f.ado, true)]);
  assert.equal(results[0].state, 'acknowledged');
  assert.equal(f.counts().writes, 1);
  assert.deepEqual(f.history.slice(0, 3), ['persist-intent', 'dispatched', 'write']);
  await executor.execute(f.ado, true);
  assert.equal(f.counts().writes, 1);
});

test('意图持久化失败绝不写入；审批和要求版本拦截', async () => {
  const f = fixture();
  const executor = createExternalActionExecutor(f.driver);
  assert.equal((await executor.execute(f.ado, false)).state, 'awaiting_approval');
  assert.equal(f.counts().writes, 0);
  f.setRequirements(3);
  await assert.rejects(executor.execute(f.ado, true), /要求版本/);
  assert.equal(f.counts().writes, 0);
  f.driver.prepare = async () => { throw new Error('disk full'); };
  await assert.rejects(createExternalActionExecutor(f.driver).execute(f.report, true), /disk full/);
  assert.equal(f.counts().sendCalls, 0);
});

test('ADO冲突不覆盖；unknown重启只回读，确认目标后登记回执', async () => {
  const f = fixture(); f.setRevision(4);
  assert.equal((await createExternalActionExecutor(f.driver).execute(f.ado, true)).state, 'failed');
  const g = fixture(); g.setUnknown();
  assert.equal((await createExternalActionExecutor(g.driver).execute(g.ado, true)).state, 'verifying_delivery');
  const resumed = createExternalActionExecutor(g.driver);
  assert.equal((await resumed.reconcile(g.actions.get('op')!)).state, 'acknowledged');
  assert.equal(g.counts().writes, 1);
});

test('ADO unknown且远端未确认成功时保持待确认，不盲重放', async () => {
  const f = fixture();
  f.driver.writeAdo = async () => { throw Object.assign(new Error('timeout'), { outcomeUnknown: true }); };
  const executor = createExternalActionExecutor(f.driver);
  const action = await executor.execute(f.ado, true);
  assert.equal((await executor.reconcile(action)).state, 'verifying_delivery');
  assert.equal((await executor.execute(f.ado, true)).state, 'verifying_delivery');
  assert.equal(f.counts().writes, 0);
});

test('汇报分段部分送达保留稳定ID；unknown只核对，不重发已有段', async () => {
  const f = fixture(); f.setFailSendAt(2);
  const first = await createExternalActionExecutor(f.driver).execute(f.report, true);
  assert.equal(first.state, 'verifying_delivery');
  assert.equal(f.messages.size, 1);
  const restarted = createExternalActionExecutor(f.driver);
  const checked = await restarted.reconcile(first);
  assert.equal(checked.state, 'verifying_delivery');
  assert.equal(f.counts().sendCalls, 2);
  f.messages.set('m2', { id: 'm2', rid: 'room', text: '第二段' });
  assert.equal((await restarted.reconcile(checked)).state, 'acknowledged');
  assert.equal(f.counts().sendCalls, 2);
});

test('同ID不同内容或房间不能被误认送达；冻结意图不能被新调用改写', async () => {
  const f = fixture(); f.messages.set('m1', { id: 'm1', rid: 'other', text: '第一段' });
  const executor = createExternalActionExecutor(f.driver);
  assert.equal((await executor.execute(f.report, true)).state, 'failed');
  assert.equal(f.counts().sendCalls, 1);
  assert.deepEqual(f.messages.get('m1'), { id: 'm1', rid: 'other', text: '第一段' });
  await assert.rejects(executor.execute({ ...f.report, workId: 'other' }, true), /操作身份/);
});

test('ADO已写入但回执持久化失败时保留发送态，重启回读后确认且不重复写', async () => {
  const f = fixture();
  const transition = f.driver.transition;
  f.driver.transition = async (action, state, receipt, error) => {
    if (state === 'acknowledged') throw new Error('receipt disk full');
    return transition(action, state, receipt, error);
  };
  await assert.rejects(createExternalActionExecutor(f.driver).execute(f.ado, true), /disk full/);
  assert.equal(f.actions.get('op')?.state, 'dispatched');
  f.driver.transition = transition;
  assert.equal((await createExternalActionExecutor(f.driver).reconcile(f.actions.get('op')!)).state, 'acknowledged');
  assert.equal(f.counts().writes, 1);
});

test('显式续投仅补尚未确认的汇报分段，不重发已送达部分', async () => {
  const f = fixture(); f.setFailSendAt(2);
  const executor = createExternalActionExecutor(f.driver);
  await executor.execute(f.report, true);
  assert.equal((await executor.execute(f.report, true, true)).state, 'acknowledged');
  assert.equal(f.counts().sendCalls, 3);
  assert.equal(f.messages.size, 2);
});

test('RC8.6.1不存在消息返回bare400时，首次CAS取得发送归属后可创建新消息', async () => {
  const f = fixture(); let reads = 0;
  f.driver.readMessage = async () => { reads += 1; throw Object.assign(new Error('HTTP 400: {success:false}'), { status: 400 }); };
  const action = await createExternalActionExecutor(f.driver).execute(f.report, true);
  assert.equal(action.state, 'acknowledged');
  assert.equal(f.counts().sendCalls, 2);
  assert.equal(reads, 0, '新操作的全新消息不依赖getMessage缺失时的非标准错误');
  assert.deepEqual(f.history.slice(0, 2), ['persist-intent', 'dispatched']);
});

test('unknown或部分送达续投遇bare400仍待确认，不能把权限/参数失败当作不存在重发', async () => {
  const f = fixture(); f.setFailSendAt(2);
  const executor = createExternalActionExecutor(f.driver);
  const initial = await executor.execute(f.report, true);
  assert.equal(initial.state, 'verifying_delivery');
  f.driver.readMessage = async (_spec, id) => {
    const message = f.messages.get(id);
    if (message) return message;
    throw Object.assign(new Error('HTTP 400: {success:false}'), { status: 400 });
  };
  assert.equal((await executor.reconcile(initial)).state, 'verifying_delivery');
  assert.equal((await executor.execute(f.report, true, true)).state, 'verifying_delivery');
  assert.equal(f.counts().sendCalls, 2);
  assert.equal(f.messages.size, 1);
});
