import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppServerControllerOptions } from '../../apps/web/src/agent/AppServerController';
import {
  resetCodexWorkspaceForTests,
  runExistingThreadAutomation,
  setCodexWorkspaceControllerFactory,
  useCodexWorkspace,
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

function thread(id: string, cwd?: string) {
  return {
    id,
    name: null,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 1,
    createdAt: 1,
    turns: [],
    ...(cwd ? { cwd } : {}),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('切换项目时保留已加载的全项目线程计数，连接完成后再原子刷新', async () => {
  await resetCodexWorkspaceForTests();
  const threads = [thread('thread-a', 'D:/workspace-a'), thread('thread-b', 'D:/workspace-b')];
  useCodexWorkspace.setState({
    workspaceRoot: 'D:/workspace-a',
    workspaceRoots: ['D:/workspace-a', 'D:/workspace-b'],
    threads,
  });

  await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace-b');

  assert.deepEqual(useCodexWorkspace.getState().threads, threads);
});

test('刷新项目列表期间保留旧计数，完整结果返回后一次替换', async () => {
  const nextThreads = deferred<ReturnType<typeof thread>[]>();
  const oldThreads = [thread('thread-a', 'D:/workspace-a'), thread('thread-b', 'D:/workspace-b')];
  let requestedRoots: readonly string[] | undefined;
  let connecting: Promise<void> | undefined;
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => ({
      models: [MODEL],
      permissionProfiles: [
        { id: ':workspace', description: null, allowed: true },
        { id: ':danger-full-access', description: null, allowed: true },
      ],
      skills: [],
      apps: [],
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    }),
    listThreads: async (roots: readonly string[]) => {
      requestedRoots = roots;
      return nextThreads.promise;
    },
    stop: async () => undefined,
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.setState({
      scope: '',
      workspaceRoot: 'D:/workspace-a',
      workspaceRoots: ['D:/workspace-a', 'D:/workspace-b'],
      threads: oldThreads,
    });
    connecting = useCodexWorkspace.getState().connect();
    for (let index = 0; index < 10 && !requestedRoots; index += 1) await Promise.resolve();

    assert.deepEqual(useCodexWorkspace.getState().threads, oldThreads);
    assert.deepEqual(requestedRoots, ['D:/workspace-a', 'D:/workspace-b']);

    const refreshed = [thread('thread-c', 'D:/workspace-a')];
    nextThreads.resolve(refreshed);
    await connecting;
    assert.deepEqual(useCodexWorkspace.getState().threads, refreshed);
  } finally {
    nextThreads.resolve([]);
    await connecting?.catch(() => undefined);
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('房间快速连接不等待项目会话列表', async () => {
  let listCalls = 0;
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => ({
      models: [MODEL],
      permissionProfiles: [
        { id: ':workspace', description: null, allowed: true },
        { id: ':danger-full-access', description: null, allowed: true },
      ],
      skills: [],
      apps: [],
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    }),
    listThreads: async () => {
      listCalls += 1;
      return [];
    },
    stop: async () => undefined,
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.setState({
      scope: '',
      workspaceRoot: 'D:/room-workspace',
      workspaceRoots: ['D:/room-workspace', 'D:/project'],
    });

    await useCodexWorkspace.getState().connect({ refreshThreads: false });

    assert.equal(useCodexWorkspace.getState().status, 'ready');
    assert.equal(listCalls, 0);
  } finally {
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('房间工作区复用已连接 Runtime，不停止并重新加载目录', async () => {
  let stopCalls = 0;
  let switchedTo = '';
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => ({
      models: [MODEL],
      permissionProfiles: [
        { id: ':workspace', description: null, allowed: true },
        { id: ':danger-full-access', description: null, allowed: true },
      ],
      skills: [],
      apps: [],
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    }),
    listThreads: async () => [],
    switchWorkspaceRoot: (workspaceRoot: string) => {
      switchedTo = workspaceRoot;
      return true;
    },
    stop: async () => {
      stopCalls += 1;
    },
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.setState({
      scope: '',
      workspaceRoot: 'D:/project',
      workspaceRoots: ['D:/project', 'D:/room-workspace'],
      activeThreadId: 'project-thread',
      messages: [{ id: 'message-1', role: 'assistant', text: 'project' }],
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });

    await useCodexWorkspace.getState().setWorkspaceRoot('D:/room-workspace', { reuseRuntime: true });

    const state = useCodexWorkspace.getState();
    assert.equal(switchedTo, 'D:/room-workspace');
    assert.equal(stopCalls, 0);
    assert.equal(state.status, 'ready');
    assert.equal(state.activeThreadId, undefined);
    assert.deepEqual(state.messages, []);
    assert.equal(state.models[0]?.model, 'gpt-test');
  } finally {
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('heartbeat 复用现有线程并返回该次 turn 的最终回复', async () => {
  const catalog = {
    models: [MODEL],
    permissionProfiles: [
      { id: ':workspace', description: null, allowed: true },
      { id: ':danger-full-access', description: null, allowed: true },
    ],
    skills: [],
    apps: [],
    plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
  };
  const storedThread = thread('thread-heartbeat', 'D:/workspace');
  const completedTurn = {
    id: 'turn-heartbeat',
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [
      { type: 'userMessage', id: 'heartbeat-user', content: [{ type: 'text', text: '继续检查', text_elements: [] }] },
      { type: 'agentMessage', id: 'heartbeat-agent', text: '目标会话已继续处理', phase: null },
    ],
  };
  const calls: Array<{ method: string; threadId: string; value?: unknown }> = [];
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    currentWorkspaceRoot: 'D:/workspace',
    currentCatalog: catalog,
    connect: async () => catalog,
    listThreads: async () => [storedThread],
    resumeThread: async (threadId: string, selection: unknown) => {
      calls.push({ method: 'resumeThread', threadId, value: selection });
      return storedThread;
    },
    startTurn: async (threadId: string, input: unknown) => {
      calls.push({ method: 'startTurn', threadId, value: input });
      return completedTurn.id;
    },
    readThread: async (threadId: string) => {
      calls.push({ method: 'readThread', threadId });
      return { thread: storedThread, turns: [completedTurn] };
    },
    interruptTurn: async () => undefined,
    stop: async () => undefined,
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.setState({
      scope: '',
      workspaceRoot: 'D:/workspace',
      workspaceRoots: ['D:/workspace'],
      permissionPreset: 'auto',
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });

    const result = await runExistingThreadAutomation({
      threadId: storedThread.id,
      workspaceRoot: 'D:/workspace',
      text: '继续检查',
      model: MODEL.model,
      effort: 'medium',
      permissionPreset: 'auto',
    });

    assert.deepEqual(result, { text: '目标会话已继续处理', threadId: storedThread.id });
    assert.deepEqual(calls.map((call) => call.method), ['resumeThread', 'startTurn', 'readThread']);
    assert.equal(calls.every((call) => call.threadId === storedThread.id), true);
  } finally {
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('工作区显示原生输入卡，并把命令输出、思考与 Diff 投影为实时活动', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  let callbacks: AppServerControllerOptions | undefined;
  const fakeController = {
    connect: async () => ({
      models: [MODEL],
      permissionProfiles: [
        { id: ':workspace', description: null, allowed: true },
        { id: ':danger-full-access', description: null, allowed: true },
      ],
      skills: [],
      apps: [],
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    }),
    listThreads: async () => [],
    startThread: async () => thread('thread-1'),
    startTurn: async () => 'turn-2',
    stop: async () => undefined,
  };
  const restoreFactory = setCodexWorkspaceControllerFactory((options) => {
    callbacks = options;
    return fakeController as never;
  });

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('account-1');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    await useCodexWorkspace.getState().connect();
    await useCodexWorkspace.getState().startThread();

    const response = callbacks!.onServerRequest!({
      method: 'item/tool/requestUserInput',
      policy: 'host-input',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [{ id: 'scope', header: '范围', question: '处理哪些项目？', options: [] }],
        autoResolutionMs: null,
      },
    });
    const [pending] = useCodexWorkspace.getState().pendingRequests;
    assert.equal(pending.kind, 'user-input');
    assert.equal(useCodexWorkspace.getState().status, 'waiting-input');

    useCodexWorkspace.getState().resolveRequest(pending.id, {
      action: 'accept',
      values: { scope: '全部' },
    });
    assert.deepEqual(await response, {
      answers: { scope: { answers: ['全部'] } },
    });
    assert.deepEqual(useCodexWorkspace.getState().pendingRequests, []);

    callbacks!.onNotification?.('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'commandExecution',
        id: 'command-1',
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
    callbacks!.onNotification?.('item/commandExecution/outputDelta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'command-1',
      delta: '530 tests passed\n',
    });
    callbacks!.onNotification?.('item/reasoning/summaryTextDelta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'reasoning-1',
      delta: '先检查回归。',
      summaryIndex: 0,
    });
    callbacks!.onNotification?.('item/reasoning/textDelta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'reasoning-1',
      delta: '再检查真实运行。',
      contentIndex: 0,
    });
    callbacks!.onNotification?.('turn/diff/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      diff: 'diff --git a/a.ts b/a.ts',
    });

    const events = useCodexWorkspace.getState().events;
    assert.equal(events.find((event) => event.id === 'command-1')?.summary, 'pnpm test');
    assert.match(events.find((event) => event.id === 'command-1')?.detail ?? '', /530 tests passed/);
    assert.equal(events.find((event) => event.id === 'reasoning-1')?.detail, '先检查回归。再检查真实运行。');
    assert.match(events.find((event) => event.type === 'turnDiff')?.detail ?? '', /diff --git/);

    callbacks!.onNotification?.('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'message-1',
      delta: '保留已生成的部分结果',
    });
    callbacks!.onNotification?.('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'interrupted' },
    });
    const interrupted = useCodexWorkspace.getState();
    assert.equal(interrupted.status, 'ready');
    assert.equal(interrupted.error, 'Codex 本轮已中断');
    assert.equal(interrupted.events.find((event) => event.id === 'command-1')?.status, 'failed');
    assert.equal(interrupted.messages.at(-1)?.text, '保留已生成的部分结果');

    await useCodexWorkspace.getState().send('继续构建');
    assert.deepEqual(useCodexWorkspace.getState().events, []);

    callbacks!.onNotification?.('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-2' },
    });
    callbacks!.onNotification?.('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-2',
      item: {
        type: 'commandExecution',
        id: 'command-2',
        command: 'pnpm build',
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
    assert.deepEqual(useCodexWorkspace.getState().events.map((event) => event.id), ['command-2']);
    callbacks!.onNotification?.('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'message-2',
      delta: '进程退出前的部分输出',
    });
    useCodexWorkspace.setState({
      queuedMessages: [{ id: 'queued-1', text: '继续验证安装包', images: [] }],
    });
    callbacks!.onInterrupted?.(new Error('Codex app-server 已退出（1）'));

    const processInterrupted = useCodexWorkspace.getState();
    assert.equal(processInterrupted.status, 'interrupted');
    assert.equal(processInterrupted.activeThreadId, 'thread-1');
    assert.equal(processInterrupted.activeTurnId, undefined);
    assert.equal(processInterrupted.streamingText, '');
    assert.deepEqual(processInterrupted.queuedMessages, []);
    assert.match(processInterrupted.error ?? '', /1 条排队消息未执行/);
    assert.equal(processInterrupted.events.find((event) => event.id === 'command-2')?.status, 'failed');
    assert.equal(processInterrupted.messages.at(-1)?.text, '进程退出前的部分输出');
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('恢复会话遇到失效 Runtime 时自动重连一次', async () => {
  const storedThread = thread('thread-room');
  let controllerCount = 0;
  const restoreFactory = setCodexWorkspaceControllerFactory((options) => {
    const generation = ++controllerCount;
    return {
      connect: async () => ({
        models: [MODEL],
        permissionProfiles: [
          { id: ':workspace', description: null, allowed: true },
          { id: ':danger-full-access', description: null, allowed: true },
        ],
        skills: [],
        apps: [],
        plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
      }),
      listThreads: async () => [storedThread],
      resumeThread: async () => {
        if (generation === 1) {
          options.onInterrupted?.(new Error('Codex app-server 已退出（1）'));
          throw new Error('Codex Runtime 尚未连接');
        }
        return storedThread;
      },
      readThread: async () => ({ thread: storedThread, turns: [] }),
      stop: async () => undefined,
    } as never;
  });

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.setState({ workspaceRoot: 'D:/workspace', workspaceRoots: ['D:/workspace'] });
    await useCodexWorkspace.getState().connect();

    await useCodexWorkspace.getState().resumeThread(storedThread.id);

    assert.equal(controllerCount, 2);
    assert.equal(useCodexWorkspace.getState().status, 'ready');
    assert.equal(useCodexWorkspace.getState().activeThreadId, storedThread.id);
    assert.equal(useCodexWorkspace.getState().error, null);
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
  }
});

test('旧 Controller 的延迟中断不会清除新 Runtime', async () => {
  const callbacks: AppServerControllerOptions[] = [];
  let controllerCount = 0;
  const restoreFactory = setCodexWorkspaceControllerFactory((options) => {
    callbacks.push(options);
    controllerCount += 1;
    return {
      connect: async () => ({
        models: [MODEL],
        permissionProfiles: [
          { id: ':workspace', description: null, allowed: true },
          { id: ':danger-full-access', description: null, allowed: true },
        ],
        skills: [],
        apps: [],
        plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
      }),
      listThreads: async () => [],
      stop: async () => undefined,
    } as never;
  });

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.setState({ workspaceRoot: 'D:/workspace', workspaceRoots: ['D:/workspace'] });
    await useCodexWorkspace.getState().connect();
    callbacks[0]!.onInterrupted?.(new Error('旧 Runtime 已退出'));
    await useCodexWorkspace.getState().connect();

    callbacks[0]!.onInterrupted?.(new Error('旧 Runtime 延迟上报退出'));

    assert.equal(controllerCount, 2);
    assert.equal(useCodexWorkspace.getState().status, 'ready');
    assert.equal(useCodexWorkspace.getState().error, null);
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
  }
});

test('工作区只持久化工作区和 Codex 设置，不保存任务正文', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('account-persist');
    assert.equal(useCodexWorkspace.getState().followUpMode, 'steer');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/another-workspace');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    assert.deepEqual(useCodexWorkspace.getState().workspaceRoots, [
      'D:/workspace',
      'D:/another-workspace',
    ]);
    useCodexWorkspace.setState({
      messages: [{ id: 'secret', role: 'user', text: '敏感任务正文' }],
      events: [{ id: 'event', type: 'reasoning', title: '敏感过程', status: 'completed' }],
      hostingModel: 'gpt-hosting',
      hostingEffort: 'high',
    });
    useCodexWorkspace.getState().setFollowUpMode('steer');

    const saved = values.get('rcx-codex-workspace-v1:account-persist');
    assert.ok(saved);
    assert.deepEqual(JSON.parse(saved), {
      workspaceRoot: 'D:/workspace',
      workspaceRoots: ['D:/workspace', 'D:/another-workspace'],
      selectedEffort: null,
      hostingModel: 'gpt-hosting',
      hostingEffort: 'high',
      permissionPreset: 'auto',
      followUpMode: 'steer',
    });
    assert.equal(saved.includes('敏感任务正文'), false);
    assert.equal(saved.includes('敏感过程'), false);
  } finally {
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('快速依次打开多个会话时只展示最后点击的会话', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  const threadA = thread('thread-a');
  const threadB = thread('thread-b');
  const threadC = thread('thread-c');
  const resumeB = deferred<typeof threadB>();
  const resumeC = deferred<typeof threadC>();
  const readB = deferred<{ thread: typeof threadB; turns: never[] }>();
  const readC = deferred<{ thread: typeof threadC; turns: Array<Record<string, unknown>> }>();
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => ({
      models: [MODEL],
      permissionProfiles: [],
      skills: [],
      apps: [],
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    }),
    listThreads: async () => [threadA, threadB, threadC],
    resumeThread: async (threadId: string) => {
      if (threadId === threadA.id) return threadA;
      return threadId === threadB.id ? resumeB.promise : resumeC.promise;
    },
    readThread: async (threadId: string) => {
      if (threadId === threadA.id) return { thread: threadA, turns: [] };
      return threadId === threadB.id ? readB.promise : readC.promise;
    },
    stop: async () => undefined,
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('account-thread-race');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    await useCodexWorkspace.getState().connect();
    await useCodexWorkspace.getState().resumeThread(threadA.id);

    const openingB = useCodexWorkspace.getState().resumeThread(threadB.id);
    const openingC = useCodexWorkspace.getState().resumeThread(threadC.id);

    resumeC.resolve(threadC);
    await Promise.resolve();
    readC.resolve({
      thread: threadC,
      turns: [{
        id: 'turn-c',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'message-c', text: '这是会话 C', phase: null }],
      }],
    });
    await openingC;
    assert.equal(useCodexWorkspace.getState().activeThreadId, threadC.id);

    resumeB.resolve(threadB);
    await Promise.resolve();
    readB.resolve({ thread: threadB, turns: [] });
    await openingB;

    const state = useCodexWorkspace.getState();
    assert.equal(state.activeThreadId, threadC.id);
    assert.equal(state.messages.at(-1)?.text, '这是会话 C');
    assert.equal(state.status, 'ready');
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('读取 Codex 线程时把生成图片附加到本轮最后一条回复', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  const storedThread = thread('thread-image');
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => ({
      models: [MODEL],
      permissionProfiles: [],
      skills: [],
      apps: [],
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    }),
    listThreads: async () => [storedThread],
    resumeThread: async () => storedThread,
    readThread: async () => ({
      thread: storedThread,
      turns: [{
        id: 'turn-image',
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        items: [
          { type: 'userMessage', id: 'user-image', clientId: null, content: [{ type: 'text', text: '画一只小狗', text_elements: [] }] },
          { type: 'agentMessage', id: 'agent-image', text: '图片已经生成。', phase: null, memoryCitation: null },
          {
            type: 'imageGeneration',
            id: 'generated-image',
            status: 'completed',
            revisedPrompt: '一只小狗',
            result: 'iVBORw0KGgoAAAANSUhEUg',
            savedPath: 'C:/Users/test/.codex/generated_images/dog.png',
          },
        ],
      }],
    }),
    stop: async () => undefined,
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('account-image');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    await useCodexWorkspace.getState().connect();
    await useCodexWorkspace.getState().resumeThread(storedThread.id);

    const reply = useCodexWorkspace.getState().messages.find((message) => message.id === 'agent-image');
    assert.equal(reply?.generatedImages?.length, 1);
    assert.deepEqual(reply?.generatedImages?.[0], {
      id: 'generated-image',
      name: 'dog.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg',
      savedPath: 'C:/Users/test/.codex/generated_images/dog.png',
      alt: '一只小狗',
    });
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('交给 Codex App 时停止空闲 app-server，立即释放线程写入权', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  let stopped = 0;
  let unsubscribed = 0;
  const storedThread = thread('thread-handoff');
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => ({
      models: [MODEL],
      permissionProfiles: [],
      skills: [],
      apps: [],
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    }),
    listThreads: async () => [storedThread],
    resumeThread: async () => storedThread,
    readThread: async () => ({ thread: storedThread, turns: [] }),
    unsubscribeThread: async () => { unsubscribed += 1; },
    stop: async () => { stopped += 1; },
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('account-handoff');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    await useCodexWorkspace.getState().connect();
    await useCodexWorkspace.getState().resumeThread(storedThread.id);

    await useCodexWorkspace.getState().handoffToCodex();

    const state = useCodexWorkspace.getState();
    assert.equal(unsubscribed, 1);
    assert.equal(stopped, 1);
    assert.equal(state.status, 'external');
    assert.equal(state.activeThreadId, storedThread.id);
    assert.equal(state.activeTurnId, undefined);
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('heartbeat 使用共享 app-server 时阻止桌面交接停止运行时', async () => {
  const catalog = {
    models: [MODEL],
    permissionProfiles: [],
    skills: [],
    apps: [],
    plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
  };
  const heartbeatThread = thread('thread-heartbeat-running', 'D:/workspace');
  const heartbeatStarted = deferred<void>();
  const heartbeatFinished = deferred<void>();
  let stopped = 0;
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    currentWorkspaceRoot: 'D:/workspace',
    currentCatalog: catalog,
    connect: async () => catalog,
    listThreads: async () => [],
    resumeThread: async () => heartbeatThread,
    startTurn: async () => {
      heartbeatStarted.resolve();
      return 'turn-heartbeat-running';
    },
    readThread: async () => {
      await heartbeatFinished.promise;
      return {
        thread: heartbeatThread,
        turns: [{
          id: 'turn-heartbeat-running',
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          items: [{ type: 'agentMessage', id: 'heartbeat-answer', text: '完成', phase: null }],
        }],
      };
    },
    interruptTurn: async () => undefined,
    stop: async () => { stopped += 1; },
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.setState({
      workspaceRoot: 'D:/workspace',
      workspaceRoots: ['D:/workspace'],
      activeThreadId: 'thread-handoff',
      status: 'ready',
      threadStates: {
        'thread-handoff': {
          workspaceRoot: 'D:/workspace',
          runtimeSelection: undefined,
          status: 'ready',
          error: null,
          activeTurnId: undefined,
          turns: [],
          messages: [],
          events: [],
          streamingText: '',
          pendingRequests: [],
          queuedMessages: [],
        },
      },
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });
    const heartbeat = runExistingThreadAutomation({
      threadId: heartbeatThread.id,
      workspaceRoot: 'D:/workspace',
      text: '继续检查',
    });
    await heartbeatStarted.promise;

    await assert.rejects(
      useCodexWorkspace.getState().handoffToCodex(),
      /已安排任务正在运行/,
    );
    assert.equal(stopped, 0);
    heartbeatFinished.resolve();
    await heartbeat;
  } finally {
    heartbeatFinished.resolve();
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('当前线程连接中或其他 RocketX 任务运行时不停止共享 app-server', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  let stopped = 0;
  let unsubscribed = 0;
  const storedThread = thread('thread-handoff-busy');
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => ({
      models: [MODEL],
      permissionProfiles: [],
      skills: [],
      apps: [],
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    }),
    listThreads: async () => [storedThread],
    resumeThread: async () => storedThread,
    readThread: async () => ({ thread: storedThread, turns: [] }),
    unsubscribeThread: async () => { unsubscribed += 1; },
    stop: async () => { stopped += 1; },
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('account-handoff-busy');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    await useCodexWorkspace.getState().connect();
    await useCodexWorkspace.getState().resumeThread(storedThread.id);
    useCodexWorkspace.setState((state) => ({
      status: 'connecting',
      threadStates: {
        ...state.threadStates,
        [storedThread.id]: {
          ...state.threadStates[storedThread.id]!,
          status: 'connecting',
        },
      },
    }));

    await assert.rejects(
      useCodexWorkspace.getState().handoffToCodex(),
      /正在连接/,
    );
    assert.equal(unsubscribed, 0);
    assert.equal(stopped, 0);

    useCodexWorkspace.setState((state) => ({
      status: 'ready',
      threadStates: {
        ...state.threadStates,
        [storedThread.id]: {
          ...state.threadStates[storedThread.id]!,
          status: 'ready',
        },
        'thread-running': {
          ...state.threadStates[storedThread.id]!,
          status: 'running',
          activeTurnId: 'turn-running',
        },
      },
    }));

    await assert.rejects(
      useCodexWorkspace.getState().handoffToCodex(),
      /还有其他 RocketX 任务正在运行/,
    );
    assert.equal(unsubscribed, 0);
    assert.equal(stopped, 0);
    assert.equal(useCodexWorkspace.getState().status, 'ready');
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('从列表打开 Codex App 正在使用的线程时只读加载，不暴露写入者错误', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  const storedThread = thread('thread-owned-by-codex');
  const externalTurn = {
    id: 'turn-external',
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [
      { type: 'userMessage', id: 'external-user', content: [{ type: 'text', text: '在 Codex App 中继续', text_elements: [] }] },
      { type: 'agentMessage', id: 'external-agent', text: 'Codex App 已处理完成', phase: null },
    ],
  };
  let stopped = 0;
  let unsubscribed = 0;
  let writerActive = true;
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => ({
      models: [MODEL],
      permissionProfiles: [],
      skills: [],
      apps: [],
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    }),
    listThreads: async () => [storedThread],
    resumeThread: async () => {
      if (writerActive) throw new Error(`thread ${storedThread.id} already has an active writer`);
      throw new Error('MCP 配置无效');
    },
    readThread: async () => ({ thread: storedThread, turns: [externalTurn] }),
    unsubscribeThread: async () => { unsubscribed += 1; },
    stop: async () => { stopped += 1; },
  } as never));

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('account-external-list');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    await useCodexWorkspace.getState().connect();

    await useCodexWorkspace.getState().resumeThread(storedThread.id);

    const state = useCodexWorkspace.getState();
    assert.equal(state.status, 'external');
    assert.equal(state.error, null);
    assert.equal(state.activeThreadId, storedThread.id);
    assert.equal(state.activeTurnId, undefined);
    assert.equal(state.messages.at(-1)?.text, 'Codex App 已处理完成');
    assert.equal(unsubscribed, 1);
    assert.equal(stopped, 0);

    writerActive = false;
    await useCodexWorkspace.getState().resumeThread(storedThread.id);
    assert.equal(useCodexWorkspace.getState().status, 'external');
    assert.equal(unsubscribed, 1);
    assert.equal(stopped, 0);
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('从 Codex 刷新遇到外部写入者时同步最新内容并自动创建可写分支', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  const makeTurn = (turnId: string, text: string) => ({
    id: turnId,
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    items: [
      { type: 'userMessage', id: `${turnId}-user`, content: [{ type: 'text', text, text_elements: [] }] },
      { type: 'agentMessage', id: `${turnId}-agent`, text: `已处理：${text}`, phase: null },
    ],
  });
  const storedThread = { ...thread('thread-refresh'), name: '原任务' };
  const forkedThread = { ...thread('thread-refresh-fork'), name: '原任务 · RocketX 继续' };
  const originalTurn = makeTurn('turn-original', '原任务');
  const externalTurn = makeTurn('turn-external', '在 Codex App 中完成的任务');
  let controllerCount = 0;
  let stopped = 0;
  let unsubscribed = 0;
  let ownedByCodex = false;
  const resumedBy: number[] = [];
  const forkedBy: Array<{ instance: number; threadId: string; name?: string }> = [];
  const catalog = {
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
  const restoreFactory = setCodexWorkspaceControllerFactory(() => {
    const instance = ++controllerCount;
    return {
      connect: async () => catalog,
      listThreads: async () => [storedThread],
      resumeThread: async () => {
        resumedBy.push(instance);
        if (ownedByCodex) {
          throw new Error(`thread ${storedThread.id} already has an active writer`);
        }
        return storedThread;
      },
      forkThread: async (threadId: string, _selection: unknown, name?: string) => {
        forkedBy.push({ instance, threadId, name });
        return forkedThread;
      },
      unsubscribeThread: async () => { unsubscribed += 1; },
      readThread: async (threadId: string) => threadId === forkedThread.id
        ? { thread: forkedThread, turns: [originalTurn, externalTurn] }
        : {
            thread: storedThread,
            turns: instance === 1 ? [originalTurn] : [originalTurn, externalTurn],
          },
      stop: async () => { stopped += 1; },
    } as never;
  });

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('account-refresh');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    await useCodexWorkspace.getState().connect();
    await useCodexWorkspace.getState().resumeThread(storedThread.id);
    ownedByCodex = true;

    const addedWhileExternal = await useCodexWorkspace.getState().refreshFromCodex();

    assert.equal(addedWhileExternal, 1);
    assert.equal(controllerCount, 1);
    assert.equal(unsubscribed, 1);
    assert.equal(stopped, 0);
    assert.deepEqual(resumedBy, [1, 1]);
    assert.deepEqual(forkedBy, [{
      instance: 1,
      threadId: storedThread.id,
      name: '原任务 · RocketX 继续',
    }]);
    assert.equal(useCodexWorkspace.getState().status, 'ready');
    assert.equal(useCodexWorkspace.getState().error, null);
    assert.equal(useCodexWorkspace.getState().activeThreadId, forkedThread.id);
    assert.deepEqual(useCodexWorkspace.getState().turns.map((turn) => turn.id), [
      'turn-original',
      'turn-external',
    ]);
    assert.match(
      useCodexWorkspace.getState().messages.at(-1)?.text ?? '',
      /在 Codex App 中完成的任务/,
    );
    assert.deepEqual(useCodexWorkspace.getState().threads.map((item) => item.id), [
      forkedThread.id,
      storedThread.id,
    ]);

    useCodexWorkspace.setState((state) => ({
      status: 'running',
      activeTurnId: 'turn-running',
      threadStates: {
        ...state.threadStates,
        [forkedThread.id]: {
          ...state.threadStates[forkedThread.id]!,
          status: 'running',
          activeTurnId: 'turn-running',
        },
      },
    }));
    await assert.rejects(
      useCodexWorkspace.getState().refreshFromCodex(),
      /任务运行中，完成后再从 Codex 刷新/,
    );
    assert.equal(controllerCount, 1);
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
