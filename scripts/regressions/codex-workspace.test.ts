import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppServerControllerOptions } from '../../apps/web/src/agent/AppServerController';
import {
  resetCodexWorkspaceForTests,
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

function thread(id: string) {
  return {
    id,
    name: null,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 1,
    createdAt: 1,
    turns: [],
  };
}

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
    useCodexWorkspace.setState({
      messages: [{ id: 'secret', role: 'user', text: '敏感任务正文' }],
      events: [{ id: 'event', type: 'reasoning', title: '敏感过程', status: 'completed' }],
    });
    useCodexWorkspace.getState().setFollowUpMode('steer');

    const saved = values.get('rcx-codex-workspace-v1:account-persist');
    assert.ok(saved);
    assert.deepEqual(JSON.parse(saved), {
      workspaceRoot: 'D:/workspace',
      selectedEffort: null,
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

test('从 Codex 刷新会硬重连并恢复同一线程，只统计新增 Turn', async () => {
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
  const storedThread = thread('thread-refresh');
  const originalTurn = makeTurn('turn-original', '原任务');
  const externalTurn = makeTurn('turn-external', '在 Codex App 中完成的任务');
  let controllerCount = 0;
  let stopped = 0;
  const resumedBy: number[] = [];
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
        return storedThread;
      },
      readThread: async () => ({
        thread: storedThread,
        turns: instance === 1 ? [originalTurn] : [originalTurn, externalTurn],
      }),
      stop: async () => { stopped += 1; },
    } as never;
  });

  try {
    await resetCodexWorkspaceForTests();
    useCodexWorkspace.getState().hydrate('account-refresh');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:/workspace');
    await useCodexWorkspace.getState().connect();
    await useCodexWorkspace.getState().resumeThread(storedThread.id);

    const added = await useCodexWorkspace.getState().refreshFromCodex();

    assert.equal(added, 1);
    assert.equal(controllerCount, 2);
    assert.equal(stopped, 1);
    assert.deepEqual(resumedBy, [1, 2]);
    assert.equal(useCodexWorkspace.getState().activeThreadId, storedThread.id);
    assert.deepEqual(useCodexWorkspace.getState().turns.map((turn) => turn.id), [
      'turn-original',
      'turn-external',
    ]);
    assert.match(
      useCodexWorkspace.getState().messages.at(-1)?.text ?? '',
      /在 Codex App 中完成的任务/,
    );

    useCodexWorkspace.setState({ status: 'running', activeTurnId: 'turn-running' });
    await assert.rejects(
      useCodexWorkspace.getState().refreshFromCodex(),
      /任务运行中，完成后再从 Codex 刷新/,
    );
    assert.equal(controllerCount, 2);
  } finally {
    restoreFactory();
    await resetCodexWorkspaceForTests();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
