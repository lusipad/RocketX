import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import type {
  AppServerControllerOptions,
  CodexCatalog,
  CodexRuntimeSelection,
} from '../../apps/web/src/agent/AppServerController';
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

function ensureTauriWindow(): void {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
    });
  }
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke: async () => [] },
  });
}

async function loadModules() {
  ensureTauriWindow();
  const [{ useAuth }, sharedAgent, sessionStore, clientModule, codexWorkspace] = await Promise.all([
    import('../../apps/web/src/stores/auth'),
    import('../../apps/web/src/stores/sharedAgent'),
    import('../../apps/web/src/agent/sessionStore'),
    import('../../apps/web/src/lib/client'),
    import('../../apps/web/src/stores/codexWorkspace'),
  ]);
  return { useAuth, ...sharedAgent, ...sessionStore, clientModule, ...codexWorkspace };
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
  selections: CodexRuntimeSelection[];
  stopped: boolean;
  options: AppServerControllerOptions;
}

const CATALOG: CodexCatalog = {
  models: [{
    id: 'gpt-test',
    model: 'gpt-test',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT Test',
    description: 'test',
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'careful' }],
    defaultReasoningEffort: 'high',
    inputModalities: ['text'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  }, {
    id: 'gpt-hosting',
    model: 'gpt-hosting',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT Hosting',
    description: 'heavy work',
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'careful' }],
    defaultReasoningEffort: 'high',
    inputModalities: ['text'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  }],
  permissionProfiles: [
    { id: ':workspace', description: null, allowed: true },
    { id: ':danger-full-access', description: null, allowed: true },
  ],
  skills: [],
  apps: [],
  plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
};

function fakeController(
  options: AppServerControllerOptions,
  request: (method: string) => Promise<unknown>,
): { controller: { currentCatalog?: CodexCatalog; processInfo: { version: string; runtimeSource: 'system' } }; state: FakeClientState } {
  const state: FakeClientState = { calls: [], selections: [], stopped: false, options };
  const controller = {
    currentCatalog: undefined as CodexCatalog | undefined,
    processInfo: { version: '0.144.4', runtimeSource: 'system' as const },
    connect: async () => {
      state.calls.push('connect');
      controller.currentCatalog = CATALOG;
      return CATALOG;
    },
    startThread: async (selection: CodexRuntimeSelection) => {
      state.calls.push('startThread');
      state.selections.push(selection);
      return request('startThread') as Promise<{ id: string }>;
    },
    resumeThread: async (_threadId: string, selection: CodexRuntimeSelection) => {
      state.calls.push('resumeThread');
      state.selections.push(selection);
      return request('resumeThread') as Promise<{ id: string }>;
    },
    startTurn: async () => {
      state.calls.push('startTurn');
      return request('startTurn') as Promise<string>;
    },
    interruptTurn: async () => {
      state.calls.push('interruptTurn');
    },
    renameThread: async () => {
      state.calls.push('renameThread');
    },
    stop: async () => {
      state.stopped = true;
    },
  };
  return { controller, state };
}

function failingConnectController(
  options: AppServerControllerOptions,
  message: string,
): { controller: { currentCatalog?: CodexCatalog }; state: FakeClientState } {
  const state: FakeClientState = { calls: [], selections: [], stopped: false, options };
  const controller = {
    currentCatalog: undefined as CodexCatalog | undefined,
    connect: async () => {
      state.calls.push('connect');
      throw new Error(message);
    },
    startThread: async () => {
      state.calls.push('startThread');
      return { id: 'unused' };
    },
    resumeThread: async () => {
      state.calls.push('resumeThread');
      return { id: 'unused' };
    },
    startTurn: async () => {
      state.calls.push('startTurn');
      return 'unused';
    },
    interruptTurn: async () => {
      state.calls.push('interruptTurn');
    },
    renameThread: async () => {
      state.calls.push('renameThread');
    },
    stop: async () => {
      state.stopped = true;
    },
  };
  return { controller, state };
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

test('AI 托管拒绝临时会话和管家系统目录', { concurrency: false }, async () => {
  const { useSharedAgent, useCodexWorkspace } = await loadModules();
  await prepareStore([]);
  useCodexWorkspace.setState({
    scope: 'same-origin:host-user',
    defaultWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    butlerWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
    workspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
  });

  await assert.rejects(
    useSharedAgent.getState().startSession('room-system', 'thread-system', {
      workspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    }),
    /AI 托管必须选择在 AI 管家中添加的专用工作项目/,
  );
  await assert.rejects(
    useSharedAgent.getState().startSession('room-butler', 'thread-butler', {
      workspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
    }),
    /AI 托管必须选择在 AI 管家中添加的专用工作项目/,
  );
});

test('AI 托管恢复会话时使用独立模型与推理强度，权限仍跟随管家', { concurrency: false }, async () => {
  const target = interruptedSession('hosting-profile');
  const { useSharedAgent, useCodexWorkspace, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target]);
  useCodexWorkspace.setState({
    selectedModel: 'gpt-test',
    selectedEffort: 'medium',
    hostingModel: 'gpt-hosting',
    hostingEffort: 'high',
    permissionPreset: 'auto',
  });
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async () => ({ id: target.codexThreadId! }));
    fake = built.state;
    return built.controller as never;
  });

  try {
    await useSharedAgent.getState().resumeSession(target.tmid);
    assert.deepEqual(fake.selections.at(-1), {
      model: 'gpt-hosting',
      effort: 'high',
      permissionPreset: 'auto',
    });
  } finally {
    restoreFactory();
  }
});

test('共享 Agent 在 Controller connect 失败后离开 starting，并保留同一线程供显式重试', { concurrency: false }, async () => {
  const target = interruptedSession('client-start-failed');
  const other = interruptedSession('client-start-other', { activeTurnId: undefined });
  const { useSharedAgent, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target, other]);
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    return failingConnectController(options, 'client start failed').controller as never;
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
  const { useSharedAgent, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([original]);
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'resumeThread') throw new Error('thread/resume 测试失败');
      return { id: original.codexThreadId! };
    });
    fake = built.state;
    return built.controller as never;
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
    assert.deepEqual(fake.calls, ['connect', 'resumeThread']);
  } finally {
    restoreFactory();
  }
});

test('共享 Agent 在 resume 中收到 app-server 退出时清理本会话审批且不污染其他会话', { concurrency: false }, async () => {
  const target = interruptedSession('resume-exit');
  const other = interruptedSession('other-session', { activeTurnId: undefined });
  const { useSharedAgent, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target, other]);
  useSharedAgent.setState({
    approvals: [
      { id: 'approval-target', tmid: target.tmid, method: 'applyPatchApproval', policy: 'legacy-approval', params: {} },
      { id: 'approval-other', tmid: other.tmid, method: 'applyPatchApproval', policy: 'legacy-approval', params: {} },
    ],
  });
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'resumeThread') {
        const error = new Error('Codex app-server 已退出（137）');
        options.onInterrupted?.(error);
        throw error;
      }
      return { id: target.codexThreadId! };
    });
    return built.controller as never;
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

test('共享 Agent 的 thread/resume 超时错误会回到 interrupted，且错误仅落到目标会话', { concurrency: false }, async () => {
  const target = interruptedSession('resume-timeout');
  const other = interruptedSession('resume-timeout-other', { activeTurnId: undefined });
  const { useSharedAgent, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target, other]);
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'resumeThread') throw new Error('请求超时：thread/resume');
      return { id: target.codexThreadId! };
    });
    return built.controller as never;
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
  }
});

test('共享 Agent 在恢复成功后租约卡片同步失败时保持 ready，并留下可诊断 warning', { concurrency: false }, async () => {
  const target = interruptedSession('resume-card-warning', { leaseMessageId: 'lease-message-1' });
  const { useSharedAgent, setSharedAgentControllerFactory, clientModule } = await loadModules();
  await prepareStore([target]);
  const originalUpdateMessage = clientModule.rest.updateMessage.bind(clientModule.rest);
  clientModule.rest.updateMessage = async () => {
    throw new Error('rocket.chat updateMessage failed');
  };
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'resumeThread') return { id: target.codexThreadId! };
      return { id: target.codexThreadId! };
    });
    fake = built.state;
    return built.controller as never;
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
  const { useSharedAgent, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target, other]);
  let resumeAttempts = 0;
  const calls: string[] = [];
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      calls.push(method);
      if (method !== 'resumeThread') return { id: target.codexThreadId! };
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw new Error('Codex app-server 请求超时：thread/resume');
      return { id: target.codexThreadId! };
    });
    return built.controller as never;
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
    assert.equal(calls.includes('startTurn'), false);
  } finally {
    restoreFactory();
  }
});

test('共享 Agent 审批区分拒绝、允许一次和本次任务允许', { concurrency: false }, async () => {
  const { sharedAgentApprovalResult } = await loadModules();
  assert.deepEqual(
    sharedAgentApprovalResult('item/commandExecution/requestApproval', 'decline'),
    { decision: 'decline' },
  );
  assert.deepEqual(
    sharedAgentApprovalResult('item/commandExecution/requestApproval', 'accept'),
    { decision: 'accept' },
  );
  assert.deepEqual(
    sharedAgentApprovalResult('item/commandExecution/requestApproval', 'accept-session'),
    { decision: 'acceptForSession' },
  );
  assert.deepEqual(
    sharedAgentApprovalResult('item/permissions/requestApproval', 'accept-session', { network: true }),
    { permissions: { network: true }, scope: 'session', strictAutoReview: true },
  );
});
