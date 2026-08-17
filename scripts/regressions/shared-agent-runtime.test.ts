import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import type {
  AppServerControllerOptions,
  CodexCatalog,
  CodexRuntimeSelection,
} from '../../apps/web/src/agent/AppServerController';
import {
  agentSessionCardAuthority,
  agentSessionLeaseCustomFields,
  createAgentSessionLeaseMessageId,
  renderAgentSessionCard,
} from '../../apps/web/src/agent/card';
import type { AgentSession } from '../../apps/web/src/agent/session';
import type { RcMessage } from '@rcx/rc-client';
import type { HostedDshControllerOptions } from '../../apps/web/src/agent/dsh/HostedDshController';

const values = new Map<string, string>();
values.set('rocketx.butler.task-provider', 'codex');
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
  const { resetAiRuntimeProviderForTests } = await import('../../apps/web/src/lib/runtimeMode');
  resetAiRuntimeProviderForTests('codex');
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
  const [{ useAuth }, { useChat }, sharedAgent, sessionStore, clientModule, codexWorkspace, runtimeMode] = await Promise.all([
    import('../../apps/web/src/stores/auth'),
    import('../../apps/web/src/stores/chat'),
    import('../../apps/web/src/stores/sharedAgent'),
    import('../../apps/web/src/agent/sessionStore'),
    import('../../apps/web/src/lib/client'),
    import('../../apps/web/src/stores/codexWorkspace'),
    import('../../apps/web/src/lib/runtimeMode'),
  ]);
  return { useAuth, useChat, ...sharedAgent, ...sessionStore, clientModule, ...codexWorkspace, ...runtimeMode };
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
  const {
    useAuth,
    useChat,
    useSharedAgent,
    useCodexWorkspace,
    setAgentSessionAppData,
    clientModule,
  } = await loadModules();
  values.clear();
  localStorage.setItem('rcx-agent-device-id', 'device-a');
  clientModule.setServerBase('');
  restoreAgentSessionAppData = setAgentSessionAppData(
    createRcxStore({ backend: createMemoryBackend() }).appData,
  );
  useAuth.setState({ user: { _id: 'host-user', username: 'host', roles: ['admin'] } as never });
  useChat.setState({
    roomRoles: {},
    rooms: {},
    subscriptions: {},
    messages: {},
  });
  useCodexWorkspace.setState({
    scope: 'same-origin:host-user',
    defaultWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    butlerWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
  });
  useSharedAgent.setState({
    sessions: Object.fromEntries(sessions.map((session) => [session.tmid, session])),
    remoteCards: {},
    traces: {},
    approvals: [],
    inputs: [],
    dshQuestions: [],
    memberRequests: [],
    error: null,
  });
  return { useAuth, useSharedAgent };
}

const DEFAULT_RUNTIME_SELECTION = {
  selectedModel: 'gpt-test',
  selectedEffort: 'high',
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

function setRuntimeSelection(
  useCodexWorkspace: SharedAgentModules['useCodexWorkspace'],
  overrides: Partial<typeof DEFAULT_RUNTIME_SELECTION> = {},
): void {
  useCodexWorkspace.setState({
    ...DEFAULT_RUNTIME_SELECTION,
    ...overrides,
  });
}

function leaseCardMessage(
  rid: string,
  tmid: string,
  userId: string,
  username: string,
  text: string,
  overrides: Partial<RcMessage> = {},
): RcMessage {
  return {
    _id: overrides._id ?? createAgentSessionLeaseMessageId(),
    rid,
    tmid,
    msg: text,
    ts: overrides.ts ?? new Date().toISOString(),
    _updatedAt: overrides._updatedAt,
    editedAt: overrides.editedAt,
    u: { _id: userId, username, name: username },
    ...(overrides.customFields ? { customFields: overrides.customFields } : {}),
  };
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

test('另一设备的托管租约仍有效时不会为同一 session key 重复启动', { concurrency: false }, async () => {
  const { useSharedAgent } = await prepareStore([]);
  const tmid = 'room:shared-room';
  useSharedAgent.setState({
    remoteCards: {
      [tmid]: {
        version: 1,
        sessionId: 'remote-session',
        rid: 'shared-room',
        tmid,
        hostUserId: 'other-user',
        hostUsername: 'alice',
        hostDeviceId: 'other-device',
        leaseExpiresAt: Date.now() + 60_000,
        status: 'interrupted',
      },
    },
  });

  await assert.rejects(
    useSharedAgent.getState().startSession('shared-room', tmid, { workspaceRoot: 'D:/Repos/example' }),
    /由 @alice 的另一台设备托管/,
  );
  assert.equal(useSharedAgent.getState().sessions[tmid], undefined);
});

test('普通成员发布的有效租约卡会成为权威 remote lease', { concurrency: false }, async () => {
  const { useSharedAgent, useChat } = await loadModules();
  await prepareStore([]);
  const rid = 'room-member-hosted';
  const tmid = 'thread-member-hosted';
  useChat.setState({
    rooms: { [rid]: { _id: rid, t: 'p', fname: '普通成员托管房间' } as never },
    subscriptions: { [rid]: { rid, t: 'p' } as never },
    roomRoles: { [rid]: [] },
  });
  const visible = renderAgentSessionCard({
    version: 1,
    sessionId: 'member-hosted-session',
    rid,
    tmid,
    hostUserId: 'member-user',
    hostUsername: 'member',
    hostDeviceId: 'member-device',
    leaseExpiresAt: Date.now() + 60_000,
    status: 'active',
    environmentName: 'RocketX',
    currentTaskLabel: '处理中',
  });
  await useSharedAgent.getState().ingestCard(
    leaseCardMessage(rid, tmid, 'member-user', 'member', visible),
  );
  assert.equal(useSharedAgent.getState().remoteCards[tmid]?.hostUsername, 'member');
  await assert.rejects(
    useSharedAgent.getState().startSession(rid, tmid, { workspaceRoot: 'D:/Repos/example' }),
    /由 @member 的另一台设备托管/,
  );
});

test('真实 sendLeaseCard 路径生成的 customFields 即使 sessionId 与 messageId 不同也能命中 authority', { concurrency: false }, async () => {
  const {
    useAuth,
    useChat,
    useSharedAgent,
    useCodexWorkspace,
    setSharedAgentControllerFactory,
    clientModule,
  } = await loadModules();
  await prepareStore([]);
  const rid = 'room-custom-fields-authority';
  const tmid = 'thread-custom-fields-authority';
  useAuth.setState({ user: { _id: 'plain-user', username: 'plain', roles: ['user'] } as never });
  useChat.setState({
    rooms: { [rid]: { _id: rid, t: 'p', fname: 'customFields 权威房间' } as never },
    subscriptions: { [rid]: { rid, t: 'p' } as never },
    roomRoles: { [rid]: [] },
  });
  useCodexWorkspace.setState({
    scope: 'same-origin:plain-user',
    defaultWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    butlerWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
  });
  setRuntimeSelection(useCodexWorkspace);
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      assert.equal(method, 'startThread');
      return { id: 'plain-user-custom-fields-thread' };
    });
    return built.controller as never;
  });
  const originalSendMessageRaw = clientModule.rest.sendMessageRaw.bind(clientModule.rest);
  let published: Record<string, unknown> | undefined;
  clientModule.rest.sendMessageRaw = async (body) => {
    published = body as Record<string, unknown>;
    return { _id: body._id } as never;
  };
  try {
    const started = await useSharedAgent.getState().startSession(rid, tmid, {
      workspaceRoot: 'D:/Repos/example',
    });
    assert.ok(published);
    assert.equal(typeof published?.msg, 'string');
    assert.equal(
      agentSessionCardAuthority(String(published?.msg), {
        _id: String(published?._id),
        rid,
        tmid,
        ts: new Date().toISOString(),
        u: { _id: started.host.userId, username: 'plain', name: 'plain' },
        customFields: published?.customFields as Record<string, unknown>,
      }),
      'custom-fields',
    );
    assert.equal(
      JSON.parse(String((published?.customFields as Record<string, unknown>)?.rocketxAgentLeaseV1)).sessionId,
      started.sessionId,
    );
    assert.notEqual(started.sessionId, published?._id);
  } finally {
    clientModule.rest.sendMessageRaw = originalSendMessageRaw;
    restoreFactory();
  }
});

test('纯手工复制的可见状态卡不会直接成为权威 remote lease', { concurrency: false }, async () => {
  const { useSharedAgent, useChat } = await loadModules();
  await prepareStore([]);
  const rid = 'room-visible-copy';
  const tmid = 'thread-visible-copy';
  useChat.setState({
    rooms: { [rid]: { _id: rid, t: 'p', fname: '可见复制房间' } as never },
    subscriptions: { [rid]: { rid, t: 'p' } as never },
    roomRoles: { [rid]: [] },
  });
  const visible = renderAgentSessionCard({
    version: 1,
    sessionId: 'copied-visible-session',
    rid,
    tmid,
    hostUserId: 'member-user',
    hostUsername: 'member',
    hostDeviceId: 'member-device',
    leaseExpiresAt: Date.now() + 60_000,
    status: 'active',
    environmentName: 'RocketX',
    currentTaskLabel: '只是复制正文',
  });
  await useSharedAgent.getState().ingestCard(
    leaseCardMessage(rid, tmid, 'member-user', 'member', visible, { _id: 'plainVisibleCard01' }),
  );
  assert.equal(useSharedAgent.getState().remoteCards[tmid], undefined);
});

test('旧授权角色的 legacy 状态卡会临时参与仲裁，避免新版重复启动', { concurrency: false }, async () => {
  const { useSharedAgent, clientModule } = await loadModules();
  await prepareStore([]);
  const rid = 'room-legacy-display-only';
  const tmid = 'thread-legacy-display-only';
  const originalGetRoomRoles = clientModule.rest.getRoomRoles.bind(clientModule.rest);
  const originalGetUserInfoById = clientModule.rest.getUserInfoById.bind(clientModule.rest);
  clientModule.rest.getRoomRoles = async () => [{
    u: { _id: 'leader-user', username: 'leader', name: 'leader' },
    roles: ['leader'],
  }] as never;
  clientModule.rest.getUserInfoById = async () => ({ _id: 'leader-user', username: 'leader', roles: ['user'] }) as never;
  const legacy = `🤖 **AI 托管已开启**\n<!--rocketx-agent:${encodeURIComponent(JSON.stringify({
    version: 1,
    sessionId: 'legacy-display-only',
    rid,
    tmid,
    hostUserId: 'leader-user',
    hostUsername: 'leader',
    hostDeviceId: 'legacy-device',
    leaseExpiresAt: Date.now() + 60_000,
    status: 'active',
  }))}-->`;
  try {
    await useSharedAgent.getState().ingestCard(
      leaseCardMessage(rid, tmid, 'leader-user', 'leader', legacy, { _id: 'plainLegacyCard01' }),
    );
    assert.equal(useSharedAgent.getState().remoteCards[tmid]?.hostUsername, 'leader');
    await assert.rejects(
      useSharedAgent.getState().startSession(rid, tmid, { workspaceRoot: 'D:/Repos/example' }),
      /由 @leader 的另一台设备托管/,
    );
  } finally {
    clientModule.rest.getRoomRoles = originalGetRoomRoles;
    clientModule.rest.getUserInfoById = originalGetUserInfoById;
  }
});

test('旧普通成员 legacy 状态卡不会阻断新版重新开启', { concurrency: false }, async () => {
  const {
    useChat,
    useSharedAgent,
    useCodexWorkspace,
    setSharedAgentControllerFactory,
    clientModule,
  } = await loadModules();
  await prepareStore([]);
  const rid = 'room-mismatched-host';
  const tmid = 'thread-mismatched-host';
  useChat.setState({
    rooms: { [rid]: { _id: rid, t: 'p', fname: '旧普通成员房间' } as never },
    subscriptions: { [rid]: { rid, t: 'p' } as never },
  });
  useCodexWorkspace.setState({
    scope: 'same-origin:host-user',
    defaultWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    butlerWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
  });
  setRuntimeSelection(useCodexWorkspace);
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      assert.equal(method, 'startThread');
      return { id: 'legacy-member-can-restart' };
    });
    return built.controller as never;
  });
  const originalSendMessageRaw = clientModule.rest.sendMessageRaw.bind(clientModule.rest);
  clientModule.rest.sendMessageRaw = async () => ({ _id: createAgentSessionLeaseMessageId() }) as never;
  const legacy = `🤖 **AI 托管已开启**\n<!--rocketx-agent:${encodeURIComponent(JSON.stringify({
    version: 1,
    sessionId: 'plain-member-session',
    rid,
    tmid,
    hostUserId: 'member-user',
    hostUsername: 'member',
    hostDeviceId: 'member-device',
    leaseExpiresAt: Date.now() + 60_000,
    status: 'active',
  }))}-->`;
  try {
    await useSharedAgent.getState().ingestCard(
      leaseCardMessage(rid, tmid, 'member-user', 'member', legacy, { _id: 'plainLegacyCard02' }),
    );
    assert.equal(useSharedAgent.getState().remoteCards[tmid], undefined);
    const started = await useSharedAgent.getState().startSession(rid, tmid, { workspaceRoot: 'D:/Repos/example' });
    assert.equal(started.host.userId, 'host-user');
  } finally {
    clientModule.rest.sendMessageRaw = originalSendMessageRaw;
    restoreFactory();
  }
});

test('旧 visible 状态卡只有在服务端确认负责人角色时才参与仲裁', { concurrency: false }, async () => {
  const { useSharedAgent, useChat, clientModule } = await loadModules();
  await prepareStore([]);
  const rid = 'room-moderated';
  const tmid = 'thread-moderated';
  useChat.setState({
    rooms: { [rid]: { _id: rid, t: 'p', fname: '主持房间' } as never },
    subscriptions: { [rid]: { rid, t: 'p' } as never },
  });
  const originalGetRoomRoles = clientModule.rest.getRoomRoles.bind(clientModule.rest);
  const originalGetUserInfoById = clientModule.rest.getUserInfoById.bind(clientModule.rest);
  clientModule.rest.getRoomRoles = async () => [{
    u: { _id: 'mod-user', username: 'alice', name: 'alice' },
    roles: ['moderator'],
  }] as never;
  clientModule.rest.getUserInfoById = async () => ({ _id: 'mod-user', username: 'alice', roles: ['user'] }) as never;
  const visible = renderAgentSessionCard({
    version: 1,
    sessionId: 'remote-session',
    rid,
    tmid,
    hostUserId: 'mod-user',
    hostUsername: 'alice',
    hostDeviceId: 'mod-device',
    leaseExpiresAt: Date.now() + 60_000,
    status: 'active',
    backend: 'deepseek',
    environmentName: 'RocketX',
    currentTaskLabel: '处理中',
  });
  try {
    await useSharedAgent.getState().ingestCard(
      leaseCardMessage(rid, tmid, 'mod-user', 'alice', visible, { _id: 'legacy-visible-card01' }),
    );
    assert.equal(useSharedAgent.getState().remoteCards[tmid]?.hostUsername, 'alice');
    await assert.rejects(
      useSharedAgent.getState().startSession(rid, tmid, { workspaceRoot: 'D:/Repos/example' }),
      /由 @alice 的另一台设备托管/,
    );
  } finally {
    clientModule.rest.getRoomRoles = originalGetRoomRoles;
    clientModule.rest.getUserInfoById = originalGetUserInfoById;
  }
});

test('超长未来租约即使来自房间成员也不会成为权威 remote lease', { concurrency: false }, async () => {
  const { useSharedAgent, useChat } = await loadModules();
  await prepareStore([]);
  const rid = 'room-future-lease';
  const tmid = 'thread-future-lease';
  useChat.setState({
    rooms: { [rid]: { _id: rid, t: 'p', fname: '未来租约房间' } as never },
    subscriptions: { [rid]: { rid, t: 'p' } as never },
  });
  const visible = renderAgentSessionCard({
    version: 1,
    sessionId: 'future-lease-session',
    rid,
    tmid,
    hostUserId: 'leader-user',
    hostUsername: 'leader',
    hostDeviceId: 'leader-device',
    leaseExpiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
    status: 'active',
    environmentName: 'RocketX',
    currentTaskLabel: '永久占坑',
  });
  await useSharedAgent.getState().ingestCard(
    leaseCardMessage(rid, tmid, 'leader-user', 'leader', visible, {
      ts: '2026-08-16T12:00:00.000Z',
      _updatedAt: '2026-08-16T12:00:05.000Z',
    }),
  );
  assert.equal(useSharedAgent.getState().remoteCards[tmid], undefined);
});

test('切服或切账号后排队中的租约不会污染新 scope 的 remoteCards', { concurrency: false }, async () => {
  const { useSharedAgent, clientModule } = await loadModules();
  await prepareStore([]);
  const rid = 'room-scope-race';
  const tmid = 'thread-scope-race';
  const visible = renderAgentSessionCard({
    version: 1,
    sessionId: 'scope-race-session',
    rid,
    tmid,
    hostUserId: 'admin-user',
    hostUsername: 'admin-user',
    hostDeviceId: 'admin-device',
    leaseExpiresAt: Date.now() + 60_000,
    status: 'active',
    environmentName: 'RocketX',
    currentTaskLabel: '等待授权',
  });
  const ingest = useSharedAgent.getState().ingestCard(
    leaseCardMessage(rid, tmid, 'admin-user', 'admin-user', visible, { _id: 'scope-race-message' }),
  );
  clientModule.setServerBase('http://other-server');
  const { useAuth } = await loadModules();
  useAuth.setState({ user: { _id: 'other-user', username: 'other', roles: ['admin'] } as never });
  try {
    await ingest;
    assert.equal(useSharedAgent.getState().remoteCards[tmid], undefined);
  } finally {
    clientModule.setServerBase('');
  }
});

test('有效远端租约会阻止本机旧会话自动恢复或处理同一条 @ai 指令', { concurrency: false }, async () => {
  const tmid = 'remote-authoritative-session';
  const local = interruptedSession(tmid);
  const { useSharedAgent } = await prepareStore([local]);
  useSharedAgent.setState({
    remoteCards: {
      [tmid]: {
        version: 1,
        sessionId: 'remote-authoritative',
        rid: local.rid,
        tmid,
        hostUserId: 'other-user',
        hostUsername: 'alice',
        hostDeviceId: 'other-device',
        leaseExpiresAt: Date.now() + 60_000,
        status: 'active',
      },
    },
  });

  await assert.rejects(
    useSharedAgent.getState().resumeSession(tmid),
    /由 @alice 的另一台设备托管/,
  );
  await useSharedAgent.getState().handleMessage(
    commandMessage(tmid, local.host.userId, 'host', 'remote-authoritative-command'),
  );
  assert.equal(useSharedAgent.getState().sessions[tmid]?.status, 'interrupted');
  assert.deepEqual(useSharedAgent.getState().traces[tmid] ?? [], []);
});

test('并发有效宿主声明使用稳定仲裁，失败方不会执行同一条 @ai 指令', { concurrency: false }, async () => {
  const tmid = 'concurrent-host-claims';
  const local = readySession(tmid);
  const { useSharedAgent } = await prepareStore([local]);
  useSharedAgent.setState({
    remoteCards: {
      [tmid]: {
        version: 1,
        sessionId: 'remote-concurrent-session',
        rid: local.rid,
        tmid,
        hostUserId: 'other-user',
        hostUsername: 'alice',
        hostDeviceId: '000-remote-device',
        leaseExpiresAt: Date.now() + 60_000,
        status: 'active',
      },
    },
  });

  await assert.rejects(
    useSharedAgent.getState().resumeSession(tmid),
    /由 @alice 的另一台设备托管/,
  );
  await useSharedAgent.getState().handleMessage(
    commandMessage(tmid, local.host.userId, 'host', 'concurrent-host-command'),
  );
  assert.equal(useSharedAgent.getState().sessions[tmid]?.status, 'ready');
  assert.deepEqual(useSharedAgent.getState().traces[tmid] ?? [], []);
});

async function setupSharedThreadHarness(
  first: AgentSession,
  second: AgentSession,
  request: FakeControllerRequest,
): Promise<SharedThreadHarness> {
  const { useSharedAgent, setSharedAgentControllerFactory, useCodexWorkspace } = await loadModules();
  await prepareStore([first, second]);
  setRuntimeSelection(useCodexWorkspace);
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

test('普通房间成员可以直接开启 AI 托管', { concurrency: false }, async () => {
  const {
    useAuth,
    useChat,
    useSharedAgent,
    useCodexWorkspace,
    setSharedAgentControllerFactory,
    clientModule,
  } = await loadModules();
  await prepareStore([]);
  const rid = 'room-no-host-role';
  useAuth.setState({ user: { _id: 'plain-user', username: 'plain', roles: ['user'] } as never });
  useChat.setState({
    rooms: { [rid]: { _id: rid, t: 'p', fname: '普通群' } as never },
    subscriptions: { [rid]: { rid, t: 'p' } as never },
    roomRoles: { [rid]: [] },
  });
  useCodexWorkspace.setState({
    scope: 'same-origin:plain-user',
    defaultWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    butlerWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
  });
  setRuntimeSelection(useCodexWorkspace);
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      assert.equal(method, 'startThread');
      return { id: 'plain-user-hosting-thread' };
    });
    fake = built.state;
    return built.controller as never;
  });
  const originalSendMessageRaw = clientModule.rest.sendMessageRaw.bind(clientModule.rest);
  const leaseMessageId = createAgentSessionLeaseMessageId();
  clientModule.rest.sendMessageRaw = async () => ({ _id: leaseMessageId }) as never;
  try {
    const started = await useSharedAgent.getState().startSession(rid, 'thread-no-host-role', {
      workspaceRoot: 'D:/Repos/example',
    });
    assert.equal(started.host.userId, 'plain-user');
    assert.equal(started.status, 'ready');
    assert.equal(started.leaseMessageId, leaseMessageId);
    assert.deepEqual(fake.calls.slice(0, 2), ['connect', 'startThread']);
  } finally {
    clientModule.rest.sendMessageRaw = originalSendMessageRaw;
    restoreFactory();
  }
});

test('旧卡迁移角色查询失败时按非权威处理，不阻断新版开启', { concurrency: false }, async () => {
  const {
    useChat,
    useSharedAgent,
    clientModule,
    useCodexWorkspace,
    setSharedAgentControllerFactory,
  } = await loadModules();
  await prepareStore([]);
  const rid = 'room-legacy-query-failed';
  const tmid = 'thread-legacy-query-failed';
  useChat.setState({
    rooms: { [rid]: { _id: rid, t: 'p', fname: '旧卡查询失败房间' } as never },
    subscriptions: { [rid]: { rid, t: 'p' } as never },
  });
  useCodexWorkspace.setState({
    scope: 'same-origin:host-user',
    defaultWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    butlerWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
  });
  setRuntimeSelection(useCodexWorkspace);
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      assert.equal(method, 'startThread');
      return { id: 'legacy-query-failed-can-restart' };
    });
    return built.controller as never;
  });
  const originalGetRoomRoles = clientModule.rest.getRoomRoles.bind(clientModule.rest);
  const originalGetUserInfoById = clientModule.rest.getUserInfoById.bind(clientModule.rest);
  const originalSendMessageRaw = clientModule.rest.sendMessageRaw.bind(clientModule.rest);
  clientModule.rest.getRoomRoles = async () => { throw new Error('roles unavailable'); };
  clientModule.rest.getUserInfoById = async () => { throw new Error('user info unavailable'); };
  clientModule.rest.sendMessageRaw = async () => ({ _id: createAgentSessionLeaseMessageId() }) as never;
  const legacy = `🤖 **AI 托管已开启**\n<!--rocketx-agent:${encodeURIComponent(JSON.stringify({
    version: 1,
    sessionId: 'legacy-query-failed',
    rid,
    tmid,
    hostUserId: 'member-user',
    hostUsername: 'member',
    hostDeviceId: 'legacy-device',
    leaseExpiresAt: Date.now() + 60_000,
    status: 'active',
  }))}-->`;
  try {
    await useSharedAgent.getState().ingestCard(
      leaseCardMessage(rid, tmid, 'member-user', 'member', legacy, { _id: 'plainLegacyCard03' }),
    );
    assert.equal(useSharedAgent.getState().remoteCards[tmid], undefined);
    const started = await useSharedAgent.getState().startSession(rid, tmid, { workspaceRoot: 'D:/Repos/example' });
    assert.equal(started.host.userId, 'host-user');
  } finally {
    clientModule.rest.getRoomRoles = originalGetRoomRoles;
    clientModule.rest.getUserInfoById = originalGetUserInfoById;
    clientModule.rest.sendMessageRaw = originalSendMessageRaw;
    restoreFactory();
  }
});

test('AI 托管拒绝绕过当前启动运行时选择另一后端', { concurrency: false }, async () => {
  const {
    useSharedAgent,
    useCodexWorkspace,
    resetAiRuntimeProviderForTests,
  } = await loadModules();
  resetAiRuntimeProviderForTests('codex');
  await prepareStore([]);
  useCodexWorkspace.setState({
    scope: 'same-origin:host-user',
    defaultWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    butlerWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
  });

  await assert.rejects(
    useSharedAgent.getState().startSession('room-runtime', 'thread-runtime', {
      backend: 'deepseek',
      workspaceRoot: 'D:/Repos/example',
    }),
    /AI 托管必须使用当前启动的 AI 运行时/,
  );
  assert.equal(useSharedAgent.getState().sessions['thread-runtime'], undefined);
});

test('无 AI 或切换引擎后恢复仍保留原托管 session，只禁用执行', { concurrency: false }, async () => {
  const saved = readySession('provider-neutral-restore', {
    backend: 'codex',
    roomNameSnapshot: '研发群',
    currentTaskLabel: '检查发布门禁',
  });
  const {
    useAuth,
    useSharedAgent,
    saveAgentSession,
    resetAiRuntimeProviderForTests,
  } = await loadModules();
  await prepareStore([]);
  await saveAgentSession(saved, saved.ownerUserId);

  for (const provider of ['none', 'deepseek'] as const) {
    resetAiRuntimeProviderForTests(provider);
    useAuth.setState({ user: undefined });
    await useSharedAgent.getState().restore();
    useAuth.setState({ user: { _id: 'host-user', username: 'host' } as never });
    await useSharedAgent.getState().restore();

    const restored = useSharedAgent.getState().sessions[saved.tmid];
    assert.ok(restored, `${provider} 不应隐藏已有托管 session`);
    assert.equal(restored.status, 'interrupted', `${provider} 不应把托管 session 改成 ended`);
    assert.equal(restored.roomNameSnapshot, '研发群');
    assert.equal(restored.currentTaskLabel, '检查发布门禁');
    await assert.rejects(
      useSharedAgent.getState().resumeSession(saved.tmid),
      /另一套 AI 运行时/,
    );
  }
});

test('AI 托管恢复会话时使用独立模型与推理强度，权限仍跟随管家', { concurrency: false }, async () => {
  const target = interruptedSession('hosting-profile');
  const { useSharedAgent, useCodexWorkspace, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target]);
  useCodexWorkspace.setState({
    selectedModel: 'gpt-test',
    selectedEffort: 'high',
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
      model: 'gpt-test',
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
    await waitFor(() => fake?.calls.includes('startTurn') === true);
    assert.equal(
      useSharedAgent.getState().sessions[target.tmid]?.currentTaskLabel,
      '请检查当前进度',
    );
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
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.currentTaskLabel, undefined);
  } finally {
    restoreFactory();
  }
});

test('AI 托管通过机器人发送长回复时会按服务器上限分段', { concurrency: false }, async () => {
  const target = interruptedSession('chunked-bot-reply', {
    status: 'ready',
    activeTurnId: undefined,
  });
  const { useSharedAgent, setSharedAgentControllerFactory, setSharedAgentMessageSizeProviderForTests } = await loadModules();
  const { toSendableMessageChunks } = await import('../../apps/web/src/lib/messageChunks');
  await prepareStore([target]);
  const restoreMessageSize = setSharedAgentMessageSizeProviderForTests(async () => 24);
  const invocations = installInvokeRecorder();
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'startTurn') return 'turn-chunked-bot-reply';
      return { id: target.codexThreadId! };
    });
    fake = built.state;
    return built.controller as never;
  });

  try {
    const handling = useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host', 'chunked-bot-command'),
    );
    await waitFor(() => fake?.calls.includes('startTurn') === true);
    fake.options.onNotification?.('item/agentMessage/delta', {
      threadId: target.codexThreadId,
      turnId: 'turn-chunked-bot-reply',
      delta: 'alpha alpha\n\nbeta beta\n\ngamma',
    });
    fake.options.onNotification?.('turn/completed', {
      threadId: target.codexThreadId,
      turn: { id: 'turn-chunked-bot-reply', status: 'completed' },
    });
    await handling;
    const expectedChunks = toSendableMessageChunks('🤖 Codex\nalpha alpha\n\nbeta beta\n\ngamma', 24);
    assert.deepEqual(
      recordedReplies(invocations),
      expectedChunks.map((text) => ({ rid: target.rid, tmid: target.tmid, text })),
    );
  } finally {
    restoreMessageSize();
    restoreFactory();
  }
});

test('机器人不可用时宿主 fallback 会跳过纯空白 chunk，并保留 Markdown 缩进与尾段顺序', { concurrency: false }, async () => {
  const target = interruptedSession('chunked-host-fallback', {
    status: 'ready',
    activeTurnId: undefined,
  });
  const { useSharedAgent, setSharedAgentControllerFactory, setSharedAgentMessageSizeProviderForTests } = await loadModules();
  const { toSendableMessageChunks } = await import('../../apps/web/src/lib/messageChunks');
  const chat = await import('../../apps/web/src/stores/chat');
  await prepareStore([target]);
  const restoreMessageSize = setSharedAgentMessageSizeProviderForTests(async () => 24);
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: async () => null,
    },
  });
  const sends: string[] = [];
  const sendOptions: Array<{ preserveWhitespace?: boolean }> = [];
  const originalSend = chat.useChat.getState().send;
  chat.useChat.setState({
    send: (async (text: string, opts?: { preserveWhitespace?: boolean }) => {
      sends.push(text);
      sendOptions.push({ preserveWhitespace: opts?.preserveWhitespace });
      return { id: `fallback-${sends.length}`, delivery: 'server' as const };
    }) as typeof originalSend,
  });
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'startTurn') return 'turn-chunked-host-fallback';
      return { id: target.codexThreadId! };
    });
    fake = built.state;
    return built.controller as never;
  });

  try {
    const handling = useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host', 'chunked-host-command'),
    );
    await waitFor(() => fake?.calls.includes('startTurn') === true);
    const spacedDelta = `        \n\n  - nested item`;
    fake.options.onNotification?.('item/agentMessage/delta', {
      threadId: target.codexThreadId,
      turnId: 'turn-chunked-host-fallback',
      delta: spacedDelta,
    });
    fake.options.onNotification?.('turn/completed', {
      threadId: target.codexThreadId,
      turn: { id: 'turn-chunked-host-fallback', status: 'completed' },
    });
    await handling;
    const expectedChunks = toSendableMessageChunks(`🤖 Codex\n${spacedDelta}`, 24);
    assert.deepEqual(
      sends.filter((text) => text !== '🤖 Codex 已收到，正在思考…'),
      expectedChunks,
    );
    assert.equal(sendOptions.every((entry) => entry.preserveWhitespace === true), true);
  } finally {
    restoreMessageSize();
    chat.useChat.setState({ send: originalSend });
    restoreFactory();
  }
});

for (const fallbackMode of ['null', 'throw'] as const) {
  test(`机器人首段成功后第二区块${fallbackMode === 'null' ? '返回 null' : '抛错'}时会中止后续发送并进入失败收尾`, { concurrency: false }, async () => {
    const target = interruptedSession(`chunked-midstream-bot-fallback-${fallbackMode}`, {
      status: 'ready',
      activeTurnId: undefined,
    });
    const { useSharedAgent, setSharedAgentControllerFactory, setSharedAgentMessageSizeProviderForTests } = await loadModules();
    const { toSendableMessageChunks } = await import('../../apps/web/src/lib/messageChunks');
    const chat = await import('../../apps/web/src/stores/chat');
    await prepareStore([target]);
    const restoreMessageSize = setSharedAgentMessageSizeProviderForTests(async () => 24);
    const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let replyAttempt = 0;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          invocations.push({ command, args });
          if (command !== 'agent_bot_send') return [];
          if (args?.text === '🤖 Codex 已收到，正在思考…') return [];
          replyAttempt += 1;
          if (replyAttempt === 1) return [];
          if (fallbackMode === 'null') return null;
          throw new Error('second bot chunk failed');
        },
      },
    });
    const sends: string[] = [];
    const originalSend = chat.useChat.getState().send;
    chat.useChat.setState({
      send: (async (text: string) => {
        sends.push(text);
        return { id: `fallback-${sends.length}`, delivery: 'server' as const };
      }) as typeof originalSend,
    });
    let fake!: FakeClientState;
    const restoreFactory = setSharedAgentControllerFactory((options) => {
      const built = fakeController(options, async (method) => {
        if (method === 'startTurn') return `turn-midstream-bot-fallback-${fallbackMode}`;
        return { id: target.codexThreadId! };
      });
      fake = built.state;
      return built.controller as never;
    });

    try {
      const handling = useSharedAgent.getState().handleMessage(
        commandMessage(target.tmid, target.host.userId, 'host', `chunked-midstream-command-${fallbackMode}`),
      );
      await waitFor(() => fake?.calls.includes('startTurn') === true);
      const delta = 'alpha alpha\n\nbeta beta\n\ngamma gamma\n\ndelta';
      fake.options.onNotification?.('item/agentMessage/delta', {
        threadId: target.codexThreadId,
        turnId: `turn-midstream-bot-fallback-${fallbackMode}`,
        delta,
      });
      fake.options.onNotification?.('turn/completed', {
        threadId: target.codexThreadId,
        turn: { id: `turn-midstream-bot-fallback-${fallbackMode}`, status: 'completed' },
      });
      await handling;
      const expectedChunks = toSendableMessageChunks(`🤖 Codex\n${delta}`, 24);
      const replyInvocations = recordedReplies(invocations);
      assert.deepEqual(
        replyInvocations.slice(0, 2).map((entry) => entry.text),
        expectedChunks.slice(0, 2),
      );
      const replySends = sends.filter((text) => text !== '🤖 Codex 已收到，正在思考…');
      assert.equal(replySends.includes(expectedChunks[1]!), false);
      assert.equal(replySends.includes(expectedChunks[2]!), false);
      assert.equal(replySends.some((text) => text.includes('执行失败')), true);
      assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'ready');
      assert.equal(
        useSharedAgent.getState().sessions[target.tmid]?.lastError,
        fallbackMode === 'null' ? 'Bot 发送在分段中途失败，已停止本轮回复' : 'second bot chunk failed',
      );
    } finally {
      restoreMessageSize();
      chat.useChat.setState({ send: originalSend });
      restoreFactory();
    }
  });
}

test('分段发送任一 chunk 失败时会停止后续发送并让当前会话失败', { concurrency: false }, async () => {
  const target = interruptedSession('chunked-host-stop-on-error', {
    status: 'ready',
    activeTurnId: undefined,
  });
  const { useSharedAgent, setSharedAgentControllerFactory, setSharedAgentMessageSizeProviderForTests } = await loadModules();
  const { toSendableMessageChunks } = await import('../../apps/web/src/lib/messageChunks');
  const chat = await import('../../apps/web/src/stores/chat');
  await prepareStore([target]);
  const restoreMessageSize = setSharedAgentMessageSizeProviderForTests(async () => 24);
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: async () => null,
    },
  });
  const expectedChunks = toSendableMessageChunks('🤖 Codex\nalpha alpha\n\nbeta beta\n\ngamma gamma\n\ndelta', 24);
  const sends: string[] = [];
  const originalSend = chat.useChat.getState().send;
  chat.useChat.setState({
    send: (async (text: string) => {
      sends.push(text);
      const replyIndex = sends.filter((item) => item !== '🤖 Codex 已收到，正在思考…').length;
      if (replyIndex === 2) throw new Error('second chunk failed');
      return { id: `fallback-${sends.length}`, delivery: 'server' as const };
    }) as typeof originalSend,
  });
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      if (method === 'startTurn') return 'turn-chunked-host-stop-on-error';
      return { id: target.codexThreadId! };
    });
    fake = built.state;
    return built.controller as never;
  });

  try {
    const handling = useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host', 'chunked-error-command'),
    );
    await waitFor(() => fake?.calls.includes('startTurn') === true);
    fake.options.onNotification?.('item/agentMessage/delta', {
      threadId: target.codexThreadId,
      turnId: 'turn-chunked-host-stop-on-error',
      delta: 'alpha alpha\n\nbeta beta\n\ngamma gamma\n\ndelta',
    });
    fake.options.onNotification?.('turn/completed', {
      threadId: target.codexThreadId,
      turn: { id: 'turn-chunked-host-stop-on-error', status: 'completed' },
    });
    await handling;
    const replySends = sends.filter((text) => text !== '🤖 Codex 已收到，正在思考…');
    assert.deepEqual(replySends.slice(0, 2), expectedChunks.slice(0, 2));
    assert.equal(replySends.includes(expectedChunks[2]!), false);
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'ready');
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.lastError, 'second chunk failed');
  } finally {
    restoreMessageSize();
    chat.useChat.setState({ send: originalSend });
    restoreFactory();
  }
});

for (const failedDelivery of ['failed', 'unknown'] as const) {
  test(`宿主发送返回 delivery:'${failedDelivery}' 时会停止后续 chunk、透传 reason 并进入失败收尾`, { concurrency: false }, async () => {
    const target = interruptedSession(`chunked-host-delivery-${failedDelivery}`, {
      status: 'ready',
      activeTurnId: undefined,
    });
    const { useSharedAgent, setSharedAgentControllerFactory, setSharedAgentMessageSizeProviderForTests } = await loadModules();
    const { toSendableMessageChunks } = await import('../../apps/web/src/lib/messageChunks');
    const chat = await import('../../apps/web/src/stores/chat');
    await prepareStore([target]);
    const restoreMessageSize = setSharedAgentMessageSizeProviderForTests(async () => 24);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async () => null,
      },
    });
    const expectedChunks = toSendableMessageChunks('🤖 Codex\nalpha alpha\n\nbeta beta\n\ngamma gamma\n\ndelta', 24);
    const sends: string[] = [];
    const originalSend = chat.useChat.getState().send;
    chat.useChat.setState({
      send: (async (text: string) => {
        sends.push(text);
        const replyIndex = sends.filter((item) => item !== '🤖 Codex 已收到，正在思考…').length;
        if (replyIndex === 2) {
          return {
            id: `failed-${failedDelivery}`,
            delivery: failedDelivery,
            reason: `host ${failedDelivery} reason`,
          } as const;
        }
        return { id: `fallback-${sends.length}`, delivery: 'server' as const };
      }) as typeof originalSend,
    });
    let fake!: FakeClientState;
    const restoreFactory = setSharedAgentControllerFactory((options) => {
      const built = fakeController(options, async (method) => {
        if (method === 'startTurn') return `turn-host-delivery-${failedDelivery}`;
        return { id: target.codexThreadId! };
      });
      fake = built.state;
      return built.controller as never;
    });

    try {
      const handling = useSharedAgent.getState().handleMessage(
        commandMessage(target.tmid, target.host.userId, 'host', `chunked-host-delivery-${failedDelivery}`),
      );
      await waitFor(() => fake?.calls.includes('startTurn') === true);
      fake.options.onNotification?.('item/agentMessage/delta', {
        threadId: target.codexThreadId,
        turnId: `turn-host-delivery-${failedDelivery}`,
        delta: 'alpha alpha\n\nbeta beta\n\ngamma gamma\n\ndelta',
      });
      fake.options.onNotification?.('turn/completed', {
        threadId: target.codexThreadId,
        turn: { id: `turn-host-delivery-${failedDelivery}`, status: 'completed' },
      });
      await handling;
      const replySends = sends.filter((text) => text !== '🤖 Codex 已收到，正在思考…');
      assert.deepEqual(replySends.slice(0, 2), expectedChunks.slice(0, 2));
      assert.equal(replySends.includes(expectedChunks[2]!), false);
      assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'ready');
      assert.equal(useSharedAgent.getState().sessions[target.tmid]?.lastError, `host ${failedDelivery} reason`);
    } finally {
      restoreMessageSize();
      chat.useChat.setState({ send: originalSend });
      restoreFactory();
    }
  });
}

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

test('DeepSeek AI 托管沿用房间队列，并把审批和问题交给宿主', { concurrency: false }, async () => {
  const { useSharedAgent, setSharedAgentDshControllerFactory, resetAiRuntimeProviderForTests } = await loadModules();
  resetAiRuntimeProviderForTests('deepseek');
  const target = readySession('deepseek-hosted', {
    backend: 'deepseek',
    codexThreadId: undefined,
    dshSessionId: 'dsh-session-1',
  });
  await prepareStore([target]);
  const invocations = installInvokeRecorder();
  const calls: string[] = [];
  let handlers: HostedDshControllerOptions | undefined;
  let approvalResponse: boolean | undefined;
  let questionAnswers: unknown;
  const restoreFactory = setSharedAgentDshControllerFactory((_workspaceRoot, connectionId, options) => {
    handlers = options;
    assert.match(connectionId, /^hosting-/);
    return {
      connect: async () => { calls.push('connect'); },
      createSession: async () => 'unused',
      resumeSession: async () => { calls.push('resume'); },
      attachmentLeaseId: () => 'lease-hosted',
      prompt: async (sessionId, prompt) => {
        calls.push(`prompt:${sessionId}`);
        assert.match(prompt, /检查当前进度/);
        return { turnId: 'dsh-turn-1', text: 'DeepSeek 已检查完成' };
      },
      cancel: async () => { calls.push('cancel'); },
      respondApproval: async (_request, approved) => { approvalResponse = approved; },
      respondQuestion: async (_request, answers) => { questionAnswers = answers; },
      stop: async () => { calls.push('stop'); },
    };
  });

  try {
    await useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host', 'deepseek-command'),
    );
    assert.deepEqual(calls.slice(0, 2), ['connect', 'prompt:dsh-session-1']);
    assert.ok(invocations.some((entry) => entry.args?.text === '🤖 DeepSeek 已收到，正在思考…'));
    assert.ok(invocations.some((entry) => entry.args?.text === '🤖 DeepSeek\nDeepSeek 已检查完成'));
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'ready');

    handlers?.onApproval?.({
      rpcId: 'approval-rpc',
      sessionId: 'dsh-session-1',
      approvalId: 'approval-1',
      toolName: 'shell',
      reason: '运行测试',
    });
    handlers?.onApproval?.({
      rpcId: 'approval-rpc-replayed',
      sessionId: 'dsh-session-1',
      approvalId: 'approval-1',
      toolName: 'shell',
      reason: '运行测试',
    });
    assert.equal(useSharedAgent.getState().approvals.length, 1);
    const approval = useSharedAgent.getState().approvals.at(-1);
    assert.equal(approval?.method, 'dsh/approval');
    await useSharedAgent.getState().resolveApproval(approval!.id, 'accept');
    assert.equal(approvalResponse, true);

    handlers?.onApproval?.({
      rpcId: 'approval-rpc-resolved-upstream',
      sessionId: 'dsh-session-1',
      approvalId: 'approval-2',
      toolName: 'shell',
    });
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'waiting-approval');
    handlers?.onApprovalResolved?.('dsh-session-1', 'approval-2');
    assert.equal(useSharedAgent.getState().approvals.length, 0);
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'ready');

    handlers?.onQuestion?.({
      rpcId: 'question-rpc',
      sessionId: 'dsh-session-1',
      questions: [{ id: 'q1', question: '继续吗？' }],
    });
    handlers?.onQuestion?.({
      rpcId: 'question-rpc',
      sessionId: 'dsh-session-1',
      questions: [{ id: 'q1', question: '继续吗？' }],
    });
    assert.equal(useSharedAgent.getState().dshQuestions.length, 1);
    const question = useSharedAgent.getState().dshQuestions.at(-1);
    assert.ok(question);
    await useSharedAgent.getState().resolveDshQuestion(question.id, [{ id: 'q1', selected: [], custom: '继续' }]);
    assert.deepEqual(questionAnswers, [{ id: 'q1', selected: [], custom: '继续' }]);

    handlers?.onQuestion?.({
      rpcId: 'question-rpc-resolved-upstream',
      sessionId: 'dsh-session-1',
      questions: [{ id: 'q2', question: '还继续吗？' }],
    });
    handlers?.onQuestionResolved?.('dsh-session-1', 'question-rpc-resolved-upstream');
    assert.equal(useSharedAgent.getState().dshQuestions.length, 0);
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'ready');

    handlers?.onApproval?.({
      rpcId: 'foreign-approval',
      sessionId: 'another-session',
      approvalId: 'foreign-1',
      toolName: 'shell',
    });
    assert.equal(useSharedAgent.getState().approvals.length, 0);

    await useSharedAgent.getState().endSession(target.tmid);
    handlers?.onQuestion?.({
      rpcId: 'late-question',
      sessionId: 'dsh-session-1',
      questions: [{ id: 'late', question: '太晚了' }],
    });
    assert.equal(useSharedAgent.getState().dshQuestions.length, 0);
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'ended');
    assert.ok(calls.includes('stop'));
  } finally {
    restoreFactory();
  }
});

test('AI 托管只读视图从 Codex Harness 的原线程读取自然对话，不恢复或新建线程', { concurrency: false }, async () => {
  const target = readySession('harness-transcript-codex');
  const { useSharedAgent, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target]);
  const calls: string[] = [];
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async () => ({ id: target.codexThreadId! }));
    return {
      ...built.controller,
      connect: async (sessionId: string, workspaceRoot: string) => {
        calls.push(`connect:${sessionId}:${workspaceRoot}`);
        return built.controller.connect(sessionId, workspaceRoot);
      },
      readThread: async (threadId: string) => {
        calls.push(`readThread:${threadId}`);
        return {
          thread: { id: threadId },
          turns: [{
            id: 'turn-harness-history',
            itemsView: 'full',
            status: 'completed',
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1_000,
            items: [{
              type: 'userMessage',
              id: 'harness-user',
              content: [{
                type: 'text',
                text: '触发者: 张三 (user-zhang)\n<rocket_chat_untrusted_context>历史消息</rocket_chat_untrusted_context>\n<rocket_chat_user_request>\n请检查发布门禁\n</rocket_chat_user_request>',
                text_elements: [],
              }],
            }, {
              type: 'agentMessage',
              id: 'harness-assistant',
              text: '发布门禁已经通过。',
              phase: 'final_answer',
            }],
          }],
        };
      },
    } as never;
  });

  try {
    const transcript = await useSharedAgent.getState().readTranscript(target.tmid);
    assert.deepEqual(transcript.map((message) => ({ role: message.role, text: message.text })), [
      { role: 'user', text: '请检查发布门禁' },
      { role: 'assistant', text: '发布门禁已经通过。' },
    ]);
    assert.equal(transcript[0]?.speaker, '张三');
    assert.deepEqual(calls, [
      `connect:${target.sessionId}:${target.workspaceRoots[0]}`,
      `readThread:${target.codexThreadId}`,
    ]);
  } finally {
    restoreFactory();
  }
});

test('读取已结束 Harness 历史后释放 reader，同 key 新会话不会复用旧 controller', { concurrency: false }, async () => {
  const target = readySession('ended-harness-reader', { status: 'ended' });
  const { useSharedAgent, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target]);
  const states: FakeClientState[] = [];
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async () => ({ id: 'unused' }));
    states.push(built.state);
    return {
      ...built.controller,
      readThread: async (threadId: string) => ({ thread: { id: threadId }, turns: [] }),
    } as never;
  });

  try {
    await useSharedAgent.getState().readTranscript(target.tmid);
    assert.equal(states.length, 1);
    assert.equal(states[0].stopped, true);

    const replacement = readySession(target.tmid, {
      sessionId: 'replacement-session',
      codexThreadId: 'replacement-thread',
      workspaceRoots: ['D:/Repos/replacement'],
    });
    useSharedAgent.setState((state) => ({
      sessions: { ...state.sessions, [target.tmid]: replacement },
    }));
    await useSharedAgent.getState().readTranscript(target.tmid);
    assert.equal(states.length, 2);
    assert.equal(states[1].connectedSessionId, 'replacement-session');
  } finally {
    restoreFactory();
  }
});

test('慢速已结束 Harness 读取完成时不会停止同 key 的新会话 controller', { concurrency: false }, async () => {
  const target = readySession('slow-ended-harness-reader', { status: 'ended' });
  const replacement = readySession(target.tmid, {
    sessionId: 'replacement-while-reading',
    codexThreadId: 'replacement-thread-while-reading',
    workspaceRoots: ['D:/Repos/replacement-while-reading'],
  });
  const { useSharedAgent, setSharedAgentControllerFactory } = await loadModules();
  await prepareStore([target]);
  const states: FakeClientState[] = [];
  let finishOldRead: (() => void) | undefined;
  const oldRead = new Promise<void>((resolve) => { finishOldRead = resolve; });
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async () => ({ id: 'unused' }));
    states.push(built.state);
    const index = states.length - 1;
    return {
      ...built.controller,
      readThread: async (threadId: string) => {
        if (index === 0) await oldRead;
        return { thread: { id: threadId }, turns: [] };
      },
    } as never;
  });

  try {
    const staleRead = useSharedAgent.getState().readTranscript(target.tmid);
    while (states.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    useSharedAgent.setState((state) => ({
      sessions: { ...state.sessions, [target.tmid]: replacement },
    }));
    await useSharedAgent.getState().readTranscript(target.tmid);
    assert.equal(states.length, 2);
    assert.equal(states[1].stopped, false);

    finishOldRead?.();
    await staleRead;
    assert.equal(states[1].stopped, false, '旧 reader 的 finally 不得按 tmid 停掉替代会话');
  } finally {
    finishOldRead?.();
    restoreFactory();
  }
});

test('AI 托管只读视图从同一 DSH Harness session.history 读取自然对话', { concurrency: false }, async () => {
  const target = readySession('harness-transcript-dsh', {
    backend: 'deepseek',
    codexThreadId: undefined,
    dshSessionId: 'dsh-harness-history',
  });
  const { useSharedAgent, setSharedAgentDshControllerFactory } = await loadModules();
  await prepareStore([target]);
  const calls: string[] = [];
  let interrupt: ((error: Error) => void) | undefined;
  const restoreFactory = setSharedAgentDshControllerFactory((_workspace, _connectionId, options) => {
    interrupt = options.onInterrupted;
    return ({
    connect: async () => { calls.push('connect'); },
    createSession: async () => { calls.push('createSession'); return 'unused'; },
    resumeSession: async (sessionId) => { calls.push(`resumeSession:${sessionId}`); },
    getTranscript: (sessionId) => {
      calls.push(`getTranscript:${sessionId}`);
      return {
        messages: [
          { id: 'dsh-user', role: 'user', text: '请整理房间结论' },
          { id: 'dsh-assistant', role: 'assistant', text: '已经整理完成。' },
        ],
        activities: [],
      };
    },
    attachmentLeaseId: () => 'unused',
    prompt: async () => { calls.push('prompt'); return { turnId: 'unused', text: '' }; },
    cancel: async () => undefined,
    respondApproval: async () => undefined,
    respondQuestion: async () => undefined,
    stop: async () => undefined,
    });
  });

  try {
    const transcript = await useSharedAgent.getState().readTranscript(target.tmid);
    await useSharedAgent.getState().readTranscript(target.tmid);
    assert.deepEqual(transcript.map((message) => ({ role: message.role, text: message.text })), [
      { role: 'user', text: '请整理房间结论' },
      { role: 'assistant', text: '已经整理完成。' },
    ]);
    assert.deepEqual(calls, [
      'connect',
      `resumeSession:${target.dshSessionId}`,
      `getTranscript:${target.dshSessionId}`,
      `getTranscript:${target.dshSessionId}`,
    ]);
    const disconnect = interrupt;
    assert.ok(disconnect);
    disconnect(new Error('DSH 连接中断'));
    await useSharedAgent.getState().readTranscript(target.tmid);
    assert.deepEqual(calls, [
      'connect',
      `resumeSession:${target.dshSessionId}`,
      `getTranscript:${target.dshSessionId}`,
      `getTranscript:${target.dshSessionId}`,
      'connect',
      `resumeSession:${target.dshSessionId}`,
      `getTranscript:${target.dshSessionId}`,
    ]);
  } finally {
    restoreFactory();
  }
});

test('DeepSeek AI 托管处理历史附件时使用 DSH 暂存路径，不调用 Codex 附件命令', { concurrency: false }, async () => {
  const { useSharedAgent, setSharedAgentDshControllerFactory, resetAiRuntimeProviderForTests, clientModule } = await loadModules();
  resetAiRuntimeProviderForTests('deepseek');
  const chat = await import('../../apps/web/src/stores/chat');
  const target = readySession('deepseek-hosted-attachment', {
    backend: 'deepseek',
    codexThreadId: undefined,
    dshSessionId: 'dsh-session-attachment',
  });
  await prepareStore([target]);
  const command = commandMessage(target.tmid, target.host.userId, 'host', 'deepseek-attachment-command');
  const attachedMessage: RcMessage = {
    _id: 'message-deepseek-history-attachment',
    rid: target.rid,
    tmid: target.tmid,
    msg: '请结合这个附件继续处理',
    ts: new Date().toISOString(),
    u: { _id: 'member-user', username: 'member', name: 'member' },
    attachments: [{
      title: 'spec.txt',
      title_link: '/file-upload/spec.txt',
      title_link_download: true,
    }] as never,
  };
  const chatState = chat.useChat.getState();
  chat.useChat.setState({
    messages: {
      ...chatState.messages,
      [target.rid]: [attachedMessage, command],
    },
    rooms: {
      ...chatState.rooms,
      [target.rid]: { _id: target.rid, t: 'p', fname: '附件房间' } as never,
    },
    subscriptions: {
      ...chatState.subscriptions,
      [target.rid]: { rid: target.rid, t: 'p' } as never,
    },
  });
  const invocations: Array<{ command: string; args?: unknown }> = [];
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: async (commandName: string, args?: unknown) => {
        invocations.push({ command: commandName, args });
        if (commandName === 'dsh_agent_attachment_write') {
          return { path: 'D:/tmp/dsh-attachments/spec.txt', root: 'D:/tmp/dsh-attachments' };
        }
        return [];
      },
    },
  });
  const originalGetThreadMessages = clientModule.rest.getThreadMessages.bind(clientModule.rest);
  const originalFetchFile = clientModule.rest.fetchFile.bind(clientModule.rest);
  clientModule.rest.getThreadMessages = async () => [] as never;
  clientModule.rest.fetchFile = async () => new Blob(['history attachment']) as never;
  let promptText = '';
  const restoreFactory = setSharedAgentDshControllerFactory(() => ({
    connect: async () => undefined,
    createSession: async () => 'unused',
    resumeSession: async () => undefined,
    attachmentLeaseId: () => 'lease-hosted-attachment',
    prompt: async (_sessionId, prompt) => {
      promptText = prompt;
      return { turnId: 'dsh-turn-attachment', text: 'DeepSeek 已检查附件' };
    },
    cancel: async () => undefined,
    respondApproval: async () => undefined,
    respondQuestion: async () => undefined,
    stop: async () => undefined,
  }));

  try {
    await useSharedAgent.getState().handleMessage(command);
    assert.equal(
      invocations.some((entry) => entry.command === 'codex_agent_attachment_write'),
      false,
    );
    const dshWrite = invocations.find((entry) => entry.command === 'dsh_agent_attachment_write');
    assert.ok(dshWrite?.args instanceof Uint8Array);
    const metadataLength = new DataView(
      dshWrite.args.buffer,
      dshWrite.args.byteOffset,
      4,
    ).getUint32(0, true);
    const metadata = JSON.parse(new TextDecoder().decode(
      dshWrite.args.subarray(4, 4 + metadataLength),
    ));
    assert.deepEqual(metadata, {
      connectionId: 'hosting-session-deepseek-hosted-attachment',
      leaseId: 'lease-hosted-attachment',
      relativePath: 'message-deepseek-history-attachment/1-spec.txt',
    });
    assert.match(promptText, /\[附件路径: D:\/tmp\/dsh-attachments\/spec\.txt\]/);
  } finally {
    clientModule.rest.getThreadMessages = originalGetThreadMessages;
    clientModule.rest.fetchFile = originalFetchFile;
    chat.useChat.setState({
      messages: chatState.messages,
      rooms: chatState.rooms,
      subscriptions: chatState.subscriptions,
    });
    restoreFactory();
  }
});

test('开启 Codex 托管时使用启动面板提交的模型、推理和权限快照', { concurrency: false }, async () => {
  const {
    useSharedAgent,
    useCodexWorkspace,
    setSharedAgentControllerFactory,
    clientModule,
  } = await loadModules();
  await prepareStore([]);
  useCodexWorkspace.setState({
    scope: 'same-origin:host-user',
    defaultWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    butlerWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
    selectedModel: 'gpt-test',
    selectedEffort: 'high',
    permissionPreset: 'auto',
  });
  let fake!: FakeClientState;
  const restoreFactory = setSharedAgentControllerFactory((options) => {
    const built = fakeController(options, async (method) => {
      assert.equal(method, 'startThread');
      return { id: 'codex-hosting-selected' };
    });
    fake = built.state;
    return built.controller as never;
  });
  const originalSendMessageRaw = clientModule.rest.sendMessageRaw.bind(clientModule.rest);
  clientModule.rest.sendMessageRaw = async () => ({ _id: createAgentSessionLeaseMessageId() }) as never;

  try {
    const started = await useSharedAgent.getState().startSession('room-codex-selected', 'thread-codex-selected', {
      backend: 'codex',
      workspaceRoot: 'D:/Repos/example',
      replyTmid: 'thread-codex-selected',
      runtimeModel: 'gpt-hosting',
      runtimeEffort: 'high',
      runtimePermissionPreset: 'ask',
    });
    assert.equal(started.runtimeModel, 'gpt-hosting');
    assert.equal(started.runtimeEffort, 'high');
    assert.equal(started.runtimePermissionPreset, 'ask');
    assert.deepEqual(fake.selections[0], {
      model: 'gpt-hosting',
      effort: 'high',
      permissionPreset: 'ask',
    });
    assert.equal(useCodexWorkspace.getState().selectedModel, 'gpt-test');
    assert.equal(useCodexWorkspace.getState().selectedEffort, 'high');
    assert.equal(useCodexWorkspace.getState().permissionPreset, 'auto');
  } finally {
    clientModule.rest.sendMessageRaw = originalSendMessageRaw;
    restoreFactory();
  }
});

test('DeepSeek AI 托管创建和恢复都持久化原生 DSH sessionId', { concurrency: false }, async () => {
  const {
    useSharedAgent,
    useCodexWorkspace,
    prepareSharedDshStartConfiguration,
    setSharedAgentDshControllerFactory,
    clientModule,
    resetAiRuntimeProviderForTests,
  } = await loadModules();
  resetAiRuntimeProviderForTests('deepseek');
  await prepareStore([]);
  useCodexWorkspace.setState({
    scope: 'same-origin:host-user',
    defaultWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-projectless',
    butlerWorkspaceRoot: 'C:/Users/test/AppData/Local/RocketX/codex-butler',
  });
  const calls: string[] = [];
  let createOptions: unknown;
  let factoryCalls = 0;
  const restoreFactory = setSharedAgentDshControllerFactory(() => {
    factoryCalls += 1;
    return {
      connect: async () => { calls.push('connect'); },
      getStartConfiguration: async () => {
        calls.push('catalog');
        return {
          models: { groups: [] },
          agentPresets: [],
        };
      },
      createSession: async (options) => {
        createOptions = options;
        calls.push('create');
        return 'dsh-created-session';
      },
      resumeSession: async (sessionId) => { calls.push(`resume:${sessionId}`); },
      getTranscript: (sessionId) => {
        calls.push(`history:${sessionId}`);
        return { messages: [], activities: [] };
      },
      attachmentLeaseId: () => 'lease-hosted-create',
      prompt: async () => ({ turnId: 'unused', text: '' }),
      cancel: async () => undefined,
      respondApproval: async () => undefined,
      respondQuestion: async () => undefined,
      stop: async () => undefined,
    };
  });
  const originalSendMessageRaw = clientModule.rest.sendMessageRaw.bind(clientModule.rest);
  const originalUpdateMessage = clientModule.rest.updateMessage.bind(clientModule.rest);
  clientModule.rest.sendMessageRaw = async () => ({ _id: createAgentSessionLeaseMessageId() }) as never;
  clientModule.rest.updateMessage = async () => ({}) as never;

  try {
    await prepareSharedDshStartConfiguration('thread-deepseek-create', 'D:/Repos/example');
    const started = await useSharedAgent.getState().startSession('room-deepseek-create', 'thread-deepseek-create', {
      backend: 'deepseek',
      workspaceRoot: 'D:/Repos/example',
      replyTmid: 'thread-deepseek-create',
      dshModelSelection: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
      },
      dshAgentPreset: 'code',
      dshPermissionPreset: 'workspace-write',
    });
    assert.equal(started.backend, 'deepseek');
    assert.equal(started.dshSessionId, 'dsh-created-session');
    assert.equal(started.codexThreadId, undefined);
    assert.equal(started.runtimeModel, undefined);
    assert.deepEqual(started.dshModelSelection, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    });
    assert.equal(started.dshAgentPreset, 'code');
    assert.equal(started.dshPermissionPreset, 'workspace-write');
    assert.deepEqual(createOptions, {
      model: started.dshModelSelection,
      agentPreset: 'code',
      permissionPreset: 'workspace-write',
    });
    assert.equal(factoryCalls, 1);
    await useSharedAgent.getState().readTranscript(started.tmid);
    assert.deepEqual(calls, ['connect', 'catalog', 'create', 'history:dsh-created-session']);

    useSharedAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [started.tmid]: { ...state.sessions[started.tmid], status: 'interrupted' },
      },
    }));
    await useSharedAgent.getState().resumeSession(started.tmid);
    assert.deepEqual(calls, ['connect', 'catalog', 'create', 'history:dsh-created-session', 'resume:dsh-created-session']);
    assert.equal(useSharedAgent.getState().sessions[started.tmid]?.status, 'ready');
  } finally {
    clientModule.rest.sendMessageRaw = originalSendMessageRaw;
    clientModule.rest.updateMessage = originalUpdateMessage;
    restoreFactory();
  }
});

test('结束 DeepSeek 托管时会取消进行中的 turn，且晚到失败不会复活会话或发送失败回复', { concurrency: false }, async () => {
  const { useSharedAgent, setSharedAgentDshControllerFactory, resetAiRuntimeProviderForTests } = await loadModules();
  resetAiRuntimeProviderForTests('deepseek');
  const target = readySession('deepseek-stop-running', {
    backend: 'deepseek',
    codexThreadId: undefined,
    dshSessionId: 'dsh-session-running',
  });
  await prepareStore([target]);
  const invocations = installInvokeRecorder();
  const calls: string[] = [];
  let rejectPrompt!: (error: Error) => void;
  const pendingPrompt = new Promise<{ turnId: string; text: string }>((_resolve, reject) => {
    rejectPrompt = reject;
  });
  const restoreFactory = setSharedAgentDshControllerFactory(() => ({
    connect: async () => { calls.push('connect'); },
    createSession: async () => 'unused',
    resumeSession: async () => undefined,
    attachmentLeaseId: () => 'lease-hosted-running',
    prompt: async () => {
      calls.push('prompt');
      return pendingPrompt;
    },
    cancel: async () => { calls.push('cancel'); },
    respondApproval: async () => undefined,
    respondQuestion: async () => undefined,
    stop: async () => {
      calls.push('stop');
      rejectPrompt(new Error('DSH 连接已关闭'));
    },
  }));

  try {
    const handling = useSharedAgent.getState().handleMessage(
      commandMessage(target.tmid, target.host.userId, 'host', 'deepseek-stop-command'),
    );
    await waitFor(() => useSharedAgent.getState().sessions[target.tmid]?.activeTurnId !== undefined);
    await Promise.all([handling, useSharedAgent.getState().endSession(target.tmid)]);

    assert.deepEqual(calls, ['connect', 'prompt', 'cancel', 'stop']);
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.status, 'ended');
    assert.equal(useSharedAgent.getState().sessions[target.tmid]?.activeTurnId, undefined);
    assert.ok(!invocations.some((entry) => (
      typeof entry.args?.text === 'string' && entry.args.text.includes('DeepSeek 执行失败')
    )));
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
  setRuntimeSelection(useCodexWorkspace);
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
  setRuntimeSelection(useCodexWorkspace);
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
    setRuntimeSelection(useCodexWorkspace, { selectedModel: 'gpt-hosting' });

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
    selectedModel: 'gpt-hosting',
    selectedEffort: 'high',
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
