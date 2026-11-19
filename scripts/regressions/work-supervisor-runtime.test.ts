import assert from 'node:assert/strict';
import test from 'node:test';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';
import { useTodos } from '../../apps/web/src/stores/todos';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useChat } from '../../apps/web/src/stores/chat';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';
import { useSharedAgent } from '../../apps/web/src/stores/sharedAgent';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { rest } from '../../apps/web/src/lib/client';
import {
  executeSuperAgentDispatch, getSuperAgentRuntimeDrivers, setSuperAgentRuntimeDriversForTests, startSuperAgentBridge,
  stopSuperAgentBridge,
} from '../../apps/web/src/agent/superAgentBridge';
import type { RcMessage } from '@rcx/rc-client';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });

async function waitFor(predicate: () => boolean) {
  const limit = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= limit) throw new Error('后台条件未在 3 秒内成立');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function reset(localMode = true) {
  stopSuperAgentBridge(); storage.clear();
  useAuth.setState({ localMode, status: 'authed', user: { _id: 'supervisor-test', username: 'supervisor-test' } as never });
  useAcpAgents.setState({ sessions: {} }); useSharedAgent.setState({ sessions: {} });
  useCodexWorkspace.setState({ threads: [], threadStates: {}, scope: 'supervisor-test', workspaceRoot: 'D:/unrelated', activeThreadId: undefined });
  useChat.setState({ messages: {}, subscriptions: {}, historyLoaded: {}, connection: localMode ? 'idle' : 'connected' });
  useTodos.setState({ todos: [{ id: 'work', title: '受管工作', source: 'ado', rid: 'room', adoWorkItemId: 33, done: false, createdAt: Date.now() } as never] });
  useWorkLedger.setState({ cards: [], actions: [], events: [], sessions: [], evidences: [], links: [], lastError: null });
  useWorkLedger.getState().syncWithTodos();
  await useWorkLedger.getState().updateCard('work', { enroll: true, goal: '修复', acceptance: ['测试通过'], autonomyMode: 'autonomous' });
}
function event(id: string, at: number): RcMessage {
  return { _id: id, rid: 'room', msg: '工作项已更新 AB#33', alias: 'Azure DevOps', ts: new Date(at).toISOString(),
    u: { _id: 'ado', username: 'ado-bridge' } } as RcMessage;
}

test('后台实际入口恢复 prepared 一次，重启后 acknowledged 不会重复执行', async () => {
  await reset(); let dispatched = 0;
  const restore = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, discoverLocalSessions: async () => [],
    startCodexWorkerTask: async ({ workspaceRoot }) => { assert.equal(workspaceRoot, 'D:/frozen'); dispatched += 1; return { threadId: 'worker' }; } });
  try {
    const action = await useWorkLedger.getState().prepareDispatchAction({ todoId: 'work', actionKind: 'session_create',
      idempotencyKey: 'stable-operation', requireConfirmation: false,
      specJson: JSON.stringify({ specText: '修复', workspaceRoot: 'D:/frozen', runtime: 'pi' }) });
    await startSuperAgentBridge();
    await waitFor(() => useWorkLedger.getState().actions.find((item) => item.id === action.id)?.state === 'acknowledged');
    stopSuperAgentBridge();
    await startSuperAgentBridge();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(dispatched, 1);
    assert.equal(useCodexWorkspace.getState().activeThreadId, undefined);
  } finally { stopSuperAgentBridge(); restore(); }
});

test('投递后连接异常保留 unknown，重复调用不创建第二轮执行', async () => {
  await reset(); let dispatched = 0;
  const restore = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false,
    startCodexWorkerTask: async () => { dispatched += 1; throw new Error('发送后回执丢失'); } });
  try {
    const action = await useWorkLedger.getState().prepareDispatchAction({ todoId: 'work', actionKind: 'session_create', idempotencyKey: 'unknown-operation',
      specJson: JSON.stringify({ specText: '修复', workspaceRoot: 'D:/frozen', runtime: 'pi' }), requireConfirmation: false });
    const result = await executeSuperAgentDispatch({ action });
    assert.equal(result.ok, false);
    assert.equal(useWorkLedger.getState().actions[0].state, 'verifying_delivery');
    assert.equal(useWorkLedger.getState().cards[0].state.waitState, 'waiting_input');
    assert.equal((await executeSuperAgentDispatch({ action })).ok, false);
    assert.equal(dispatched, 1);
  } finally { restore(); }
});

test('派发回执迟到时账号已切换，不把旧会话和状态写入新账号账本', async () => {
  await reset();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  const restore = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false,
    startCodexWorkerTask: async () => { started = true; await gate; return { threadId: 'old-account-worker' }; } });
  try {
    const action = await useWorkLedger.getState().prepareDispatchAction({ todoId: 'work', actionKind: 'session_create', idempotencyKey: 'scope-operation',
      specJson: JSON.stringify({ specText: '修复', workspaceRoot: 'D:/frozen', runtime: 'pi' }), requireConfirmation: false });
    const pending = executeSuperAgentDispatch({ action });
    await waitFor(() => started);
    useAuth.setState({ user: { _id: 'other-account', username: 'other-account' } as never });
    useWorkLedger.setState({ cards: [], actions: [], sessions: [] });
    release();
    assert.equal((await pending).ok, false);
    assert.deepEqual(useWorkLedger.getState().cards, []);
    assert.deepEqual(useWorkLedger.getState().sessions, []);
    assert.deepEqual(useWorkLedger.getState().actions, []);
  } finally { release(); restore(); }
});

test('ACP整轮已结束就保存idle，普通后续prompt无需等待轮询解锁', async () => {
  await reset(); let prompts = 0;
  const restore = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false,
    startAcpWorkerTask: async () => ({ sessionId: 'native', sessionKey: 'session', stopReason: 'end_turn' }),
    sendAcpSessionPrompt: async () => { prompts += 1; return { turnMarker: `turn-${prompts}`, stopReason: 'end_turn' }; } });
  try {
    const created = await useWorkLedger.getState().prepareDispatchAction({ todoId: 'work', actionKind: 'session_create', idempotencyKey: 'create-acp',
      specJson: JSON.stringify({ specText: '修复', workspaceRoot: 'D:/frozen', runtime: 'acp', acpAgentId: 'test-agent' }), requireConfirmation: false });
    const first = await executeSuperAgentDispatch({ action: created });
    assert.equal(first.ok, true); assert.equal(first.session?.runtimeStatus, 'idle');
    const next = await useWorkLedger.getState().prepareDispatchAction({ todoId: 'work', sessionId: first.session!.id,
      actionKind: 'session_prompt', idempotencyKey: 'next-acp', specJson: JSON.stringify({ specText: '下一步', runtime: 'acp', acpAgentId: 'test-agent' }), requireConfirmation: false });
    assert.equal((await executeSuperAgentDispatch({ action: next })).ok, true);
    assert.equal(prompts, 1);
  } finally { restore(); }
});

test('历史补偿失败后恢复重试，期间实时新事件不会跳过离线历史水位', async () => {
  await reset(false);
  await useWorkLedger.getState().updateCard('work', { autonomyMode: 'confirm' });
  const baseline = Date.now() - 1000;
  const key = `rocketx.work-supervisor.v1:${encodeURIComponent('local:supervisor-test')}`;
  storage.set(key, JSON.stringify({ watermarks: { room: { at: baseline, ids: [] } }, notices: {} }));
  useChat.setState({ subscriptions: { room: { rid: 'room', t: 'c', name: '测试房间' } as never } });
  const restoreDrivers = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, discoverLocalSessions: async () => [] });
  const originalHistory = rest.getHistory;
  let fail = true; let historyCalls = 0;
  rest.getHistory = async () => {
    historyCalls += 1;
    if (fail) throw new Error('暂时断网');
    return [event('offline', baseline + 100), event('recent', baseline + 200)];
  };
  try {
    await startSuperAgentBridge();
    await waitFor(() => historyCalls > 0 && !!useWorkLedger.getState().lastError);
    useChat.setState({ messages: { room: [event('live', baseline + 300)] } });
    assert.equal(JSON.parse(storage.get(key)!).watermarks.room.at, baseline);
    fail = false;
    useChat.setState({ connection: 'reconnecting' }); useChat.setState({ connection: 'connected' });
    await waitFor(() => useWorkLedger.getState().events.length === 3);
    assert.deepEqual(new Set(useWorkLedger.getState().events.map((item) => item.dedupeKey)), new Set(['rc-msg:offline', 'rc-msg:recent', 'rc-msg:live']));
    assert.equal(JSON.parse(storage.get(key)!).watermarks.room.at, baseline + 300);
  } finally { stopSuperAgentBridge(); rest.getHistory = originalHistory; restoreDrivers(); }
});

test('共享工作与无法定位的工作均不向ACP注入个人记忆，发送按完整来源匹配', async () => {
  await reset();
  await useWorkLedger.getState().updateCard('work', { visibility: 'room_shared' });
  const originalSend = useAcpAgents.getState().sendPrompt;
  const originalStart = useAcpAgents.getState().startSession;
  const received: Array<{ sessionKey: string; memory?: boolean }> = [];
  const scope = 'source-b';
  const managed = { sessionKey: 'b', acpSessionId: 'same-native', agentId: 'profile-b', sourceScope: scope,
    workspaceRoot: 'D:/frozen', status: 'ready', messages: [] } as unknown as ReturnType<typeof useAcpAgents.getState>['sessions'][string];
  useAcpAgents.setState({ sessions: { a: { ...managed, sessionKey: 'a', agentId: 'profile-a', sourceScope: 'source-a' }, b: managed },
    startSession: async () => managed,
    sendPrompt: async (sessionKey, _text, options) => { received.push({ sessionKey, memory: options?.injectMemory }); return { stopReason: 'end_turn' }; } });
  try {
    const drivers = getSuperAgentRuntimeDrivers();
    await drivers.startAcpWorkerTask({ todoId: 'work', agentId: 'profile-b', workspaceRoot: 'D:/frozen', specText: '共享修复', title: '共享工作' });
    await drivers.sendAcpSessionPrompt({ todoId: 'work', agentId: 'profile-b', sourceScope: scope, workspaceRoot: 'D:/frozen',
      sessionId: 'same-native', specText: '继续共享修复', requiresColdResume: false });
    await drivers.sendAcpSessionPrompt({ agentId: 'profile-b', sourceScope: scope, workspaceRoot: 'D:/frozen',
      sessionId: 'same-native', specText: '无法定位工作', requiresColdResume: false });
    assert.deepEqual(received, [{ sessionKey: 'b', memory: false }, { sessionKey: 'b', memory: false }, { sessionKey: 'b', memory: false }]);
  } finally { useAcpAgents.setState({ startSession: originalStart, sendPrompt: originalSend }); }
});

test('重启已有最新50条缓存，仍补全300条跨页历史以及补偿期间实时消息', async () => {
  await reset(false);
  await useWorkLedger.getState().updateCard('work', { autonomyMode: 'readonly' });
  const baseline = Date.now() - 1000;
  const key = `rocketx.work-supervisor.v1:${encodeURIComponent('local:supervisor-test')}`;
  storage.set(key, JSON.stringify({ watermarks: { room: { at: baseline, ids: [] } }, notices: {} }));
  const batch = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_value, index) => event(`event-${start + index}`, baseline + start + index));
  useChat.setState({ subscriptions: { room: { rid: 'room', t: 'c', name: '测试房间' } as never },
    messages: { room: batch(251, 300) }, historyLoaded: { room: true } });
  const restoreDrivers = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, discoverLocalSessions: async () => [] });
  const originalHistory = rest.getHistory;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  rest.getHistory = async (_rid, _type, _count, latest) => {
    calls += 1;
    if (!latest) { await gate; return batch(201, 300); }
    const cursor = Date.parse(latest) - baseline;
    if (cursor === 201) return batch(101, 200);
    if (cursor === 101) return batch(1, 100);
    return [event('old', baseline - 1)];
  };
  try {
    await startSuperAgentBridge();
    await waitFor(() => calls === 1);
    useChat.setState({ messages: { room: [...batch(251, 300), event('event-301', baseline + 301)] } });
    assert.equal(JSON.parse(storage.get(key)!).watermarks.room.at, baseline);
    release();
    await waitFor(() => useWorkLedger.getState().events.length === 301);
    assert.equal(calls, 4);
    assert.equal(new Set(useWorkLedger.getState().events.map((item) => item.dedupeKey)).size, 301);
    assert.ok(useWorkLedger.getState().events.some((item) => item.dedupeKey === 'rc-msg:event-1'));
    assert.equal(JSON.parse(storage.get(key)!).watermarks.room.at, baseline + 301);
  } finally { release(); stopSuperAgentBridge(); rest.getHistory = originalHistory; restoreDrivers(); }
});
