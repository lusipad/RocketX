import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateSessionControlMode, matchesAcpWorkSession } from '../../apps/web/src/agent/sessionAdapter';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';
import { expireDisconnectedAcpPermissions, readAcpPermissionJournal, writeAcpPermissionJournal } from '../../apps/web/src/agent/acp/permissionJournal';
import { openOrResumeWorkSession, setSuperAgentRuntimeDriversForTests, syncLiveSessionsIntoLedger } from '../../apps/web/src/agent/superAgentBridge';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';
import { useSharedAgent } from '../../apps/web/src/stores/sharedAgent';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { useButlerMemory } from '../../apps/web/src/stores/butlerMemory';
import { useAuth } from '../../apps/web/src/stores/auth';
import type { AcpController } from '../../apps/web/src/agent/acp/AcpController';

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });

test('unknown external activity stays read-only unless an owned live controller exists', () => {
  const unknown = { runtime: 'acp' as const, nativeSessionId: 'external-id', workspaceRoot: 'D:/work', externalActivityUnknown: true };
  assert.equal(evaluateSessionControlMode(unknown).controlMode, 'readonly');
  assert.equal(evaluateSessionControlMode(unknown).canColdResume, false);
  assert.equal(evaluateSessionControlMode({ ...unknown, hasOwnedLiveController: true }).controlMode, 'controllable');
});

test('live ACP matching preserves source, account, owning profile and case-sensitive POSIX cwd', () => {
  const record = { nativeSessionId: 'same-id', sourceScope: 'codex:first', accountScope: 'account', workspaceRoot: '/Repo', configSnapshotJson: JSON.stringify({ agentId: 'owner' }) };
  const live = { acpSessionId: 'same-id', sourceScope: 'codex:first', accountScope: 'account', workspaceRoot: '/Repo', agentId: 'owner' };
  assert.equal(matchesAcpWorkSession(record, live, 'account'), true);
  for (const patch of [{ sourceScope: 'codex:second' }, { agentId: 'alias' }, { accountScope: 'another-account' }, { workspaceRoot: '/repo' }]) {
    assert.equal(matchesAcpWorkSession(record, { ...live, ...patch }, 'account'), false);
  }
  assert.equal(matchesAcpWorkSession(record, live, 'another-account'), false);
});

test('native Codex resume requires an explicit source-bound handoff instead of silently picking a preset', async () => {
  await assert.rejects(useAcpAgents.getState().resumeLocalSession({ provider: 'codex', preset: 'codex-acp', nativeSessionId: 'external-id', workspaceRoot: 'D:/work' }), /交接/);
});

test('工作详情明确交接后接续原 Codex 身份、来源、配置和工作，不新建替代会话', async () => {
  const originalResume = useAcpAgents.getState().resumeLocalSession;
  const { useUI } = await import('../../apps/web/src/stores/ui');
  const originalOpen = useUI.getState().openAcpHub;
  const calls: any[] = [];
  useAcpAgents.setState({ sessions: {}, resumeLocalSession: async (input) => {
    calls.push(input);
    return { agentId: 'source-profile' } as any;
  } });
  useUI.setState({ openAcpHub: () => {} });
  const record = { id: 'imported', todoId: 'work', runtime: 'acp', origin: 'native_cli', nativeSessionId: 'original-id', sourceScope: 'codex:source', controlMode: 'readonly', workspaceRoot: 'D:/original', title: 'Existing work', configSnapshotJson: JSON.stringify({ provider: 'codex', preset: 'codex-acp', executionProfileId: 'source-profile', sourcePath: 'D:/source/session.jsonl' }) } as any;
  try {
    await assert.rejects(openOrResumeWorkSession(record), /只读/);
    assert.equal(calls.length, 0);
    await openOrResumeWorkSession(record, { handoffConfirmed: true });
    assert.deepEqual(calls, [{ provider: 'codex', preset: 'codex-acp', nativeSessionId: 'original-id', title: 'Existing work', workspaceRoot: 'D:/original', sourcePath: 'D:/source/session.jsonl', sourceScope: 'codex:source', executionProfileId: 'source-profile', handoffConfirmed: true, linkedTodoId: 'work' }]);
    await assert.rejects(openOrResumeWorkSession({ ...record, accountScope: 'another-account' }, { handoffConfirmed: true }), /其他账号/);
    await assert.rejects(openOrResumeWorkSession({ ...record, hostDeviceId: 'another-device' }, { handoffConfirmed: true }), /原会话所在设备/);
    assert.equal(calls.length, 1);
  } finally {
    useAcpAgents.setState({ resumeLocalSession: originalResume });
    useUI.setState({ openAcpHub: originalOpen });
  }
});

test('交接准备期间切换账号时，不加载原会话', async () => {
  const original = useAcpAgents.getState();
  const user = useAuth.getState().user;
  let loads = 0;
  useAcpAgents.setState({ agents: [], discovered: [], sessions: {},
    upsertAgent: async () => {
      useAuth.setState({ user: { _id: 'switched-account' } as any });
      return { id: 'profile', enabled: true, preset: 'codex-acp', sourceScope: 'codex:source' } as any;
    },
    loadSession: async () => { loads += 1; throw new Error('不应加载'); },
  });
  try {
    await assert.rejects(useAcpAgents.getState().resumeLocalSession({ provider: 'codex', preset: 'codex-acp', nativeSessionId: 'original-id', workspaceRoot: 'D:/work', sourceScope: 'codex:source', handoffConfirmed: true }), /账号已切换/);
    assert.equal(loads, 0);
  } finally {
    useAuth.setState({ user });
    useAcpAgents.setState({ agents: original.agents, discovered: original.discovered, sessions: original.sessions, upsertAgent: original.upsertAgent, loadSession: original.loadSession });
  }
});

test('discovery keeps same IDs from different data sources, stays read-only and does not enroll historical work', async () => {
  useAcpAgents.setState({ sessions: {}, activeSessionKey: null });
  useSharedAgent.setState({ sessions: {} });
  useCodexWorkspace.setState({ threads: [], activeThreadId: null, threadStates: {} });
  useWorkLedger.setState({ sessions: [], cards: [], links: [] });
  setSuperAgentRuntimeDriversForTests({ discoverLocalSessions: async () => ['first', 'second'].map((source) => ({ provider: 'codex', preset: 'codex-acp', nativeSessionId: 'same-id', title: 'same title', workspaceRoot: 'D:/work', sourceScope: `codex:${source}`, runtimeStatus: 'unknown', createdAt: Date.now(), updatedAt: Date.now(), stepCount: null, sourcePath: null, preview: null })) });
  try {
    await syncLiveSessionsIntoLedger();
    const sessions = useWorkLedger.getState().sessions;
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((session) => session.runtimeStatus === 'unknown' && session.controlMode === 'readonly'));
    assert.equal(useWorkLedger.getState().cards.length, 0);
    await assert.rejects(openOrResumeWorkSession(sessions[0]!), /只读/);
  } finally { setSuperAgentRuntimeDriversForTests(null); }
});

test('reload keeps approval descriptions scoped to the account but expires disconnected approvals', () => {
  writeAcpPermissionJournal('account-a', [{ requestId: 'request', sessionKey: 'session-key', nativeSessionId: 'native-id', agentId: 'agent', workspaceRoot: 'D:/work', title: 'work', accountScope: 'account-a', turnCount: 2, createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: 'pending' }]);
  assert.equal(readAcpPermissionJournal('account-b').length, 0);
  assert.equal(expireDisconnectedAcpPermissions('account-a', new Set(['request'])).length, 0);
  const stale = expireDisconnectedAcpPermissions('account-a', new Set());
  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.status, 'expired');
  assert.match(stale[0]!.reason!, /重新请求权限/);
});

test('cancelling a disconnected ACP session does not claim it has stopped', async () => {
  await assert.rejects(useAcpAgents.getState().cancelTurn('missing'), /无法确认/);
});

test('failed ACP initialization preserves history but never retains a sendable connection', async () => {
  useWorkLedger.setState({ sessions: [], cards: [], links: [] });
  useAcpAgents.setState({ sessions: {}, activeSessionKey: null });
  useAcpAgents.setState({ agents: [{ id: 'failed-agent', name: 'Antigravity', preset: 'antigravity', command: 'test', args: [], cwd: null, envKeys: [], enabled: true, autoApproveSafeReads: false, description: null, createdAt: 1, updatedAt: 1 }] });
  const controller = { setHostHandlers: () => {}, stop: async () => {},
    newSession: async () => { throw new Error('执行连接未就绪'); },
    loadSession: async () => { throw new Error('执行连接未就绪'); },
  } as unknown as AcpController;
  await assert.rejects(useAcpAgents.getState().startSession({ agentId: 'failed-agent', workspaceRoot: 'D:/work', controllerFactory: () => controller }), /执行连接未就绪/);
  const fresh = useAcpAgents.getState().sessions[useAcpAgents.getState().activeSessionKey!]!;
  assert.equal(fresh.acpSessionId, '');
  assert.equal(fresh.connectionReady, false);
  await assert.rejects(useAcpAgents.getState().loadSession({ agentId: 'failed-agent', sessionId: 'original-history', workspaceRoot: 'D:/work', initialMessages: [{ id: 'history', role: 'assistant', text: '已有的工作记录', timestamp: 1 }], controllerFactory: () => controller }), /执行连接未就绪/);
  const loaded = useAcpAgents.getState().sessions['acp:failed-agent:original-history']!;
  assert.equal(loaded.connectionReady, false);
  assert.equal(loaded.messages[0]?.text, '已有的工作记录');
  await assert.rejects(useAcpAgents.getState().sendPrompt(loaded.sessionKey, '保留的要求'), /未就绪|已停止/);
  const failedRecord = useWorkLedger.getState().sessions.find((record) => record.nativeSessionId === 'original-history');
  assert.equal(failedRecord?.controlMode, 'resumable');
  assert.equal(failedRecord?.controlEndpoint, null);
  assert.equal(failedRecord?.controlReason, 'connection_unavailable');
  assert.equal(useWorkLedger.getState().sessions.some((record) => !record.nativeSessionId), false);

  useSharedAgent.setState({ sessions: {} });
  useCodexWorkspace.setState({ threads: [], activeThreadId: null, threadStates: {} });
  useAcpAgents.setState({ sessions: { [loaded.sessionKey]: { ...loaded, status: 'connecting' } } });
  const restore = setSuperAgentRuntimeDriversForTests({ discoverLocalSessions: async () => [] });
  try { await syncLiveSessionsIntoLedger(); } finally { restore(); }
  const connectingRecord = useWorkLedger.getState().sessions.find((record) => record.nativeSessionId === 'original-history');
  assert.equal(connectingRecord?.controlMode, 'resumable');
  assert.equal(connectingRecord?.controlEndpoint, null);
  assert.equal(connectingRecord?.controlReason, 'connection_unavailable');

  const recovered = await useAcpAgents.getState().loadSession({ agentId: 'failed-agent', sessionId: 'original-history', workspaceRoot: 'D:/work', controllerFactory: () => ({
    setHostHandlers: () => {}, stop: async () => {}, loadSession: async () => ({}),
  } as unknown as AcpController) });
  assert.equal(recovered.connectionReady, true);
  assert.equal(recovered.messages[0]?.text, '已有的工作记录');
  assert.equal(useWorkLedger.getState().sessions.length, 1);
  assert.equal(useWorkLedger.getState().sessions[0]?.controlMode, 'controllable');
  await useAcpAgents.getState().stopSession(recovered.sessionKey);
});

async function createControlledSession(cancelFails = false, linkedTodoId?: string) {
  const prompts: string[] = [];
  let finish: (value: { stopReason: string }) => void = () => {};
  let cancelCount = 0;
  const controller = {
    setHostHandlers: () => {}, stop: async () => {},
    newSession: async () => ({ sessionId: `controlled-${Math.random()}` }),
    prompt: (text: string) => { prompts.push(text); return prompts.length === 1 ? new Promise<{ stopReason: string }>((resolve) => { finish = resolve; }) : Promise.resolve({ stopReason: 'end_turn' }); },
    cancel: async () => { cancelCount += 1; if (cancelFails) throw new Error('取消通知发送失败'); },
  } as unknown as AcpController;
  useAcpAgents.setState({ agents: [{ id: 'controlled-agent', name: 'Controlled', preset: 'custom', command: 'test', args: [], cwd: null, envKeys: [], enabled: true, autoApproveSafeReads: false, description: null, createdAt: 1, updatedAt: 1 }] });
  const session = await useAcpAgents.getState().startSession({ agentId: 'controlled-agent', workspaceRoot: 'D:/work', linkedTodoId, controllerFactory: () => controller });
  assert.equal(session.connectionReady, true);
  return { session, prompts, finish: () => finish({ stopReason: 'cancelled' }), cancelCount: () => cancelCount };
}

test('steering waits for the original turn to exit and never sends after a failed cancellation', async () => {
  for (const fails of [true, false]) {
    const fixture = await createControlledSession(fails);
    const original = useAcpAgents.getState().sendPrompt(fixture.session.sessionKey, 'original');
    const steered = useAcpAgents.getState().sendPrompt(fixture.session.sessionKey, 'updated', { steer: true });
    if (fails) await assert.rejects(steered, /取消通知发送失败/);
    else await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.cancelCount(), 1);
    assert.deepEqual(fixture.prompts, ['original']);
    fixture.finish(); await original;
    if (!fails) { await steered; assert.deepEqual(fixture.prompts, ['original', 'updated']); }
    await useAcpAgents.getState().stopSession(fixture.session.sessionKey);
    assert.equal(useAcpAgents.getState().sessions[fixture.session.sessionKey]?.connectionReady, false);
  }
});

test('shared work never recalls personal memory through the direct ACP send API', async () => {
  const card = await useWorkLedger.getState().createCard({ title: 'shared work', visibility: 'room_shared' });
  const originalRecall = useButlerMemory.getState().recallRelevantMemories;
  let recallCount = 0;
  useButlerMemory.setState({ recallRelevantMemories: async () => { recallCount += 1; return []; } });
  const fixture = await createControlledSession(false, card.id);
  try {
    const sent = useAcpAgents.getState().sendPrompt(fixture.session.sessionKey, 'shared request', { injectMemory: true });
    fixture.finish(); await sent;
    assert.equal(recallCount, 0);
    assert.deepEqual(fixture.prompts, ['shared request']);
  } finally { useButlerMemory.setState({ recallRelevantMemories: originalRecall }); await useAcpAgents.getState().stopSession(fixture.session.sessionKey); }
});

test('new Codex RPC aliases never enter the ledger; real native identity survives disconnect and original-ID load', async () => {
  useWorkLedger.setState({ sessions: [], cards: [], links: [] });
  const alias = 'acp-bridge-new-test';
  const nativeId = 'real-native-thread-id';
  const sourceScope = 'codex:test-home';
  const card = await useWorkLedger.getState().createCard({ title: 'new Codex work' });
  useAcpAgents.setState({ agents: [{ id: 'native-profile', name: 'Codex', preset: 'codex-acp', command: 'test', args: ['--rocketx-acp-bridge=codex'], sourceScope, cwd: null, envKeys: [], enabled: true, autoApproveSafeReads: false, description: null, createdAt: 1, updatedAt: 1 }] });
  const session = await useAcpAgents.getState().startSession({ agentId: 'native-profile', workspaceRoot: 'D:/work', linkedTodoId: card.id, controllerFactory: (options) => ({
    setHostHandlers: () => {}, stop: async () => {}, newSession: async () => ({ sessionId: alias }),
    prompt: async () => { options.onSessionUpdate?.({ sessionId: alias, update: { sessionUpdate: 'rocketx_native_session', provider: 'codex', nativeSessionId: nativeId, workspaceRoot: 'D:/work', sourceScope } }); return { stopReason: 'end_turn' }; },
  } as unknown as AcpController) });
  assert.equal(useWorkLedger.getState().sessions.length, 0);
  await useAcpAgents.getState().sendPrompt(session.sessionKey, 'do work');
  const managed = useAcpAgents.getState().sessions[session.sessionKey]!;
  assert.equal(managed.acpSessionId, alias);
  assert.equal(managed.nativeSessionId, nativeId);
  const originalRecord = useWorkLedger.getState().sessions[0]!;
  assert.equal(originalRecord.nativeSessionId, nativeId);
  assert.equal(originalRecord.todoId, card.id);
  assert.equal(matchesAcpWorkSession(originalRecord, managed, originalRecord.accountScope!), true);
  await useAcpAgents.getState().stopSession(session.sessionKey);
  let requestedId = '';
  const loaded = await useAcpAgents.getState().loadSession({ agentId: 'native-profile', workspaceRoot: 'D:/work', sessionId: nativeId, linkedTodoId: card.id, nativeResume: { token: 'unit-fixture-only', sessionId: nativeId, sourceScope, accountScope: originalRecord.accountScope!, hostDeviceId: originalRecord.hostDeviceId! }, controllerFactory: () => ({
    setHostHandlers: () => {}, stop: async () => {}, loadSession: async (id: string) => { requestedId = id; return {}; },
  } as unknown as AcpController) });
  assert.equal(requestedId, nativeId);
  assert.equal(loaded.nativeSessionId, nativeId);
  assert.equal(useWorkLedger.getState().sessions.length, 1);
  assert.equal(useWorkLedger.getState().sessions[0]!.id, originalRecord.id);
  assert.equal(useWorkLedger.getState().sessions[0]!.todoId, card.id);
  await useAcpAgents.getState().stopSession(loaded.sessionKey);
});

test('明确指定执行配置时，不复用另一配置的同 ID 会话或替换已失效配置', async () => {
  const original = useAcpAgents.getState();
  const base = { name: 'Fixture', preset: 'codex-acp' as const, command: 'fixture-only', args: [], sourceScope: 'codex:profile-fixture', cwd: null, envKeys: [], enabled: true, autoApproveSafeReads: false, description: null, createdAt: 1, updatedAt: 1 };
  useAcpAgents.setState({ agents: [{ ...base, id: 'other-profile' }], sessions: {} });
  const live = await useAcpAgents.getState().startSession({ agentId: 'other-profile', workspaceRoot: 'D:/fixture', controllerFactory: () => ({
    setHostHandlers: () => {}, stop: async () => {}, newSession: async () => ({ sessionId: 'same-original-id' }),
  } as unknown as AcpController) });
  try {
    for (const requested of [[], [{ ...base, id: 'requested-profile', enabled: false }]]) {
      useAcpAgents.setState({ agents: [{ ...base, id: 'other-profile' }, ...requested], activeSessionKey: null });
      await assert.rejects(useAcpAgents.getState().resumeLocalSession({ provider: 'codex', preset: 'codex-acp', nativeSessionId: 'same-original-id', workspaceRoot: 'D:/fixture', sourceScope: base.sourceScope, executionProfileId: 'requested-profile', handoffConfirmed: true }), /原会话执行配置.*不存在或已停用/);
      assert.equal(useAcpAgents.getState().activeSessionKey, null);
      assert.equal(useAcpAgents.getState().sessions[live.sessionKey]?.agentId, 'other-profile');
    }
  } finally {
    await useAcpAgents.getState().stopSession(live.sessionKey);
    useAcpAgents.setState({ agents: original.agents, sessions: original.sessions, activeSessionKey: original.activeSessionKey });
  }
});

test('原会话加载期间切换账号时，停止本次控制器且不跳入旧账号会话', async () => {
  const original = useAcpAgents.getState();
  const user = useAuth.getState().user;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const { useUI } = await import('../../apps/web/src/stores/ui');
  const originalOpen = useUI.getState().openAcpHub;
  const commands: string[] = [];
  let stops = 0;
  let opened = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async (command: string) => {
    commands.push(command);
    if (command === 'acp_local_session_handoff') return 'fixture-only-token';
    if (command === 'acp_local_session_messages') return [];
    throw new Error(`Unexpected native command: ${command}`);
  } } } });
  useUI.setState({ openAcpHub: () => { opened += 1; } });
  useAcpAgents.setState({ agents: [{ id: 'loading-profile', name: 'Fixture', preset: 'codex-acp', command: 'fixture-only', args: [], sourceScope: 'codex:loading-fixture', cwd: null, envKeys: [], enabled: true, autoApproveSafeReads: false, description: null, createdAt: 1, updatedAt: 1 }], sessions: {},
    loadSession: (input) => original.loadSession({ ...input, controllerFactory: () => ({
      setHostHandlers: () => {}, stop: async () => { stops += 1; },
      loadSession: async () => { useAuth.setState({ user: { _id: 'switched-during-load' } as any }); return {}; },
    } as unknown as AcpController) }),
  });
  const record = { id: 'loading-record', todoId: null, runtime: 'acp', origin: 'native_cli', nativeSessionId: 'loading-original-id', sourceScope: 'codex:loading-fixture', controlMode: 'readonly', workspaceRoot: 'D:/fixture', configSnapshotJson: JSON.stringify({ provider: 'codex', executionProfileId: 'loading-profile' }) } as any;
  try {
    await assert.rejects(openOrResumeWorkSession(record, { handoffConfirmed: true }), /账号已切换/);
    assert.deepEqual(commands, ['acp_local_session_handoff', 'acp_local_session_messages']);
    assert.equal(stops, 1);
    assert.equal(opened, 0);
    await assert.rejects(useAcpAgents.getState().sendPrompt('acp:loading-profile:loading-original-id', 'must not send'), /未就绪或已停止/);
  } finally {
    useAuth.setState({ user });
    useUI.setState({ openAcpHub: originalOpen });
    useAcpAgents.setState({ agents: original.agents, sessions: original.sessions, activeSessionKey: original.activeSessionKey, loadSession: original.loadSession });
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
