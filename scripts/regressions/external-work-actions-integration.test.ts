import assert from 'node:assert/strict';
import test from 'node:test';
import { RcApiError } from '@rcx/rc-client';
import type { NativeWorkCard } from '../../apps/web/src/platform/desktopCommands';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useChat } from '../../apps/web/src/stores/chat';
import { rest } from '../../apps/web/src/lib/client';
import { publishWorkReport, reconcileExternalWorkActions, syncWorkAdoState, withExternalActionDeadline } from '../../apps/web/src/agent/externalWorkActions';
import { buildWorkflowExecutionReport, recordReportAsWorkEvidence } from '../../apps/web/src/agent/workflowReport';

const data = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, String(value)),
  removeItem: (key: string) => data.delete(key), clear: () => data.clear(), key: (i: number) => [...data.keys()][i] ?? null,
  get length() { return data.size; },
} });
const originalFetch = globalThis.fetch;
const originalSend = rest.sendMessageRaw;
const originalGet = rest.getMessage;
const originalRequest = rest.request;
let sent = new Map<string, { _id: string; rid: string; msg: string }>();
let sendCount = 0;
let patchCount = 0;

function setup(autonomyMode: NativeWorkCard['state']['autonomyMode'] = 'autonomous', visibility: NativeWorkCard['state']['visibility'] = 'room_shared') {
  data.clear(); sent = new Map(); sendCount = 0; patchCount = 0;
  data.set('rcx-server', 'https://chat.test');
  data.set('rcx-workbench', JSON.stringify({ adoBase: 'https://ado.test/collection', auth: 'none', account: 'alice' }));
  useAuth.setState({ status: 'authed', localMode: false, user: { _id: 'alice', username: 'alice' } });
  useChat.setState({ subscriptions: { room: { rid: 'room', name: '团队' } as never } });
  const card = {
    id: 'work', title: '工作', rid: 'room', adoWorkItemId: 42,
    state: { requirementsVersion: 2, contentVersion: 1, projectKey: 'project', visibility, autonomyMode, waitState: 'none', stage: 'verifying', goal: '完成测试', acceptance: ['测试通过'], autoTurnsUsed: 0, maxAutoTurns: 20, consecutiveFailures: 0, boundaries: [], dependsOn: [] },
  } as unknown as NativeWorkCard;
  useWorkLedger.setState({ cards: [card], actions: [], evidences: [], sessions: [], links: [], events: [], hydrated: true });
  rest.getMessage = async (id: string) => {
    const message = sent.get(id);
    if (!message) throw new RcApiError('not found', 404);
    return message as never;
  };
  rest.sendMessageRaw = async (message) => {
    sendCount += 1;
    const raw = { _id: message._id!, rid: message.rid, msg: message.msg! };
    sent.set(raw._id, raw);
    return raw as never;
  };
  // Settings read only; all message/ADO mutations are captured by this test.
  rest.request = async () => ({ settings: [{ _id: 'Message_MaxAllowedSize', value: 5000 }] }) as never;
  globalThis.fetch = (async () => new Response(JSON.stringify({ settings: [{ _id: 'Message_MaxAllowedSize', value: 5000 }] }), { status: 200 })) as typeof fetch;
  return card;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  rest.sendMessageRaw = originalSend; rest.getMessage = originalGet; rest.request = originalRequest;
});

function reportInput() { return { workId: 'work', rid: 'room', reportId: 'report-one', reportTitle: '报告', reportGeneratedAt: 1, markdown: '通过测试；ADO 待同步' }; }

test('实际汇报API持久化快照及回执，重复操作不发第二条', async () => {
  setup();
  const first = await publishWorkReport(reportInput());
  assert.equal(first.state, 'acknowledged');
  assert.equal(sendCount, 1);
  const snapshot = JSON.parse(first.specJson);
  assert.equal(snapshot.requirementsVersion, 2);
  assert.equal(snapshot.actor.userId, 'alice');
  assert.equal(snapshot.parts[0].text, '通过测试；ADO 待同步');
  assert.ok(data.get('rc_work_ledger_v1')?.includes(snapshot.parts[0].id));
  await publishWorkReport({ ...reportInput(), markdown: '后来的变化不能改写旧汇报' });
  assert.equal(sendCount, 1);
});

test('私人工作不能由Agent自动外发，明确审阅可以投递指定快照', async () => {
  setup('autonomous', 'private');
  assert.equal((await publishWorkReport(reportInput())).state, 'awaiting_approval');
  assert.equal(sendCount, 0);
  // Pending draft must be recreated with explicit review of its frozen snapshot.
  const action = useWorkLedger.getState().actions[0];
  assert.equal(action.state, 'awaiting_approval');
  const reviewed = await publishWorkReport({ ...reportInput(), userConfirmed: true });
  assert.equal(reviewed.state, 'acknowledged');
  assert.equal(sendCount, 1);
});

test('账号切换及未加入目标讨论室不会外发', async () => {
  setup();
  useChat.setState({ subscriptions: {} });
  await assert.rejects(publishWorkReport(reportInput()), /未加入/);
  assert.equal(sendCount, 0);
  setup('confirm');
  await publishWorkReport(reportInput());
  useAuth.setState({ user: { _id: 'bob', username: 'bob' } as never });
  const action = useWorkLedger.getState().actions[0];
  const { executePreparedExternalAction } = await import('../../apps/web/src/agent/externalWorkActions');
  await assert.rejects(executePreparedExternalAction(action.id, true), /账号/);
  assert.equal(sendCount, 0);
});

test('ADO真实受控接口保持expectedRevision并回读，汇报失败不撤销已同步状态', async () => {
  setup(); let revision = 7; let state = 'Active';
  await useWorkLedger.getState().addEvidence({ todoId: 'work', sessionId: null, kind: 'test_run', title: '受控测试结果', summary: '模拟验证结果', passed: true, headSha: null, workspaceRoot: null, webUrl: null, requirementsVersion: 2, contentVersion: 1, criterionIds: ['测试通过'] });
  globalThis.fetch = (async (_input, init) => {
    if (String(_input).includes('settings.public')) return new Response(JSON.stringify({ settings: [{ _id: 'Message_MaxAllowedSize', value: 5000 }] }), { status: 200 });
    if (init?.method === 'PATCH') {
      patchCount += 1;
      assert.deepEqual(JSON.parse(String(init.body))[0], { op: 'test', path: '/rev', value: 7 });
      state = 'Resolved'; revision = 8;
      return new Response(JSON.stringify({ id: 42, rev: revision, fields: { 'System.State': state } }), { status: 200 });
    }
    return new Response(JSON.stringify({ value: [{ id: 42, rev: revision, fields: { 'System.State': state, 'System.TeamProject': 'project' } }] }), { status: 200 });
  }) as typeof fetch;
  const ado = await syncWorkAdoState({ workId: 'work', operationId: 'resolve', expectedRevision: 7, expectedState: 'Active', targetState: 'Resolved' });
  assert.equal(ado.state, 'acknowledged');
  rest.sendMessageRaw = async () => { throw new Error('network unavailable'); };
  const report = await publishWorkReport(reportInput());
  assert.equal(report.state, 'verifying_delivery');
  await reconcileExternalWorkActions();
  assert.equal(patchCount, 1);
  assert.equal(useWorkLedger.getState().actions.find((a) => a.id === ado.id)?.state, 'acknowledged');
});

test('验收失败不能将ADO变成完成；过期汇报不外发', async () => {
  setup();
  await assert.rejects(syncWorkAdoState({ workId: 'work', operationId: 'resolve', expectedRevision: 7, expectedState: 'Active', targetState: 'Resolved' }), /尚未通过验收/);
  assert.equal(patchCount, 0);
  await assert.rejects(publishWorkReport({ ...reportInput(), requirementsVersion: 1 }), /工作已改变/);
  assert.equal(sendCount, 0);
});

test('工作汇报只保存说明记录，核验中及完成状态均不能自证验收', async () => {
  const card = setup();
  for (const stage of ['verifying', 'done'] as const) {
    card.state.stage = stage;
    const report = buildWorkflowExecutionReport({ card });
    const evidence = await recordReportAsWorkEvidence('work', report);
    assert.equal(evidence.kind, 'agent_report');
    assert.equal(evidence.passed, false);
  }
  await assert.rejects(recordReportAsWorkEvidence('other-work', buildWorkflowExecutionReport({ card })), /归属/);
});

test('发送或回读无响应会结束等待，不能返回已送达', async () => {
  await assert.rejects(withExternalActionDeadline(new Promise(() => {}), 5), /超时.*待回读/);
});
