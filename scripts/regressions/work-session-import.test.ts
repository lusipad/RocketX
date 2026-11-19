import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesDiscoveredWorkSession, promoteWorkSessionToCard, setSuperAgentRuntimeDriversForTests, syncLiveSessionsIntoLedger, workSessionImportIdentity } from '../../apps/web/src/agent/superAgentBridge';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';
import { useSharedAgent } from '../../apps/web/src/stores/sharedAgent';
import { useAuth } from '../../apps/web/src/stores/auth';
import type { NativeWorkCard, NativeWorkSessionRecord } from '../../apps/web/src/platform/desktopCommands';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });

function session(id = 'one', sourceScope = 'source-a'): NativeWorkSessionRecord {
  return { id, sourceScope, todoId: null, visibility: 'private', runtime: 'acp', origin: 'native_cli',
    nativeSessionId: 'same-native', title: '已有任务', workspaceRoot: 'D:/project', environmentId: null,
    accountScope: null, controlEndpoint: null, controlMode: 'readonly', controlReason: 'external_activity_unknown',
    hostDeviceId: null, writerLeaseOwner: null, writerLeaseExpiresAt: null, runtimeStatus: 'unknown',
    configSnapshotJson: JSON.stringify({ provider: 'codex', preset: 'codex-acp', preview: '原会话摘要' }),
    lastEventSeq: null, lastTurnId: null, createdAt: 1, updatedAt: Date.now(), lastVerifiedAt: 1 };
}

test('已有会话并发加入及重复点击返回同一卡片，不复制配置或添加验收', async () => {
  const previous = useWorkLedger.getState(); let creates = 0;
  const record = session();
  useWorkLedger.setState({ cards: [], sessions: [record], createCard: async (input) => {
    creates += 1; await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(input.requestId, '导入必须有稳定创建请求身份');
    assert.equal(input.acceptance, undefined);
    assert.equal(input.priority, 3, '已有会话默认普通优先级，不猜测紧急程度');
    assert.equal(input.goal, record.title, '历史摘要不能冒充工作目标');
    assert.equal(input.nextStep, undefined, '导入不自动创建需要确认交接的模板待办');
    const card = { id: `card-${creates}`, title: input.title } as NativeWorkCard;
    useWorkLedger.setState({ cards: [...useWorkLedger.getState().cards, card] }); return card;
  }, upsertSession: async (input) => {
    const next = { ...record, ...input }; useWorkLedger.setState({ sessions: [next] }); return next;
  } });
  try {
    const cards = await Promise.all([promoteWorkSessionToCard(record), promoteWorkSessionToCard(record.id)]);
    assert.equal(creates, 1); assert.equal(cards[0].id, cards[1].id);
    assert.equal((await promoteWorkSessionToCard(record)).id, cards[0].id); assert.equal(creates, 1);
    assert.equal(useWorkLedger.getState().sessions[0].controlMode, 'readonly');
  } finally { useWorkLedger.setState(previous); }
});

test('绑定失败后的重试复用创建身份，不建孤立重复卡片；同 native ID 不同来源分开', async () => {
  const previous = useWorkLedger.getState(); const requests: string[] = []; let failBinding = true;
  const records = [session(), session('two', 'source-b')];
  useWorkLedger.setState({ cards: [], sessions: records, createCard: async (input) => {
    requests.push(input.requestId!); return { id: input.requestId, title: input.title } as NativeWorkCard;
  }, upsertSession: async (input) => {
    if (failBinding) throw new Error('写入失败');
    const index = useWorkLedger.getState().sessions.findIndex((item) => item.sourceScope === input.sourceScope);
    const next = { ...records[index], ...input };
    useWorkLedger.setState({ sessions: useWorkLedger.getState().sessions.map((item, i) => i === index ? next : item) }); return next;
  } });
  try {
    await assert.rejects(promoteWorkSessionToCard(records[0]), /写入失败/);
    assert.equal(useWorkLedger.getState().sessions[0].todoId, null);
    failBinding = false;
    await promoteWorkSessionToCard(records[0]); await promoteWorkSessionToCard(records[1]);
    assert.equal(requests[0], requests[1]); assert.notEqual(requests[1], requests[2]);
  } finally { useWorkLedger.setState(previous); }
});

test('扫描覆盖原生300条上限且扫描失败向调用方报告', async () => {
  const previous = useWorkLedger.getState(); const previousPi = useCodexWorkspace.getState();
  const previousAcp = useAcpAgents.getState(); const previousShared = useSharedAgent.getState();
  let requestedLimit: number | undefined; let upserts = 0; let fail = false;
  useCodexWorkspace.setState({ threads: [] }); useAcpAgents.setState({ sessions: {} }); useSharedAgent.setState({ sessions: {} });
  useWorkLedger.setState({ sessions: [], cards: [], upsertSession: async (input) => { upserts += 1; return { ...session(), ...input }; } });
  const restore = setSuperAgentRuntimeDriversForTests({ discoverLocalSessions: async (limit) => {
    requestedLimit = limit; if (fail) throw new Error('本机会话目录无法读取');
    return Array.from({ length: 101 }, (_, i) => ({ provider: 'codex', preset: 'codex-acp', nativeSessionId: `native-${i}`,
      sourceScope: 'source-a', title: `工作${i}`, workspaceRoot: 'D:/project', preview: null, stepCount: null,
      sourcePath: null, runtimeStatus: 'unknown', createdAt: 1, updatedAt: 1 }));
  } });
  try {
    assert.equal(await syncLiveSessionsIntoLedger(), 101); assert.equal(requestedLimit, 300); assert.equal(upserts, 101);
    fail = true; await assert.rejects(syncLiveSessionsIntoLedger(), /本机会话目录无法读取/);
  } finally { restore(); useWorkLedger.setState(previous); useCodexWorkspace.setState(previousPi); useAcpAgents.setState(previousAcp); useSharedAgent.setState(previousShared); }
});

test('账号切换后不把旧导入绑定到新账号，即使随后切回也不继续', async () => {
  const previous = useWorkLedger.getState(); const previousAuth = useAuth.getState();
  let release!: (card: NativeWorkCard) => void; let bindings = 0;
  const record = session();
  useWorkLedger.setState({ cards: [], sessions: [record], createCard: async () => new Promise((resolve) => { release = resolve; }),
    upsertSession: async () => { bindings += 1; return record; } });
  try {
    const pending = promoteWorkSessionToCard(record);
    await Promise.resolve();
    useAuth.setState({ user: { _id: 'other-account', username: 'other' } as any }); useAuth.setState({ user: previousAuth.user });
    release({ id: 'old-card', title: '旧任务' } as NativeWorkCard);
    await assert.rejects(pending, /账号已切换/); assert.equal(bindings, 0);
  } finally { useWorkLedger.setState(previous); useAuth.setState(previousAuth); }
});

test('完整来源身份区分provider、scope、项目大小写和拥有配置，不按native ID误匹配', () => {
  const record = { ...session(), workspaceRoot: '/Projects/Alpha' };
  const item = { provider: 'codex', preset: 'codex-acp', nativeSessionId: record.nativeSessionId,
    sourceScope: record.sourceScope, title: record.title!, workspaceRoot: record.workspaceRoot,
    preview: null, sourcePath: null, runtimeStatus: 'unknown', createdAt: 1, updatedAt: 1, stepCount: null };
  assert.equal(matchesDiscoveredWorkSession(record, item), true);
  assert.equal(matchesDiscoveredWorkSession(record, { ...item, provider: 'claude' }), false);
  assert.equal(matchesDiscoveredWorkSession(record, { ...item, sourceScope: 'another-source' }), false);
  assert.equal(matchesDiscoveredWorkSession(record, { ...item, workspaceRoot: '/Projects/alpha' }), false);
  assert.notEqual(workSessionImportIdentity(record), workSessionImportIdentity({ ...record, workspaceRoot: '/Projects/alpha' }));
  assert.equal(matchesDiscoveredWorkSession(record, { ...item, executionProfileId: 'unrelated-profile' }), false);
});

test('扫描返回时账号已切换，不写入旧来源到新账号', async () => {
  const previous = useWorkLedger.getState(); const previousAuth = useAuth.getState();
  const previousPi = useCodexWorkspace.getState(); const previousAcp = useAcpAgents.getState(); const previousShared = useSharedAgent.getState();
  useCodexWorkspace.setState({ threads: [] }); useAcpAgents.setState({ sessions: {} }); useSharedAgent.setState({ sessions: {} });
  let release!: (value: any[]) => void; let writes = 0;
  useWorkLedger.setState({ cards: [], sessions: [], upsertSession: async () => { writes += 1; return session(); } });
  const restore = setSuperAgentRuntimeDriversForTests({ discoverLocalSessions: async () => new Promise((resolve) => { release = resolve; }) });
  try {
    const pending = syncLiveSessionsIntoLedger();
    useAuth.setState({ user: { _id: 'other-account', username: 'other' } as any }); useAuth.setState({ user: previousAuth.user });
    release([]); await assert.rejects(pending, /账号已切换/); assert.equal(writes, 0);
  } finally { restore(); useWorkLedger.setState(previous); useAuth.setState(previousAuth); useCodexWorkspace.setState(previousPi); useAcpAgents.setState(previousAcp); useSharedAgent.setState(previousShared); }
});
