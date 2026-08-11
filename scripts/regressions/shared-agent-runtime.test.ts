import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import type {
  AppServerControllerOptions,
  CodexCatalog,
  CodexRuntimeSelection,
} from '../../apps/web/src/agent/AppServerController';
import type { AgentSession } from '../../apps/web/src/agent/session';
import type { RcMessage } from '@rcx/rc-client';

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

test.afterEach(async () => {
  try {
    const { useSharedAgent } = await loadModules();
    for (const tmid of Object.keys(useSharedAgent.getState().sessions)) {
      await useSharedAgent.getState().endSession(tmid).catch(() => undefined);
    }
  } catch {
    /* 模块尚未加载或已在失败路径中，忽略清理异常 */
  }
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

type SharedAgentModules = Awaited<ReturnType<typeof loadModules>>;

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

function commandMessage(tmid: string, userId: string, username: string, messageId = userId): RcMessage {
  return {
    _id: `message-${tmid}-${messageId}`,
    rid: `room-${tmid}`,
    tmid,
    msg: '@ai 请检查当前进度',
    ts: new Date().toISOString(),
    u: { _id: userId, username, name: username },
  };
}

function readySession(tmid: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return interruptedSession(tmid, {
    status: 'ready',
    activeTurnId: undefined,
    ...overrides,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function controllerStateBySessionId(states: FakeClientState[], tmid: string): FakeClientState {
  const state = states.find((item) => item.connectedSessionId === `session-${tmid}`);
  assert.ok(state, `缺少 ${tmid} 的 controller 状态`);
  return state;
}

interface FakeClientState {
  calls: string[];
  selections: CodexRuntimeSelection[];
  stopped: boolean;
  options: AppServerControllerOptions;
  connectedSessionId?: string;
  interruptedTurns: Array<{ threadId: string; turnId: string }>;
}

type FakeControllerRequest = (method: string, state: FakeClientState) => Promise<unknown>;

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
  request: FakeControllerRequest,
): { controller: { currentCatalog?: CodexCatalog; processInfo: { version: string; runtimeSource: 'system' } }; state: FakeClientState } {
  const state: FakeClientState = {
    calls: [],
    selections: [],
    stopped: false,
    options,
    interruptedTurns: [],
  };
  const controller = {
    currentCatalog: undefined as CodexCatalog | undefined,
    processInfo: { version: '0.144.4', runtimeSource: 'system' as const },
    connect: async (sessionId: string) => {
      state.calls.push('connect');
      state.connectedSessionId = sessionId;
      controller.currentCatalog = CATALOG;
      return CATALOG;
    },
    startThread: async (selection: CodexRuntimeSelection) => {
      state.calls.push('startThread');
      state.selections.push(selection);
      return request('startThread', state) as Promise<{ id: string }>;
    },
    resumeThread: async (_threadId: string, selection: CodexRuntimeSelection) => {
      state.calls.push('resumeThread');
      state.selections.push(selection);
      return request('resumeThread', state) as Promise<{ id: string }>;
    },
    startTurn: async (_threadId: string, _input: unknown, selection: CodexRuntimeSelection) => {
      state.calls.push('startTurn');
      state.selections.push(selection);
      return request('startTurn', state) as Promise<string>;
    },
    interruptTurn: async (threadId: string, turnId: string) => {
      state.calls.push('interruptTurn');
      state.interruptedTurns.push({ threadId, turnId });
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
  const state: FakeClientState = {
    calls: [],
    selections: [],
    stopped: false,
    options,
    interruptedTurns: [],
  };
  const controller = {
    currentCatalog: undefined as CodexCatalog | undefined,
    connect: async (sessionId: string) => {
      state.calls.push('connect');
      state.connectedSessionId = sessionId;
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
    startTurn: async (_threadId: string, _input: unknown, selection: CodexRuntimeSelection) => {
      state.calls.push('startTurn');
      state.selections.push(selection);
      return 'unused';
    },
    interruptTurn: async (threadId: string, turnId: string) => {
      state.calls.push('interruptTurn');
      state.interruptedTurns.push({ threadId, turnId });
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
    inputs: [],
    memberRequests: [],
    error: null,
  });
  return { useAuth, useSharedAgent };
}

const DEFAULT_HOSTING_RUNTIME = {
  hostingModel: 'gpt-test',
  hostingEffort: 'high',
  permissionPreset: 'auto' as const,
};

type BotInvocation = { command: string; args?: Record<string, unknown> };

interface SharedThreadHarness {
  first: AgentSession;
  second: AgentSession;
  useSharedAgent: SharedAgentModules['useSharedAgent'];
  states: FakeClientState[];
  restoreFactory: () => void;
}

function setHostingRuntime(
  useCodexWorkspace: SharedAgentModules['useCodexWorkspace'],
  overrides: Partial<typeof DEFAULT_HOSTING_RUNTIME> = {},
): void {
  useCodexWorkspace.setState({
    ...DEFAULT_HOSTING_RUNTIME,
    ...overrides,
  });
}

function installInvokeRecorder(): BotInvocation[] {
  const invocations: BotInvocation[] = [];
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        invocations.push({ command, args });
        return [];
      },
    },
  });
  return invocations;
}

async function setupSharedThreadHarness(
  first: AgentSession,
  second: AgentSession,
  request: FakeControllerRequest,
): Promise<SharedThreadHarness> {
  const { useSharedAgent, setSharedAgentControllerFactory, useCodexWorkspace } = await loadModules();
  await prepareStore([first, second]);
  setHostingRuntime(useCodexWorkspace);
  const states: FakeClientState[] = [];
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, request);
    states.push(built.state);
    return built.controller as never;
  });
  return { first, second, useSharedAgent, states, restoreFactory };
}

function sharedThreadControllers(harness: SharedThreadHarness): {
  firstController: FakeClientState;
  secondController: FakeClientState;
} {
  return {
    firstController: controllerStateBySessionId(harness.states, harness.first.tmid),
    secondController: controllerStateBySessionId(harness.states, harness.second.tmid),
  };
}

async function startSharedThreadCommands(harness: SharedThreadHarness): Promise<{
  runFirst: Promise<void>;
  runSecond: Promise<void>;
  firstController: FakeClientState;
  secondController: FakeClientState;
}> {
  const runFirst = harness.useSharedAgent.getState().handleMessage(
    commandMessage(harness.first.tmid, harness.first.host.userId, 'host'),
  );
  const runSecond = harness.useSharedAgent.getState().handleMessage(
    commandMessage(harness.second.tmid, harness.second.host.userId, 'host'),
  );
  await waitFor(() => harness.states.filter((state) => state.calls.includes('startTurn')).length === 2);
  return {
    runFirst,
    runSecond,
    ...sharedThreadControllers(harness),
  };
}

async function resumeSharedThreadSessions(harness: SharedThreadHarness): Promise<{
  firstController: FakeClientState;
  secondController: FakeClientState;
}> {
  await harness.useSharedAgent.getState().resumeSession(harness.first.tmid);
  await harness.useSharedAgent.getState().resumeSession(harness.second.tmid);
  return sharedThreadControllers(harness);
}

function itemsByTmid<T extends { tmid: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.tmid, item]));
}

function recordedReplies(invocations: BotInvocation[]): Array<{ rid: unknown; tmid: unknown; text: unknown }> {
  return invocations
    .filter((entry) => entry.command === 'agent_bot_send' && typeof entry.args?.text === 'string')
    .filter((entry) => entry.args?.text !== '🤖 Codex 已收到，正在思考…')
    .map((entry) => ({ rid: entry.args?.rid, tmid: entry.args?.tmid, text: entry.args?.text }))
    .sort((left, right) => String(left.tmid).localeCompare(String(right.tmid)));
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

test('仅宿主模式静默忽略非宿主指令，不向房间冒出权限拒绝', { concurrency: false }, async () => {
  const target = interruptedSession('host-only-silent', {
    status: 'ready',
    activeTurnId: undefined,
    access: 'host-only',
  });
  const { useSharedAgent } = await loadModules();
  await prepareStore([target]);
  const chat = await import('../../apps/web/src/stores/chat');
  const sends: string[] = [];
  const originalSend = chat.useChat.getState().send;
  chat.useChat.setState({
    send: (async (text: string) => {
      sends.push(text);
      return { id: 'unexpected', delivery: 'server' as const };
    }) as typeof originalSend,
  });

  try {
    await useSharedAgent.getState().handleMessage(commandMessage(target.tmid, 'member-user', 'member'));
    assert.deepEqual(sends, []);
  } finally {
    chat.useChat.setState({ send: originalSend });
  }
});

test('AI 托管在执行期间先向房间发送持续可见的思考反馈', { concurrency: false }, async () => {
  const target = interruptedSession('thinking-feedback', {
    status: 'ready',
    activeTurnId: undefined,
  });
  const { useSharedAgent, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target]);
  const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        invocations.push({ command, args });
        return [];
      },
    },
  });
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'startTurn') return 'turn-thinking-feedback';
      return { id: target.codexThreadId! };
    });
    fake = built.state;
    return built.controller as never;
  });

  try {
    const handling = useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      invocations.some((entry) => entry.command === 'agent_bot_send'
        && entry.args?.text === '🤖 Codex 已收到，正在思考…'),
      true,
    );
    fake.options.onNotification?.('turn/completed', {
      threadId: target.codexThreadId,
      turn: { id: 'turn-thinking-feedback', status: 'completed' },
    });
    await handling;
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

test('共享 Agent 在相同 threadId 和 turnId 下并发输出仍按 tmid 隔离', { concurrency: false }, async () => {
  const first = readySession('collision-output-a', { codexThreadId: 'shared-thread' });
  const second = readySession('collision-output-b', { codexThreadId: 'shared-thread' });
  const harness = await setupSharedThreadHarness(first, second, async (method) => {
    if (method === 'startTurn') return 'shared-turn';
    return { id: 'shared-thread' };
  });
  const invocations = installInvokeRecorder();

  try {
    const {
      runFirst,
      runSecond,
      firstController,
      secondController,
    } = await startSharedThreadCommands(harness);

    firstController.options.onNotification?.('item/agentMessage/delta', { threadId: 'shared-thread', turnId: 'shared-turn', delta: 'first ' });
    secondController.options.onNotification?.('item/agentMessage/delta', { threadId: 'shared-thread', turnId: 'shared-turn', delta: 'second' });
    firstController.options.onNotification?.('turn/completed', { threadId: 'shared-thread', turn: { id: 'shared-turn', status: 'completed' } });
    secondController.options.onNotification?.('turn/completed', { threadId: 'shared-thread', turn: { id: 'shared-turn', status: 'completed' } });

    await Promise.all([
      withTimeout(runFirst, 'first command'),
      withTimeout(runSecond, 'second command'),
    ]);

    assert.deepEqual(recordedReplies(invocations), [
      { rid: first.rid, tmid: first.tmid, text: '🤖 Codex\nfirst' },
      { rid: second.rid, tmid: second.tmid, text: '🤖 Codex\nsecond' },
    ]);
  } finally {
    harness.restoreFactory();
  }
});

test('共享 Agent 对相同 threadId 的审批、输入与文件变更路径按 tmid 隔离', { concurrency: false }, async () => {
  const first = interruptedSession('collision-approval-a', { codexThreadId: 'shared-thread' });
  const second = interruptedSession('collision-approval-b', { codexThreadId: 'shared-thread' });
  const harness = await setupSharedThreadHarness(first, second, async () => ({ id: 'shared-thread' }));

  try {
    const { firstController, secondController } = await resumeSharedThreadSessions(harness);

    firstController.options.onNotification?.('item/started', { threadId: 'shared-thread', item: { id: 'shared-item', type: 'fileChange', changes: [{ path: 'D:/Repos/example/first.txt' }] } });
    secondController.options.onNotification?.('item/started', { threadId: 'shared-thread', item: { id: 'shared-item', type: 'fileChange', changes: [{ path: 'D:/Repos/example/second.txt' }] } });

    const approvalFirst = firstController.options.onServerRequest?.({ method: 'item/fileChange/requestApproval', params: { threadId: 'shared-thread', itemId: 'shared-item', grantRoot: 'D:/Repos/example' }, policy: 'host-approval' });
    const approvalSecond = secondController.options.onServerRequest?.({ method: 'item/fileChange/requestApproval', params: { threadId: 'shared-thread', itemId: 'shared-item', grantRoot: 'D:/Repos/example' }, policy: 'host-approval' });
    assert.ok(approvalFirst);
    assert.ok(approvalSecond);
    await waitFor(() => harness.useSharedAgent.getState().approvals.length === 2);

    const approvalsByTmid = itemsByTmid(harness.useSharedAgent.getState().approvals);
    assert.deepEqual(approvalsByTmid[first.tmid]?.params, {
      threadId: 'shared-thread',
      itemId: 'shared-item',
      grantRoot: 'D:/Repos/example',
      fileChanges: { 'D:/Repos/example/first.txt': true },
    });
    assert.deepEqual(approvalsByTmid[second.tmid]?.params, {
      threadId: 'shared-thread',
      itemId: 'shared-item',
      grantRoot: 'D:/Repos/example',
      fileChanges: { 'D:/Repos/example/second.txt': true },
    });

    let secondApprovalResolved = false;
    void approvalSecond.then(() => {
      secondApprovalResolved = true;
    });
    await harness.useSharedAgent.getState().resolveApproval(approvalsByTmid[first.tmid]!.id, 'accept');
    assert.deepEqual(await withTimeout(approvalFirst, 'first approval'), { decision: 'accept' });
    await nextTick();
    assert.equal(secondApprovalResolved, false);
    await harness.useSharedAgent.getState().resolveApproval(approvalsByTmid[second.tmid]!.id, 'decline');
    assert.deepEqual(await withTimeout(approvalSecond, 'second approval'), { decision: 'decline' });

    const inputFirst = firstController.options.onServerRequest?.({ method: 'item/tool/requestUserInput', params: { threadId: 'shared-thread', questions: [{ id: 'question', options: [{ label: 'Alpha' }] }] }, policy: 'host-input' });
    const inputSecond = secondController.options.onServerRequest?.({ method: 'item/tool/requestUserInput', params: { threadId: 'shared-thread', questions: [{ id: 'question', options: [{ label: 'Beta' }] }] }, policy: 'host-input' });
    assert.ok(inputFirst);
    assert.ok(inputSecond);
    await waitFor(() => harness.useSharedAgent.getState().inputs.length === 2);

    const inputsByTmid = itemsByTmid(harness.useSharedAgent.getState().inputs);
    assert.deepEqual(inputsByTmid[first.tmid]?.params, {
      threadId: 'shared-thread',
      questions: [{ id: 'question', options: [{ label: 'Alpha' }] }],
    });
    assert.deepEqual(inputsByTmid[second.tmid]?.params, {
      threadId: 'shared-thread',
      questions: [{ id: 'question', options: [{ label: 'Beta' }] }],
    });

    let secondInputResolved = false;
    void inputSecond.then(() => {
      secondInputResolved = true;
    });
    await harness.useSharedAgent.getState().resolveInput(inputsByTmid[first.tmid]!.id, {
      answers: { question: { answers: ['Alpha'] } },
    });
    assert.deepEqual(await withTimeout(inputFirst, 'first input'), {
      answers: { question: { answers: ['Alpha'] } },
    });
    await nextTick();
    assert.equal(secondInputResolved, false);
    await harness.useSharedAgent.getState().resolveInput(inputsByTmid[second.tmid]!.id, {
      answers: { question: { answers: ['Beta'] } },
    });
    assert.deepEqual(await withTimeout(inputSecond, 'second input'), {
      answers: { question: { answers: ['Beta'] } },
    });
  } finally {
    harness.restoreFactory();
  }
});

test('共享 Agent 一个会话失败时不会污染另一个相同 turnId 的会话', { concurrency: false }, async () => {
  const first = readySession('collision-failure-a', { codexThreadId: 'shared-thread' });
  const second = readySession('collision-failure-b', { codexThreadId: 'shared-thread' });
  const harness = await setupSharedThreadHarness(first, second, async (method) => {
    if (method === 'startTurn') return 'shared-turn';
    return { id: 'shared-thread' };
  });

  try {
    const {
      runFirst,
      runSecond,
      firstController,
      secondController,
    } = await startSharedThreadCommands(harness);

    firstController.options.onInterrupted?.(new Error('first controller exited'));
    secondController.options.onNotification?.('item/agentMessage/delta', { threadId: 'shared-thread', turnId: 'shared-turn', delta: 'second survives' });
    secondController.options.onNotification?.('turn/completed', { threadId: 'shared-thread', turn: { id: 'shared-turn', status: 'completed' } });

    await Promise.all([
      withTimeout(runFirst, 'first failed command'),
      withTimeout(runSecond, 'second completed command'),
    ]);

    const state = harness.useSharedAgent.getState();
    assert.equal(state.sessions[first.tmid]?.status, 'interrupted');
    assert.match(state.sessions[first.tmid]?.lastError ?? '', /first controller exited/);
    assert.equal(state.sessions[second.tmid]?.status, 'ready');
    assert.equal(state.sessions[second.tmid]?.lastError, undefined);
  } finally {
    harness.restoreFactory();
  }
});

test('共享 Agent 定向 stop 只释放目标 tmid 的挂起 turn，且不影响另一会话', { concurrency: false }, async () => {
  const first = readySession('collision-stop-a', { codexThreadId: 'shared-thread' });
  const second = readySession('collision-stop-b', { codexThreadId: 'shared-thread' });
  const harness = await setupSharedThreadHarness(first, second, async (method) => {
    if (method === 'startTurn') return 'shared-turn';
    return { id: 'shared-thread' };
  });

  try {
    const {
      runFirst,
      runSecond,
      firstController,
      secondController,
    } = await startSharedThreadCommands(harness);

    await harness.useSharedAgent.getState().endSession(first.tmid);
    secondController.options.onNotification?.('item/agentMessage/delta', { threadId: 'shared-thread', turnId: 'shared-turn', delta: 'second still running' });
    secondController.options.onNotification?.('turn/completed', { threadId: 'shared-thread', turn: { id: 'shared-turn', status: 'completed' } });

    await Promise.all([
      withTimeout(runFirst, 'first stopped command'),
      withTimeout(runSecond, 'second surviving command'),
    ]);

    const state = harness.useSharedAgent.getState();
    assert.equal(state.sessions[first.tmid]?.status, 'ended');
    assert.equal(state.sessions[second.tmid]?.status, 'ready');
    assert.deepEqual(firstController.interruptedTurns, [{ threadId: 'shared-thread', turnId: 'shared-turn' }]);
    assert.deepEqual(secondController.interruptedTurns, []);
    assert.equal(firstController.stopped, true);
    assert.equal(secondController.stopped, false);
  } finally {
    harness.restoreFactory();
  }
});

test('共享 Agent 中断后同一 tmid 复用 turnId 和 itemId 时不会带出旧输出或文件路径', { concurrency: false }, async () => {
  const target = readySession('restart-after-interrupt', { codexThreadId: 'shared-thread' });
  const { useSharedAgent, setSharedAgentControllerFactory, useCodexWorkspace } = await loadModules();
  await prepareStore([target]);
  setHostingRuntime(useCodexWorkspace);
  const invocations = installInvokeRecorder();
  const states: FakeClientState[] = [];
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'startTurn') return 'reused-turn';
      return { id: 'shared-thread' };
    });
    states.push(built.state);
    return built.controller as never;
  });

  try {
    const firstRun = useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host', 'interrupt-1'),
    );
    await waitFor(() => states[0]?.calls.includes('startTurn') === true);
    states[0]?.options.onNotification?.('item/agentMessage/delta', {
      threadId: 'shared-thread',
      turnId: 'reused-turn',
      delta: 'stale ',
    });
    states[0]?.options.onNotification?.('item/started', {
      threadId: 'shared-thread',
      item: {
        id: 'reused-item',
        type: 'fileChange',
        changes: [{ path: 'D:/Repos/example/stale.txt' }],
      },
    });
    states[0]?.options.onInterrupted?.(new Error('runtime interrupted'));
    await withTimeout(firstRun, 'first interrupted command');

    const secondRun = useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host', 'interrupt-2'),
    );
    await waitFor(() => states[1]?.calls.includes('startTurn') === true);
    const staleApproval = states[1]?.options.onServerRequest?.({
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'shared-thread', itemId: 'reused-item' },
      policy: 'host-approval',
    });
    assert.ok(staleApproval);
    await assert.rejects(
      withTimeout(staleApproval, 'interrupt stale approval'),
      /文件变更请求缺少可供宿主核验的路径/,
    );
    states[1]?.options.onNotification?.('item/agentMessage/delta', {
      threadId: 'shared-thread',
      turnId: 'reused-turn',
      delta: 'fresh',
    });
    states[1]?.options.onNotification?.('turn/completed', {
      threadId: 'shared-thread',
      turn: { id: 'reused-turn', status: 'completed' },
    });
    await withTimeout(secondRun, 'second interrupted command');

    assert.deepEqual(recordedReplies(invocations), [
      { rid: target.rid, tmid: target.tmid, text: '🤖 Codex\nfresh' },
    ]);
  } finally {
    restoreFactory();
  }
});

test('共享 Agent 结束后同一 tmid 复用 turnId 和 itemId 时不会带出旧输出或文件路径', { concurrency: false }, async () => {
  const target = readySession('restart-after-end', { codexThreadId: 'shared-thread' });
  const { useSharedAgent, setSharedAgentControllerFactory, useCodexWorkspace } = await loadModules();
  await prepareStore([target]);
  setHostingRuntime(useCodexWorkspace);
  const invocations = installInvokeRecorder();
  const states: FakeClientState[] = [];
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'startTurn') return 'reused-turn';
      return { id: 'shared-thread' };
    });
    states.push(built.state);
    return built.controller as never;
  });

  try {
    const firstRun = useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host', 'end-1'),
    );
    await waitFor(() => states[0]?.calls.includes('startTurn') === true);
    states[0]?.options.onNotification?.('item/agentMessage/delta', {
      threadId: 'shared-thread',
      turnId: 'reused-turn',
      delta: 'stale ',
    });
    states[0]?.options.onNotification?.('item/started', {
      threadId: 'shared-thread',
      item: {
        id: 'reused-item',
        type: 'fileChange',
        changes: [{ path: 'D:/Repos/example/stale.txt' }],
      },
    });
    await useSharedAgent.getState().endSession(target.tmid);
    await withTimeout(firstRun, 'first ended command');

    useSharedAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [target.tmid]: readySession(target.tmid, { codexThreadId: 'shared-thread' }),
      },
    }));

    const secondRun = useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host', 'end-2'),
    );
    await waitFor(() => states[1]?.calls.includes('startTurn') === true);
    const staleApproval = states[1]?.options.onServerRequest?.({
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'shared-thread', itemId: 'reused-item' },
      policy: 'host-approval',
    });
    assert.ok(staleApproval);
    await assert.rejects(
      withTimeout(staleApproval, 'ended stale approval'),
      /文件变更请求缺少可供宿主核验的路径/,
    );
    states[1]?.options.onNotification?.('item/agentMessage/delta', {
      threadId: 'shared-thread',
      turnId: 'reused-turn',
      delta: 'fresh',
    });
    states[1]?.options.onNotification?.('turn/completed', {
      threadId: 'shared-thread',
      turn: { id: 'reused-turn', status: 'completed' },
    });
    await withTimeout(secondRun, 'second ended command');

    assert.deepEqual(recordedReplies(invocations), [
      { rid: target.rid, tmid: target.tmid, text: '🤖 Codex\nfresh' },
    ]);
  } finally {
    restoreFactory();
  }
});

test('共享 Agent 已启动会话继续执行时固定使用各自的运行时快照', { concurrency: false }, async () => {
  const first = readySession('runtime-snapshot-a', {
    codexThreadId: 'thread-runtime-a',
    runtimeModel: 'gpt-test',
    runtimeEffort: 'high',
    runtimePermissionPreset: 'ask',
  });
  const second = readySession('runtime-snapshot-b', {
    codexThreadId: 'thread-runtime-b',
    runtimeModel: 'gpt-hosting',
    runtimeEffort: 'high',
    runtimePermissionPreset: 'full',
  });
  const harness = await setupSharedThreadHarness(first, second, async (method, state) => {
    if (method === 'startTurn') {
      return state.connectedSessionId === `session-${first.tmid}` ? 'turn-runtime-a' : 'turn-runtime-b';
    }
    return {
      id: state.connectedSessionId === `session-${first.tmid}` ? 'thread-runtime-a' : 'thread-runtime-b',
    };
  });

  try {
    const {
      runFirst,
      runSecond,
      firstController,
      secondController,
    } = await startSharedThreadCommands(harness);
    const { useCodexWorkspace } = await loadModules();
    setHostingRuntime(useCodexWorkspace, { hostingModel: 'gpt-hosting' });

    firstController.options.onNotification?.('turn/completed', { threadId: 'thread-runtime-a', turn: { id: 'turn-runtime-a', status: 'completed' } });
    secondController.options.onNotification?.('turn/completed', { threadId: 'thread-runtime-b', turn: { id: 'turn-runtime-b', status: 'completed' } });

    await Promise.all([
      withTimeout(runFirst, 'snapshot first command'),
      withTimeout(runSecond, 'snapshot second command'),
    ]);

    assert.deepEqual(firstController.selections.at(-1), {
      model: 'gpt-test',
      effort: 'high',
      permissionPreset: 'ask',
    });
    assert.deepEqual(secondController.selections.at(-1), {
      model: 'gpt-hosting',
      effort: 'high',
      permissionPreset: 'full',
    });
  } finally {
    harness.restoreFactory();
  }
});

test('共享 Agent 旧会话首次恢复时补齐运行时快照并沿用当时默认值', { concurrency: false }, async () => {
  const legacy = interruptedSession('runtime-legacy', {
    codexThreadId: 'thread-runtime-legacy',
    runtimeModel: undefined,
    runtimeEffort: undefined,
    runtimePermissionPreset: undefined,
  });
  const { useSharedAgent, setSharedAgentControllerFactory, useCodexWorkspace } = await loadModules();
  await prepareStore([legacy]);
  useCodexWorkspace.setState({
    hostingModel: 'gpt-hosting',
    hostingEffort: 'high',
    permissionPreset: 'auto',
  });
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async () => ({ id: legacy.codexThreadId! }));
    fake = built.state;
    return built.controller as never;
  });

  try {
    await useSharedAgent.getState().resumeSession(legacy.tmid);
    const restored = useSharedAgent.getState().sessions[legacy.tmid];
    assert.equal(restored?.runtimeModel, 'gpt-hosting');
    assert.equal(restored?.runtimeEffort, 'high');
    assert.equal(restored?.runtimePermissionPreset, 'auto');
    assert.deepEqual(fake.selections.at(-1), {
      model: 'gpt-hosting',
      effort: 'high',
      permissionPreset: 'auto',
    });
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
