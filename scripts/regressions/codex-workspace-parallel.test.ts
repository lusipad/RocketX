import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppServerControllerOptions } from '../../apps/web/src/agent/AppServerController';
import { prepareRoomWorkspace } from '../../apps/web/src/components/ButlerPanel';
import {
  resetCodexWorkspaceForTests,
  setCodexWorkspaceControllerFactory,
  useCodexWorkspace,
  type CodexThreadState,
  type CodexWorkspaceEvent,
  type CodexWorkspaceMessage,
} from '../../apps/web/src/stores/codexWorkspace';

const MODEL = {
  id: 'gpt-test',
  model: 'gpt-test',
  displayName: 'GPT Test',
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'balanced' }],
};

const CATALOG = {
  models: [MODEL],
  permissionProfiles: [
    { id: ':workspace', description: null, allowed: true },
    { id: ':danger-full-access', description: null, allowed: true },
  ],
  skills: [],
  apps: [],
  plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
  catalogErrors: {},
};

function thread(id: string, cwd: string) {
  return {
    id,
    name: null,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 1,
    createdAt: 1,
    turns: [],
    cwd,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

async function expectResolvesWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeThreadState(
  workspaceRoot: string,
  overrides: Partial<CodexThreadState> = {},
): CodexThreadState {
  return {
    workspaceRoot,
    runtimeSelection: {
      model: MODEL.model,
      effort: 'medium',
      permissionPreset: 'auto',
    },
    status: 'ready',
    error: null,
    activeTurnId: undefined,
    turns: [],
    messages: [],
    events: [],
    streamingText: '',
    pendingRequests: [],
    queuedMessages: [],
    ...overrides,
  };
}

function setProjectedActiveThread(
  threadId: string,
  threadState: CodexThreadState,
): Pick<
  ReturnType<typeof useCodexWorkspace.getState>,
  'activeThreadId' | 'status' | 'error' | 'activeTurnId' | 'turns' | 'messages' | 'events' | 'streamingText' | 'pendingRequests' | 'queuedMessages'
> {
  return {
    activeThreadId: threadId,
    status: threadState.status,
    error: threadState.error,
    activeTurnId: threadState.activeTurnId,
    turns: threadState.turns,
    messages: threadState.messages,
    events: threadState.events,
    streamingText: threadState.streamingText,
    pendingRequests: threadState.pendingRequests,
    queuedMessages: threadState.queuedMessages,
  };
}

test('AI 管家运行时仍可准备房间工作区，且不会中断管家线程', async () => {
  const switchedRoots: string[] = [];
  const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    currentWorkspaceRoot: 'D:/butler',
    connect: async () => CATALOG,
    switchWorkspaceRoot: (workspaceRoot: string) => {
      switchedRoots.push(workspaceRoot);
      return true;
    },
    listThreads: async () => [],
    interruptTurn: async (threadId: string, turnId: string) => {
      interruptCalls.push({ threadId, turnId });
    },
    stop: async () => undefined,
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    const butlerThread = makeThreadState('D:/butler', {
      status: 'running',
      activeTurnId: 'turn-butler',
      messages: [{ id: 'message-butler', role: 'assistant', text: '管家仍在运行' }],
    });
    useCodexWorkspace.setState({
      defaultWorkspaceRoot: 'D:/rooms',
      butlerWorkspaceRoot: 'D:/butler',
      workspaceRoot: 'D:/butler',
      workspaceRoots: ['D:/rooms', 'D:/butler'],
      threadStates: { 'thread-butler': butlerThread },
      ...setProjectedActiveThread('thread-butler', butlerThread),
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });

    const reconnected = await prepareRoomWorkspace();

    const state = useCodexWorkspace.getState();
    assert.equal(reconnected, false);
    assert.deepEqual(switchedRoots, ['D:/rooms']);
    assert.equal(state.workspaceRoot, 'D:/rooms');
    assert.equal(state.activeThreadId, undefined);
    assert.equal(state.threadStates['thread-butler']?.status, 'running');
    assert.equal(state.threadStates['thread-butler']?.activeTurnId, 'turn-butler');
    assert.equal(state.threadStates['thread-butler']?.messages.at(-1)?.text, '管家仍在运行');
    assert.deepEqual(interruptCalls, []);
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
  }
});

test('另一个房间运行时仍可准备新房间会话，且不会中断原房间线程', async () => {
  const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    currentWorkspaceRoot: 'D:/rooms',
    connect: async () => CATALOG,
    switchWorkspaceRoot: () => true,
    listThreads: async () => [],
    interruptTurn: async (threadId: string, turnId: string) => {
      interruptCalls.push({ threadId, turnId });
    },
    stop: async () => undefined,
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    const firstRoomThread = makeThreadState('D:/rooms', {
      status: 'running',
      activeTurnId: 'turn-room-a',
      messages: [{ id: 'message-room-a', role: 'assistant', text: '房间 A 仍在运行' }],
    });
    useCodexWorkspace.setState({
      defaultWorkspaceRoot: 'D:/rooms',
      butlerWorkspaceRoot: 'D:/butler',
      workspaceRoot: 'D:/rooms',
      workspaceRoots: ['D:/rooms', 'D:/butler'],
      threadStates: { 'thread-room-a': firstRoomThread },
      ...setProjectedActiveThread('thread-room-a', firstRoomThread),
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });

    const reconnected = await prepareRoomWorkspace();

    const state = useCodexWorkspace.getState();
    assert.equal(reconnected, false);
    assert.equal(state.activeThreadId, 'thread-room-a');
    assert.equal(state.threadStates['thread-room-a']?.status, 'running');
    assert.equal(state.threadStates['thread-room-a']?.activeTurnId, 'turn-room-a');
    assert.equal(state.threadStates['thread-room-a']?.messages.at(-1)?.text, '房间 A 仍在运行');
    assert.deepEqual(interruptCalls, []);
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
  }
});

test('Promise.all 并发 startTask 时分别在各自线程启动 turn，且不会打断别的线程', async () => {
  const startTurnCalls: Array<{
    threadId: string;
    input: Array<{ type: string; text?: string }>;
  }> = [];
  const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  const threads = [
    thread('thread-a', 'D:/workspace'),
    thread('thread-b', 'D:/workspace'),
  ];
  let currentWorkspaceRoot = 'D:/workspace';
  let threadIndex = 0;
  const connectGate = deferred<typeof CATALOG>();
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    currentWorkspaceRoot,
    connect: async () => connectGate.promise,
    switchWorkspaceRoot: (workspaceRoot: string) => {
      currentWorkspaceRoot = workspaceRoot;
      return true;
    },
    listThreads: async () => threads,
    startThread: async () => threads[threadIndex++],
    startTurn: async (threadId: string, input: Array<{ type: string; text?: string }>) => {
      startTurnCalls.push({ threadId, input });
      return `turn-${threadId}`;
    },
    interruptTurn: async (threadId: string, turnId: string) => {
      interruptCalls.push({ threadId, turnId });
    },
    stop: async () => undefined,
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.setState({
      workspaceRoot: 'D:/workspace',
      workspaceRoots: ['D:/workspace'],
    });
    const tasks = Promise.all([
      useCodexWorkspace.getState().startTask('检查 PR 1', 'PR 1'),
      useCodexWorkspace.getState().startTask('检查 PR 2', 'PR 2'),
    ]);
    await flushMicrotasks();
    assert.equal(threadIndex, 0, '连接完成前不应开始任何线程');
    connectGate.resolve(CATALOG);
    const [firstThreadId, secondThreadId] = await tasks;

    assert.deepEqual([firstThreadId, secondThreadId].sort(), ['thread-a', 'thread-b']);
    assert.deepEqual(
      startTurnCalls.find((call) => call.threadId === firstThreadId)?.input,
      [{ type: 'text', text: '检查 PR 1', text_elements: [] }],
    );
    assert.deepEqual(
      startTurnCalls.find((call) => call.threadId === secondThreadId)?.input,
      [{ type: 'text', text: '检查 PR 2', text_elements: [] }],
    );
    assert.deepEqual(interruptCalls, []);
    assert.equal(useCodexWorkspace.getState().threadStates['thread-a']?.activeTurnId, 'turn-thread-a');
    assert.equal(useCodexWorkspace.getState().threadStates['thread-b']?.activeTurnId, 'turn-thread-b');
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
  }
});

test('后台线程的通知只更新自己的桶，切回后恢复该线程投影', async () => {
  let callbacks: AppServerControllerOptions | undefined;
  const readTurns = {
    'thread-a': [{
      id: 'turn-a',
      itemsView: 'full',
      status: 'completed',
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      items: [
        { type: 'userMessage', id: 'user-a', content: [{ type: 'text', text: 'A', text_elements: [] }] },
        { type: 'agentMessage', id: 'agent-a', text: 'A 的完成输出', phase: null },
      ],
    }],
    'thread-b': [{
      id: 'turn-b',
      itemsView: 'full',
      status: 'completed',
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      items: [
        { type: 'userMessage', id: 'user-b', content: [{ type: 'text', text: 'B', text_elements: [] }] },
        { type: 'agentMessage', id: 'agent-b', text: 'B 初始消息', phase: null },
      ],
    }],
  } as const;
  const restoreFactory = setCodexWorkspaceControllerFactory((options) => {
    callbacks = options;
    return {
      currentWorkspaceRoot: 'D:/workspace',
      connect: async () => CATALOG,
      switchWorkspaceRoot: () => true,
      listThreads: async () => [],
      readThread: async (threadId: 'thread-a' | 'thread-b') => ({
        thread: thread(threadId, 'D:/workspace'),
        turns: [...readTurns[threadId]],
      }),
      stop: async () => undefined,
    } as never;
  });

  try {
    await resetCodexWorkspaceForTests();
    const threadA = makeThreadState('D:/workspace', {
      status: 'ready',
      messages: [{ id: 'message-a0', role: 'assistant', text: 'A 初始消息' }],
      events: [{ id: 'event-a0', type: 'reasoning', title: 'A 初始事件', status: 'completed' }],
    });
    const threadB = makeThreadState('D:/workspace', {
      status: 'ready',
      messages: [{ id: 'message-b0', role: 'assistant', text: 'B 初始消息' }],
      events: [{ id: 'event-b0', type: 'reasoning', title: 'B 初始事件', status: 'completed' }],
    });
    useCodexWorkspace.setState({
      workspaceRoot: 'D:/workspace',
      workspaceRoots: ['D:/workspace'],
      threadStates: { 'thread-a': threadA, 'thread-b': threadB },
      ...setProjectedActiveThread('thread-a', threadA),
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });

    await useCodexWorkspace.getState().resumeThread('thread-b');
    callbacks!.onNotification?.('turn/started', {
      threadId: 'thread-a',
      turn: { id: 'turn-a' },
    });
    callbacks!.onNotification?.('item/started', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      item: {
        type: 'commandExecution',
        id: 'command-a',
        command: 'pnpm test',
        cwd: 'D:/workspace',
        processId: null,
        source: 'agent',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });
    callbacks!.onNotification?.('item/agentMessage/delta', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'agent-a',
      delta: 'A 的完成输出',
    });
    callbacks!.onNotification?.('item/completed', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      item: {
        type: 'commandExecution',
        id: 'command-a',
        command: 'pnpm test',
        cwd: 'D:/workspace',
        processId: null,
        source: 'agent',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'done',
        exitCode: 0,
        durationMs: 12,
      },
    });
    callbacks!.onNotification?.('turn/completed', {
      threadId: 'thread-a',
      turn: { id: 'turn-a', status: 'completed' },
    });
    await flushMicrotasks();

    const whileViewingB = useCodexWorkspace.getState();
    assert.equal(whileViewingB.activeThreadId, 'thread-b');
    assert.equal(whileViewingB.messages.at(-1)?.text, 'B 初始消息');
    assert.equal(whileViewingB.events.some((event) => event.id === 'command-a'), false);

    const storedA = whileViewingB.threadStates['thread-a']!;
    assert.equal(storedA.status, 'ready');
    assert.equal(storedA.messages.at(-1)?.text, 'A 的完成输出');
    assert.equal(storedA.events.find((event) => event.id === 'command-a')?.status, 'completed');

    await useCodexWorkspace.getState().resumeThread('thread-a');

    const switchedBack = useCodexWorkspace.getState();
    assert.equal(switchedBack.activeThreadId, 'thread-a');
    assert.equal(switchedBack.status, 'ready');
    assert.equal(switchedBack.messages.at(-1)?.text, 'A 的完成输出');
    assert.equal(switchedBack.events.find((event) => event.id === 'command-a')?.status, 'completed');
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
  }
});

test('审批请求按 threadId 隔离，并按该线程的 workspaceRoot 解析批准路径', async () => {
  let callbacks: AppServerControllerOptions | undefined;
  const restoreFactory = setCodexWorkspaceControllerFactory((options) => {
    callbacks = options;
    return {
      currentWorkspaceRoot: 'D:/workspace-b',
      connect: async () => CATALOG,
      switchWorkspaceRoot: () => true,
      listThreads: async () => [],
      stop: async () => undefined,
    } as never;
  });

  try {
    await resetCodexWorkspaceForTests();
    const threadA = makeThreadState('D:/workspace-a', {
      status: 'running',
      activeTurnId: 'turn-a',
    });
    const threadB = makeThreadState('D:/workspace-b', {
      status: 'running',
      activeTurnId: 'turn-b',
      messages: [{ id: 'message-b', role: 'assistant', text: 'B 仍在运行' }],
    });
    useCodexWorkspace.setState({
      workspaceRoot: 'D:/workspace-b',
      workspaceRoots: ['D:/workspace-b', 'D:/workspace-a'],
      threadStates: { 'thread-a': threadA, 'thread-b': threadB },
      ...setProjectedActiveThread('thread-b', threadB),
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });

    const approvalPromise = callbacks!.onServerRequest!({
      method: 'item/permissions/requestApproval',
      policy: 'host-approval',
      params: {
        threadId: 'thread-a',
        turnId: 'turn-a',
        permissions: {
          fileSystem: {
            read: ['D:/workspace-a/docs/spec.md'],
            write: ['D:/workspace-a/out/report.md'],
          },
        },
      },
    });

    const duringPending = useCodexWorkspace.getState();
    const pendingA = duringPending.threadStates['thread-a']!.pendingRequests[0];
    assert.ok(pendingA);
    assert.equal(duringPending.threadStates['thread-a']!.status, 'waiting-input');
    assert.equal(duringPending.activeThreadId, 'thread-b');
    assert.deepEqual(duringPending.pendingRequests, []);
    assert.equal(duringPending.threadStates['thread-b']!.status, 'running');

    useCodexWorkspace.getState().resolveRequest(pendingA.id, { action: 'accept' });

    assert.deepEqual(await expectResolvesWithin(
      approvalPromise,
      100,
      'resolveRequest 没有唤醒非当前线程的审批请求',
    ), {
      permissions: {
        fileSystem: {
          read: ['D:/workspace-a/docs/spec.md'],
          write: ['D:/workspace-a/out/report.md'],
        },
      },
      scope: 'turn',
      strictAutoReview: true,
    });
    assert.equal(useCodexWorkspace.getState().threadStates['thread-a']!.status, 'running');
    assert.equal(useCodexWorkspace.getState().threadStates['thread-a']!.pendingRequests.length, 0);
    assert.equal(useCodexWorkspace.getState().threadStates['thread-b']!.status, 'running');
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
  }
});

test('切换 workspace 不会删除或中断其他运行中的 threadState', async () => {
  let stopCalls = 0;
  let interruptCalls = 0;
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    currentWorkspaceRoot: 'D:/workspace-a',
    connect: async () => CATALOG,
    switchWorkspaceRoot: () => false,
    listThreads: async () => [],
    interruptTurn: async () => {
      interruptCalls += 1;
    },
    stop: async () => {
      stopCalls += 1;
    },
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    const threadA = makeThreadState('D:/workspace-a', {
      status: 'running',
      activeTurnId: 'turn-a',
      messages: [{ id: 'message-a', role: 'assistant', text: 'A 正在运行' }],
    });
    useCodexWorkspace.setState({
      workspaceRoot: 'D:/workspace-a',
      workspaceRoots: ['D:/workspace-a'],
      threadStates: { 'thread-a': threadA },
      ...setProjectedActiveThread('thread-a', threadA),
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });

    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace-b');

    const state = useCodexWorkspace.getState();
    assert.equal(state.workspaceRoot, 'D:/workspace-b');
    assert.equal(state.activeThreadId, undefined);
    assert.equal(state.threadStates['thread-a']?.status, 'running');
    assert.equal(state.threadStates['thread-a']?.activeTurnId, 'turn-a');
    assert.equal(state.threadStates['thread-a']?.messages.at(-1)?.text, 'A 正在运行');
    assert.equal(stopCalls, 0);
    assert.equal(interruptCalls, 0);
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
  }
});

test('打开 external-writer 线程时只 unsubscribe 目标线程，其他运行桶保持不变', async () => {
  const unsubscribeCalls: string[] = [];
  let stopCalls = 0;
  const externalTurn = {
    id: 'turn-external',
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [
      { type: 'userMessage', id: 'user-external', content: [{ type: 'text', text: '外部处理', text_elements: [] }] },
      { type: 'agentMessage', id: 'agent-external', text: '外部线程已完成', phase: null },
    ],
  };
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    currentWorkspaceRoot: 'D:/workspace',
    connect: async () => CATALOG,
    switchWorkspaceRoot: () => true,
    listThreads: async () => [],
    resumeThread: async (threadId: string) => {
      if (threadId === 'thread-external') {
        throw new Error('thread thread-external already has an active writer');
      }
      return thread(threadId, 'D:/workspace');
    },
    readThread: async (threadId: string) => ({
      thread: thread(threadId, 'D:/workspace'),
      turns: threadId === 'thread-external' ? [externalTurn] : [],
    }),
    unsubscribeThread: async (threadId: string) => {
      unsubscribeCalls.push(threadId);
    },
    stop: async () => {
      stopCalls += 1;
    },
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    const runningThread = makeThreadState('D:/workspace', {
      status: 'running',
      activeTurnId: 'turn-running',
      messages: [{ id: 'running-message', role: 'assistant', text: '另一个线程仍在运行' }],
      events: [{ id: 'running-event', type: 'reasoning', title: '运行中', status: 'running' } as CodexWorkspaceEvent],
    });
    useCodexWorkspace.setState({
      workspaceRoot: 'D:/workspace',
      workspaceRoots: ['D:/workspace'],
      threadStates: { 'thread-running': runningThread },
      ...setProjectedActiveThread('thread-running', runningThread),
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });

    await useCodexWorkspace.getState().resumeThread('thread-external');

    const state = useCodexWorkspace.getState();
    assert.deepEqual(unsubscribeCalls, ['thread-external']);
    assert.equal(stopCalls, 0);
    assert.equal(state.activeThreadId, 'thread-external');
    assert.equal(state.status, 'external');
    assert.equal(state.messages.at(-1)?.text, '外部线程已完成');
    assert.equal(state.threadStates['thread-running']?.status, 'running');
    assert.equal(state.threadStates['thread-running']?.activeTurnId, 'turn-running');
    assert.equal(state.threadStates['thread-running']?.messages.at(-1)?.text, '另一个线程仍在运行');
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
  }
});
