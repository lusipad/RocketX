import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import { AppServerClient, type AppServerClientOptions } from '../../apps/web/src/agent/protocol/client';
import type { AgentSession } from '../../apps/web/src/agent/session';

const values = new Map<string, string>();
let restoreAgentSessionAppData: (() => void) | undefined;
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => void values.delete(key),
  setItem: (key, value) => void values.set(key, String(value)),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

test.afterEach(() => {
  restoreAgentSessionAppData?.();
  restoreAgentSessionAppData = undefined;
});

async function loadModules() {
  const [{ useAuth }, sharedAgent, sessionStore, clientModule] = await Promise.all([
    import('../../apps/web/src/stores/auth'),
    import('../../apps/web/src/stores/sharedAgent'),
    import('../../apps/web/src/agent/sessionStore'),
    import('../../apps/web/src/lib/client'),
  ]);
  return { useAuth, ...sharedAgent, ...sessionStore, clientModule };
}

function interruptedSession(tmid: string, overrides: Partial<AgentSession> = {}): AgentSession {
  const now = Date.now();
  return {
    sessionId: `session-${tmid}`,
    serverId: 'same-origin',
    ownerUserId: 'host-user',
    rid: `room-${tmid}`,
    tmid,
    host: {
      userId: 'host-user',
      deviceId: 'device-a',
      heartbeatAt: now,
      expiresAt: now + 60_000,
    },
    access: 'room-members',
    approvedMemberIds: [],
    status: 'interrupted',
    codexThreadId: `codex-${tmid}`,
    activeTurnId: `stale-turn-${tmid}`,
    workspaceRoots: ['D:/Repos/example'],
    sandboxMode: 'read-only',
    updatedAt: now,
    ...overrides,
  };
}

interface FakeClientState {
  calls: string[];
  stopped: boolean;
  options: AppServerClientOptions;
}

interface FakeTransport {
  startHandlers?: { onLine: (line: string) => void; onExit: (code: number | null) => void };
  stopCalled: boolean;
  writes: Array<Record<string, unknown>>;
}

function fakeClient(
  options: AppServerClientOptions,
  request: (method: string) => Promise<unknown>,
): { client: AppServerClient; state: FakeClientState } {
  const state: FakeClientState = { calls: [], stopped: false, options };
  const client = {
    processInfo: { processId: 'fake', version: '0.144.4', runtimeSource: 'system' },
    request: async (method: string) => {
      state.calls.push(method);
      if (method === 'thread/name/set') return {};
      return request(method);
    },
    stop: async () => {
      state.stopped = true;
    },
  } as unknown as AppServerClient;
  return { client, state };
}

function fakeTransport(): { transport: ConstructorParameters<typeof AppServerClient>[0]; state: FakeTransport } {
  const state: FakeTransport = { stopCalled: false, writes: [] };
  return {
    transport: {
      start: async (handlers) => {
        state.startHandlers = handlers;
        return { processId: 'transport', version: '0.144.4', runtimeSource: 'system' as const };
      },
      write: async (message) => {
        state.writes.push(message);
        if (message.method === 'initialize') {
          queueMicrotask(() => state.startHandlers?.onLine(JSON.stringify({ id: message.id, result: { userAgent: 'rocketx/0.144.4' } })));
          return;
        }
        if (message.method === 'initialized') return;
      },
      stop: async () => {
        state.stopCalled = true;
      },
    },
    state,
  };
}

function withShortClientTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const shortened = timeout === 15_000 ? 5 : timeout;
    return originalSetTimeout(handler, shortened as number, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => originalClearTimeout(handle)) as typeof clearTimeout;
  return () => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  };
}

async function prepareStore(sessions: AgentSession[]) {
  const { useAuth, useSharedAgent, setAgentSessionAppData } = await loadModules();
  values.clear();
  localStorage.setItem('rcx-agent-device-id', 'device-a');
  restoreAgentSessionAppData = setAgentSessionAppData(
    createRcxStore({ backend: createMemoryBackend() }).appData,
  );
  useAuth.setState({ user: { _id: 'host-user', username: 'host' } as never });
  useSharedAgent.setState({
    sessions: Object.fromEntries(sessions.map((session) => [session.tmid, session])),
    remoteCards: {},
    traces: {},
    approvals: [],
    memberRequests: [],
    error: null,
  });
  return { useAuth, useSharedAgent };
}

test('共享 Agent 在 ensureClient 失败后离开 starting，并保留同一线程供显式重试', { concurrency: false }, async () => {
  const target = interruptedSession('client-start-failed');
  const other = interruptedSession('client-start-other', { activeTurnId: undefined });
  const { useSharedAgent, setSharedAgentClientFactory } = await loadModules();
  await prepareStore([target, other]);
  const restoreFactory = setSharedAgentClientFactory(async () => {
    throw new Error('client start failed');
  });

  try {
    await assert.rejects(() => useSharedAgent.getState().resumeSession(target.tmid), /client start failed/);
    const state = useSharedAgent.getState();
    assert.equal(state.sessions[target.tmid]?.status, 'interrupted');
    assert.equal(state.sessions[target.tmid]?.codexThreadId, target.codexThreadId);
    assert.deepEqual(state.sessions[target.tmid]?.workspaceRoots, target.workspaceRoots);
    assert.equal(state.sessions[target.tmid]?.activeTurnId, undefined);
    assert.match(state.sessions[target.tmid]?.lastError ?? '', /client start failed/);
    assert.equal(state.sessions[other.tmid]?.lastError, undefined);
    assert.equal(state.error, null);
  } finally {
    restoreFactory();
  }
});

test('共享 Agent 的 thread/resume 明确失败后离开 starting，并保留同一线程供显式重试', { concurrency: false }, async () => {
  const original = interruptedSession('resume-explicit-error');
  const { useSharedAgent, setSharedAgentClientFactory } = await loadModules();
  await prepareStore([original]);
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentClientFactory(async (_sessionId, _workspaceRoot, options) => {
    const built = fakeClient(options, async (method) => {
      if (method === 'thread/resume') throw new Error('thread/resume 测试失败');
      return {};
    });
    fake = built.state;
    return built.client;
  });

  try {
    await assert.rejects(() => useSharedAgent.getState().resumeSession(original.tmid), /thread\/resume 测试失败/);
    const failed = useSharedAgent.getState().sessions[original.tmid];
    assert.equal(failed?.status, 'interrupted');
    assert.equal(failed?.codexThreadId, original.codexThreadId);
    assert.deepEqual(failed?.workspaceRoots, original.workspaceRoots);
    assert.equal(failed?.activeTurnId, undefined);
    assert.match(failed?.lastError ?? '', /thread\/resume 测试失败/);
    assert.equal(fake.stopped, true);
    assert.deepEqual(fake.calls, ['thread/resume']);
  } finally {
    restoreFactory();
  }
});

test('共享 Agent 在 resume 中收到 app-server 退出时清理本会话审批且不污染其他会话', { concurrency: false }, async () => {
  const target = interruptedSession('resume-exit');
  const other = interruptedSession('other-session', { activeTurnId: undefined });
  const { useSharedAgent, setSharedAgentClientFactory } = await loadModules();
  await prepareStore([target, other]);
  useSharedAgent.setState({
    approvals: [
      { id: 'approval-target', tmid: target.tmid, method: 'applyPatchApproval', policy: 'legacy-approval', params: {} },
      { id: 'approval-other', tmid: other.tmid, method: 'applyPatchApproval', policy: 'legacy-approval', params: {} },
    ],
  });
  const restoreFactory = setSharedAgentClientFactory(async (_sessionId, _workspaceRoot, options) => {
    const built = fakeClient(options, async (method) => {
      if (method === 'thread/resume') {
        const error = new Error('Codex app-server 已退出（137）');
        options.onInterrupted?.(error);
        throw error;
      }
      return {};
    });
    return built.client;
  });

  try {
    await assert.rejects(() => useSharedAgent.getState().resumeSession(target.tmid), /已退出/);
    const state = useSharedAgent.getState();
    assert.equal(state.sessions[target.tmid]?.status, 'interrupted');
    assert.match(state.sessions[target.tmid]?.lastError ?? '', /已退出/);
    assert.equal(state.sessions[other.tmid]?.status, 'interrupted');
    assert.equal(state.sessions[other.tmid]?.lastError, undefined);
    assert.deepEqual(state.approvals.map((approval) => approval.id), ['approval-other']);
  } finally {
    restoreFactory();
  }
});

test('共享 Agent 的 thread/resume 真实超时后会回到 interrupted，且错误仅落到目标会话', { concurrency: false }, async () => {
  const target = interruptedSession('resume-timeout');
  const other = interruptedSession('resume-timeout-other', { activeTurnId: undefined });
  const { useSharedAgent, setSharedAgentClientFactory } = await loadModules();
  await prepareStore([target, other]);
  const restoreTimeout = withShortClientTimeout();
  const restoreFactory = setSharedAgentClientFactory(async (_sessionId, _workspaceRoot, options) => {
    const { transport } = fakeTransport();
    const client = new AppServerClient(transport, options);
    await client.start();
    return client;
  });

  try {
    await assert.rejects(() => useSharedAgent.getState().resumeSession(target.tmid), /请求超时：thread\/resume/);
    const state = useSharedAgent.getState();
    assert.equal(state.sessions[target.tmid]?.status, 'interrupted');
    assert.equal(state.sessions[target.tmid]?.activeTurnId, undefined);
    assert.match(state.sessions[target.tmid]?.lastError ?? '', /请求超时：thread\/resume/);
    assert.equal(state.sessions[other.tmid]?.lastError, undefined);
  } finally {
    restoreFactory();
    restoreTimeout();
  }
});

test('共享 Agent 在恢复成功后租约卡片同步失败时保持 ready，并留下可诊断 warning', { concurrency: false }, async () => {
  const target = interruptedSession('resume-card-warning', { leaseMessageId: 'lease-message-1' });
  const { useSharedAgent, setSharedAgentClientFactory, clientModule } = await loadModules();
  await prepareStore([target]);
  const originalUpdateMessage = clientModule.rest.updateMessage.bind(clientModule.rest);
  clientModule.rest.updateMessage = async () => {
    throw new Error('rocket.chat updateMessage failed');
  };
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentClientFactory(async (_sessionId, _workspaceRoot, options) => {
    const built = fakeClient(options, async (method) => {
      if (method === 'thread/resume') return { thread: { id: target.codexThreadId } };
      return {};
    });
    fake = built.state;
    return built.client;
  });

  try {
    await useSharedAgent.getState().resumeSession(target.tmid);
    const state = useSharedAgent.getState();
    assert.equal(state.sessions[target.tmid]?.status, 'ready');
    assert.equal(state.sessions[target.tmid]?.lastError, undefined);
    assert.equal(fake.stopped, false);
    assert.match(state.traces[target.tmid]?.at(-1)?.text ?? '', /同步租约卡片失败/);
  } finally {
    restoreFactory();
    clientModule.rest.updateMessage = originalUpdateMessage;
  }
});

test('共享 Agent 失败后再次显式恢复成功，不会自动重放旧 turn 或跨会话错误', { concurrency: false }, async () => {
  const target = interruptedSession('resume-retry');
  const other = interruptedSession('retry-other', { activeTurnId: undefined });
  const { useSharedAgent, setSharedAgentClientFactory } = await loadModules();
  await prepareStore([target, other]);
  let resumeAttempts = 0;
  const calls: string[] = [];
  const restoreFactory = setSharedAgentClientFactory(async (_sessionId, _workspaceRoot, options) => {
    const built = fakeClient(options, async (method) => {
      calls.push(method);
      if (method !== 'thread/resume') return {};
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw new Error('Codex app-server 请求超时：thread/resume');
      return { thread: { id: target.codexThreadId } };
    });
    return built.client;
  });

  try {
    await assert.rejects(() => useSharedAgent.getState().resumeSession(target.tmid), /请求超时/);
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'interrupted');

    await useSharedAgent.getState().resumeSession(target.tmid);
    const state = useSharedAgent.getState();
    assert.equal(state.sessions[target.tmid]?.status, 'ready');
    assert.equal(state.sessions[target.tmid]?.lastError, undefined);
    assert.equal(state.sessions[other.tmid]?.lastError, undefined);
    assert.equal(resumeAttempts, 2);
    assert.equal(calls.includes('turn/start'), false);
  } finally {
    restoreFactory();
  }
});
