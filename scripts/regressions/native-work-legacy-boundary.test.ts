import assert from 'node:assert/strict';
import test from 'node:test';
import { isNativeHostAction, isNativeHostSession } from '../../apps/web/src/lib/nativeWorkOwnership';
import { beginButlerAccountSelection } from '../../apps/web/src/platform/butlerAccountReady';
import type { NativeDispatchActionRecord, NativeWorkSessionRecord } from '../../apps/web/src/platform/desktopCommands';
import type { NativeWorkSnapshot } from '../../apps/web/src/platform/nativeWorkRuntime';
import { useTodos } from '../../apps/web/src/stores/todos';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';
import { useSharedAgent } from '../../apps/web/src/stores/sharedAgent';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { agentDeviceId } from '../../apps/web/src/agent/device';
import { resolveButlerAccountScope } from '../../apps/web/src/stores/butlerMemory';
import {
  executeSuperAgentDispatch, getSuperAgentRuntimeDrivers, openOrResumeWorkSession, pauseCardAcpWorkflow,
  setSuperAgentRuntimeDriversForTests, spawnCardWorkerInWorktree, steerAcpSessionForCard, syncLiveSessionsIntoLedger,
} from '../../apps/web/src/agent/superAgentBridge';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
const config = JSON.stringify({ provider: 'codex', executionProfileId: 'profile', preview: '原有摘要', nativeHost: {
  schema: 'rocketx.native-codex-binding.v1', owner: 'native_host', bindingVersion: 7,
} });
let generation = 0;

async function reset() {
  storage.clear();
  useAuth.setState({ localMode: true, status: 'authed', user: { _id: 'native-boundary', username: 'native-boundary' } as never });
  useSharedAgent.setState({ sessions: {} });
  useAcpAgents.setState({ sessions: {} });
  useCodexWorkspace.setState({ threads: [], threadStates: {} });
  useTodos.setState({ todos: [{ id: 'work', title: '原工作', source: 'manual', done: false, createdAt: 1 }] });
  useWorkLedger.setState({ cards: [], sessions: [], links: [], evidences: [], events: [], actions: [] });
  useWorkLedger.getState().syncWithTodos();
  await useWorkLedger.getState().updateCard('work', { enroll: true, goal: '继续原工作', acceptance: ['原工作验证通过'] });
  const accountScope = resolveButlerAccountScope();
  beginButlerAccountSelection(accountScope).activate({ accountScope, generation: ++generation });
  const session = { id: 'host-session', todoId: 'work', runtime: 'acp', origin: 'native_cli', visibility: 'private',
    nativeSessionId: 'original-thread', sourceScope: 'codex:test-home', accountScope, hostDeviceId: agentDeviceId(),
    workspaceRoot: 'D:/work', title: '原工作会话', controlMode: 'controllable', runtimeStatus: 'running',
    controlEndpoint: null, configSnapshotJson: config, lastEventSeq: 99, lastTurnId: 'real-turn', createdAt: 1, updatedAt: 1,
  } as NativeWorkSessionRecord;
  useWorkLedger.setState({ sessions: [session] });
  return session;
}

function action(patch: Partial<NativeDispatchActionRecord> = {}): NativeDispatchActionRecord {
  return { id: 'native-command', todoId: 'work', sessionId: 'host-session', idempotencyKey: 'native-codex:v1:request',
    actionKind: 'session_prompt', specJson: JSON.stringify({ schema: 'rocketx.native-codex-command.v1', executor: 'native_host' }),
    state: 'dispatched', baselineMarker: 'seq:1', createdAt: 1, updatedAt: 1, ...patch } as NativeDispatchActionRecord;
}

test('Host 标记仅保留路由，未知、损坏元数据和部分命令标记也不会回退旧执行器', () => {
  for (const value of [config, '{"nativeHost":null}', '{"nativeHost":{"schema":"future"}}', '{"nativeHost":']) {
    assert.equal(isNativeHostSession({ configSnapshotJson: value }), true);
  }
  assert.equal(isNativeHostSession({ configSnapshotJson: '{"provider":"codex"}' }), false);
  for (const patch of [{}, { idempotencyKey: 'other', specJson: '{"executor":"native_host"}' },
    { idempotencyKey: 'other', specJson: '{"schema":"rocketx.native-codex-command.v2"}' }]) {
    assert.equal(isNativeHostAction(action(patch)), true);
  }
  assert.equal(isNativeHostAction(action({ idempotencyKey: 'legacy', specJson: '{}' })), false);
});

test('旧账本拒绝准备及更新 Host 动作，启动对账不从旧水位猜原生回执', async () => {
  await reset();
  const native = action();
  const adoptedLegacy = action({ id: 'old-adopted', idempotencyKey: 'old', specJson: '{}' });
  const legacy = action({ id: 'unrelated', todoId: 'other', sessionId: null, idempotencyKey: 'legacy', specJson: '{}' });
  useWorkLedger.setState({ actions: [native, adoptedLegacy, legacy] });
  const ledger = useWorkLedger.getState();
  await assert.rejects(ledger.upsertSession({ ...useWorkLedger.getState().sessions[0], controlMode: 'readonly', runtimeStatus: 'unknown' }), /原生工作入口/);
  await assert.rejects(ledger.prepareDispatchAction({ todoId: 'work', actionKind: 'session_create', idempotencyKey: 'old-create', specJson: '{}' }), /原生工作入口/);
  await assert.rejects(ledger.prepareDispatchAction({ todoId: 'other', actionKind: 'session_prompt', sessionId: 'host-session', idempotencyKey: 'old-cross-work', specJson: '{}' }), /原生工作入口/);
  await assert.rejects(ledger.transitionDispatchAction({ id: native.id, state: 'acknowledged' }), /原生工作入口/);
  await assert.rejects(ledger.transitionDispatchAction({ id: adoptedLegacy.id, state: 'canceled' }), /原生工作入口/);
  const outcomes = await ledger.reconcileStartupActions();
  assert.deepEqual(outcomes.map((item) => item.actionId), ['unrelated']);
  assert.equal(useWorkLedger.getState().actions.find((item) => item.id === native.id)?.state, 'dispatched');
  assert.equal(useWorkLedger.getState().actions.find((item) => item.id === adoptedLegacy.id)?.state, 'dispatched');
  assert.equal(useWorkLedger.getState().actions.find((item) => item.id === legacy.id)?.state, 'verifying_delivery');
});

test('手动旧派发、批准、恢复、派生和改口入口均不绕过 Host 所有权', async () => {
  const session = await reset();
  const drivers = getSuperAgentRuntimeDrivers();
  await assert.rejects(drivers.startAcpWorkerTask({ todoId: 'work', agentId: 'profile', workspaceRoot: session.workspaceRoot, specText: '不能新建', title: '新建' }), /原生工作入口/);
  await assert.rejects(drivers.sendAcpSessionPrompt({ agentId: 'profile', workspaceRoot: session.workspaceRoot,
    sourceScope: session.sourceScope!, sessionId: session.nativeSessionId, specText: '不能旁路发送' }), /原生工作入口/);
  let dispatched = 0;
  const restore = setSuperAgentRuntimeDriversForTests({ startAcpWorkerTask: async () => { dispatched += 1; return { sessionId: 'wrong' }; } });
  try {
    const native = action({ state: 'awaiting_approval' });
    useWorkLedger.setState({ actions: [native] });
    const result = await executeSuperAgentDispatch({ action: native, approved: true });
    assert.equal(result.ok, false);
    assert.match(result.error!, /原生工作入口/);
    assert.equal(useWorkLedger.getState().actions[0].state, 'awaiting_approval');
    await assert.rejects(openOrResumeWorkSession(session, { handoffConfirmed: true }), /原生工作入口/);
    await assert.rejects(spawnCardWorkerInWorktree({ todoId: 'work' }), /原生工作入口/);
    await assert.rejects(steerAcpSessionForCard('work', '改口'), /原生工作入口/);
    assert.equal(dispatched, 0);
  } finally { restore(); }
});

for (const runtime of ['acp', 'codex'] as const) {
test(`磁盘扫描保留 ${runtime} 的原生绑定，不为同一线程另建只读历史`, async () => {
  const session = { ...await reset(), runtime };
  useWorkLedger.setState({ sessions: [session] });
  const restore = setSuperAgentRuntimeDriversForTests({ discoverLocalSessions: async () => [{
    provider: 'codex', preset: 'codex-acp', nativeSessionId: session.nativeSessionId, title: '磁盘旧标题', workspaceRoot: session.workspaceRoot,
    sourceScope: session.sourceScope!, executionProfileId: 'profile', runtimeStatus: 'unknown', createdAt: 1, updatedAt: 50,
    sourcePath: null, preview: '磁盘旧摘要', stepCount: 1,
  }] });
  try {
    assert.equal(await syncLiveSessionsIntoLedger(), 0);
    assert.deepEqual(useWorkLedger.getState().sessions, [session]);
  } finally { restore(); }
});
}

function snapshot(commands: NativeDispatchActionRecord[] = []): NativeWorkSnapshot {
  return { protocolVersion: 1, todoId: 'work', sessionId: 'host-session', nativeThreadId: 'original-thread', sourceScope: 'codex:test-home',
    executionProfileId: 'profile', bindingVersion: 7, activeTurnId: 'real-turn', runtimeStatus: 'running', connectionStatus: 'connected',
    commands, decisions: [], messages: [], cursor: 1,
  } as NativeWorkSnapshot;
}

test('暂停 Host 工作先暂停跟进，并向真实轮次发送原生 interrupt，completed 前不伪写 interrupted', async () => {
  await reset();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldCancel = useAcpAgents.getState().cancelTurn;
  let cancels = 0;
  let reads = 0;
  const inputs: unknown[] = [];
  useAcpAgents.setState({ cancelTurn: async () => { cancels += 1; } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async (method: string, args: { input: unknown }) => {
    assert.equal(useWorkLedger.getState().cards[0].state.waitState, 'paused');
    if (method === 'butler_native_work_snapshot') {
      reads += 1;
      assert.equal(useWorkLedger.getState().sessions[0].runtimeStatus, 'running');
      return snapshot(reads > 1 ? [action({ state: 'completed' })] : []);
    }
    if (method === 'butler_native_work_submit') { inputs.push(args.input); return action({ state: 'prepared' }); }
    throw new Error(`Unexpected native call ${method}`);
  } } } });
  try {
    const paused = await pauseCardAcpWorkflow('work');
    assert.equal(paused.state.waitState, 'paused');
    assert.equal(cancels, 0);
    assert.equal(reads, 2);
    assert.equal(inputs.length, 1);
    const input = inputs[0] as { account: { accountScope: string; generation: number }; command: Record<string, unknown> };
    assert.equal(input.account.accountScope, resolveButlerAccountScope());
    assert.equal(input.account.generation, generation);
    assert.deepEqual(input.command, { requestId: input.command.requestId, todoId: 'work', sessionId: 'host-session',
      expectedRequirementsVersion: 1, expectedContentVersion: 0, expectedBindingVersion: 7,
      nativeTurnId: 'real-turn', intent: { kind: 'interrupt' }, submittedBy: 'user' });
    assert.equal(useWorkLedger.getState().sessions[0].runtimeStatus, 'running');
  } finally {
    useAcpAgents.setState({ cancelTurn: oldCancel });
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('原生停止失败保留真实运行投影和暂停跟进，不借 ACP 假取消', async () => {
  await reset();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let reads = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async (method: string) => {
    if (method === 'butler_native_work_snapshot') return snapshot(++reads > 1 ? [action({ state: 'failed', errorMessage: '原端连接已断开' })] : []);
    if (method === 'butler_native_work_submit') return action({ state: 'prepared' });
    throw new Error(`Unexpected native call ${method}`);
  } } } });
  try {
    await assert.rejects(pauseCardAcpWorkflow('work'), /自动跟进已暂停.*原端连接已断开/);
    assert.equal(useWorkLedger.getState().cards[0].state.waitState, 'paused');
    assert.equal(useWorkLedger.getState().sessions[0].runtimeStatus, 'running');
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('停止只收到 durable prepared 时显示正在停止，不将提交成功当作原端已停', async () => {
  await reset();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async (method: string) => {
    if (method === 'butler_native_work_snapshot') return snapshot([action({ state: 'prepared' })]);
    if (method === 'butler_native_work_submit') return action({ state: 'prepared' });
    throw new Error(`Unexpected native call ${method}`);
  } } } });
  try {
    const card = await pauseCardAcpWorkflow('work');
    assert.equal(card.state.waitState, 'paused');
    assert.match(card.state.waitReason!, /等待当前执行的停止回执/);
    assert.equal(useWorkLedger.getState().sessions[0].runtimeStatus, 'running');
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('读取停止目标期间账号代际切换时，不向新账号提交旧轮次或覆盖其卡片', async () => {
  await reset();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let submits = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async (method: string) => {
    if (method === 'butler_native_work_snapshot') {
      const accountScope = resolveButlerAccountScope();
      beginButlerAccountSelection(accountScope).activate({ accountScope, generation: ++generation });
      const card = useWorkLedger.getState().cards[0];
      useWorkLedger.setState({ cards: [{ ...card, title: '新账号同 ID 工作', state: { ...card.state, waitState: 'none', waitReason: null } }] });
      return snapshot();
    }
    if (method === 'butler_native_work_submit') { submits += 1; return action({ state: 'prepared' }); }
    throw new Error(`Unexpected native call ${method}`);
  } } } });
  try {
    await assert.rejects(pauseCardAcpWorkflow('work'), /账号已切换/);
    assert.equal(submits, 0);
    assert.equal(useWorkLedger.getState().sessions[0].runtimeStatus, 'running');
    assert.equal(useWorkLedger.getState().cards[0].state.waitState, 'none');
    assert.equal(useWorkLedger.getState().cards[0].state.waitReason, null);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
