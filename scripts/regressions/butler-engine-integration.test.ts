import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AgentLoopEvent } from '../../apps/web/src/kernel/ai/agent-loop';

async function repoImport<T = unknown>(relativePath: string): Promise<T> {
  return import(pathToFileURL(resolve(process.cwd(), relativePath)).href) as Promise<T>;
}

async function loadDeps() {
  const [butler, brain, auth, rcxStore] = await Promise.all([
    repoImport<typeof import('../../../../../../D:/Repos/rocketchatx/apps/web/src/stores/butler.ts')>('apps/web/src/stores/butler.ts'),
    repoImport<typeof import('../../../../../../D:/Repos/rocketchatx/apps/web/src/lib/butlerBrain.ts')>('apps/web/src/lib/butlerBrain.ts'),
    repoImport<typeof import('../../../../../../D:/Repos/rocketchatx/apps/web/src/stores/auth.ts')>('apps/web/src/stores/auth.ts'),
    repoImport<typeof import('../../../../../../D:/Repos/rocketchatx/packages/rcx-store/src/index.ts')>('packages/rcx-store/src/index.ts'),
  ]);
  return { butler, brain, auth, rcxStore };
}

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function normalizeSnapshot(state: Record<string, unknown>) {
  const lines = ((state.lines as Array<Record<string, unknown>>) ?? [])
    .filter((line) => line.text !== '我是你的管家。消息、待办、日程、工作项都可以直接问我。')
    .slice(-2)
    .map((line) => ({
    role: line.role,
    text: line.text,
    sources: ((line.sources as Array<Record<string, unknown>> | undefined) ?? []).map((source) => source.id),
  }));
  const steps = ((state.steps as Array<Record<string, unknown>>) ?? []).map((step) => ({
    label: step.label,
    status: step.status,
  }));
  const taskState = state.taskState as Record<string, unknown> | null;
  const engineState = state.engineState as Record<string, unknown>;
  return {
    lines,
    steps,
    taskState: taskState ? {
      status: taskState.status,
      sources: ((taskState.sources as Array<Record<string, unknown>> | undefined) ?? []).map((source) => source.id),
    } : null,
    engineState: {
      version: engineState.version,
      activeBrain: engineState.activeBrain,
      status: engineState.status,
      compatibility: engineState.compatibility,
    },
    running: state.running,
  };
}

function normalizeEngineState(value: unknown) {
  const state = value as Record<string, unknown>;
  return {
    version: state.version,
    activeBrain: state.activeBrain,
    status: state.status,
    compatibility: state.compatibility,
  };
}

async function setupButler() {
  const { butler, brain, auth, rcxStore } = await loadDeps();
  const restoreBrainStorage = brain.setButlerBrainStorage(new MemoryStorage() as never);
  const restorePlatform = brain.setButlerBrainTauriProvider(() => true);
  const backend = rcxStore.createRcxStore({ backend: rcxStore.createMemoryBackend() }).appData;
  const restorePersistence = butler.setButlerPersistence(backend);

  const cleanup = async () => {
    butler.useButler.getState().reset();
    butler.resetButlerPersistenceForTests();
    auth.useAuth.setState({ user: undefined as never });
    restorePersistence();
    restorePlatform();
    restoreBrainStorage();
  };

  return { butler, brain, auth, appData: backend, cleanup };
}

test('PR 比较场景显式加载完整 Azure DevOps Server Skill', { concurrency: false }, async () => {
  const { butler, brain, cleanup } = await setupButler();
  let capturedSkill: string | undefined;
  const restoreCodex = butler.setButlerCodexRunner(async (options) => {
    capturedSkill = options.skillName;
    return { text: '已按固定快照比较。' };
  });

  try {
    brain.setButlerBrain('codex');
    await butler.useButler.getState().ask('比较 PR #101 和 PR #102');
    assert.equal(capturedSkill, 'azure-devops-server');
  } finally {
    restoreCodex();
    await cleanup();
  }
});

test('API 与 Codex 成功回合映射为同构的公共终态合同', { concurrency: false }, async () => {
  const { butler, brain, cleanup } = await setupButler();
  const context = {
    kind: 'room' as const,
    label: '发布群',
    detail: '当前 Rocket.Chat 房间',
    sources: [{ kind: 'room' as const, id: 'r1', rid: 'r1', label: '发布群' }],
  };

  const runApi = butler.setButlerLoopRunner(async (options) => {
    options.onEvent?.({ type: 'tool-call', toolCall: { id: 'call-1', name: 'search_messages', arguments: '{}' } });
    options.onEvent?.({
      type: 'tool-result',
      toolCallId: 'call-1',
      content: JSON.stringify([{ _id: 'm1', rid: 'r1', roomName: '发布群', sender: '张三', text: '构建恢复了' }]),
    });
    return { text: '统一答复', messages: options.messages };
  });

  try {
    butler.useButler.getState().reset();
    brain.setButlerBrain('api');
    await butler.useButler.getState().ask('统一问题', context);
    const apiSnapshot = normalizeSnapshot(butler.useButler.getState() as never);

    runApi();
    const runCodex = butler.setButlerCodexRunner(async (options) => {
      options.onEvent?.({ type: 'tool-call', toolCall: { id: 'call-1', name: 'search_messages', arguments: '{}' } });
      options.onEvent?.({
        type: 'tool-result',
        toolCallId: 'call-1',
        content: JSON.stringify([{ _id: 'm1', rid: 'r1', roomName: '发布群', sender: '张三', text: '构建恢复了' }]),
      });
      return { text: '统一答复' };
    });

    try {
      butler.useButler.getState().reset();
      brain.setButlerBrain('codex');
      await butler.useButler.getState().ask('统一问题', context);
      const codexSnapshot = normalizeSnapshot(butler.useButler.getState() as never);

      assert.deepEqual(apiSnapshot, {
        lines: [
          { role: 'user', text: '统一问题', sources: [] },
          { role: 'assistant', text: '统一答复', sources: ['r1', 'm1'] },
        ],
        steps: [{ label: '搜索消息', status: 'done' }],
        taskState: { status: 'completed', sources: ['r1', 'm1'] },
        engineState: {
          version: 1,
          activeBrain: 'api',
          status: 'ready',
          compatibility: { mode: 'native', reason: null },
        },
        running: false,
      });

      assert.deepEqual(codexSnapshot, {
        lines: [
          { role: 'user', text: '统一问题', sources: [] },
          { role: 'assistant', text: '统一答复', sources: ['r1', 'm1'] },
        ],
        steps: [{ label: '搜索消息', status: 'done' }],
        taskState: { status: 'completed', sources: ['r1', 'm1'] },
        engineState: {
          version: 1,
          activeBrain: 'codex',
          status: 'ready',
          compatibility: { mode: 'native', reason: null },
        },
        running: false,
      });
    } finally {
      runCodex();
    }
  } finally {
    runApi();
    await cleanup();
  }
});

test('API 与 Codex 失败回合映射为同构的公共失败终态合同', { concurrency: false }, async () => {
  const { butler, brain, cleanup } = await setupButler();

  const runApi = butler.setButlerLoopRunner(async (options) => {
    options.onEvent?.({ type: 'tool-call', toolCall: { id: 'call-1', name: 'list_builds', arguments: '{}' } });
    options.onEvent?.({ type: 'tool-result', toolCallId: 'call-1', content: '工具执行失败：超时' });
    throw new Error('provider boom');
  });

  try {
    butler.useButler.getState().reset();
    brain.setButlerBrain('api');
    await butler.useButler.getState().ask('失败问题');
    const apiSnapshot = normalizeSnapshot(butler.useButler.getState() as never);

    runApi();
    const runCodex = butler.setButlerCodexRunner(async (options) => {
      options.onEvent?.({ type: 'tool-call', toolCall: { id: 'call-1', name: 'list_builds', arguments: '{}' } });
      options.onEvent?.({ type: 'tool-result', toolCallId: 'call-1', content: '工具执行失败：超时' });
      throw new Error('provider boom');
    });

    try {
      butler.useButler.getState().reset();
      brain.setButlerBrain('codex');
      await butler.useButler.getState().ask('失败问题');
      const codexSnapshot = normalizeSnapshot(butler.useButler.getState() as never);

      assert.deepEqual(apiSnapshot, {
        lines: [{ role: 'user', text: '失败问题', sources: [] }],
        steps: [{ label: '查询构建', status: 'failed' }],
        taskState: { status: 'failed', sources: [] },
        engineState: {
          version: 1,
          activeBrain: 'api',
          status: 'failed',
          compatibility: { mode: 'incompatible', reason: 'turn-failed' },
        },
        running: false,
      });

      assert.deepEqual(codexSnapshot, {
        lines: [{ role: 'user', text: '失败问题', sources: [] }],
        steps: [{ label: '查询构建', status: 'failed' }],
        taskState: { status: 'failed', sources: [] },
        engineState: {
          version: 1,
          activeBrain: 'codex',
          status: 'failed',
          compatibility: { mode: 'incompatible', reason: 'turn-failed' },
        },
        running: false,
      });
    } finally {
      runCodex();
    }
  } finally {
    runApi();
    await cleanup();
  }
});

test('API 切到 Codex 时会桥接未见 transcript 且不丢 taskState', { concurrency: false }, async () => {
  const { butler, brain, cleanup } = await setupButler();
  let capturedCodexOptions: Record<string, unknown> | undefined;
  let compatibilityWhileRunning: unknown;
  const restoreApi = butler.setButlerLoopRunner(async (options) => ({
    text: 'API 第一答',
    messages: options.messages,
  }));
  const restoreCodex = butler.setButlerCodexRunner(async (options) => {
    capturedCodexOptions = options as Record<string, unknown>;
    compatibilityWhileRunning = (butler.useButler.getState() as Record<string, unknown>).engineState;
    return { text: 'Codex 第二答' };
  });

  try {
    butler.useButler.getState().reset();
    brain.setButlerBrain('api');
    await butler.useButler.getState().ask('API 第一问');
    brain.setButlerBrain('codex');
    await butler.useButler.getState().ask('Codex 第二问');

    assert.deepEqual(capturedCodexOptions?.bridgeTranscript, [
      { role: 'user', text: 'API 第一问', revision: 1 },
      { role: 'assistant', text: 'API 第一答', revision: 2 },
    ]);
    assert.deepEqual((compatibilityWhileRunning as Record<string, unknown>).compatibility, {
      mode: 'transcript',
      reason: 'brain-switched',
    });
    const taskState = capturedCodexOptions?.taskState as Record<string, unknown>;
    assert.equal(taskState.status, 'running');
    assert.equal(taskState.goal, 'Codex 第二问');
    assert.equal((butler.useButler.getState() as Record<string, unknown>).taskState != null, true);
  } finally {
    restoreCodex();
    restoreApi();
    await cleanup();
  }
});

test('Codex 切到 API 时会桥接未见 transcript 且不丢 taskState', { concurrency: false }, async () => {
  const { butler, brain, cleanup } = await setupButler();
  let capturedApiMessages: Array<Record<string, unknown>> | undefined;
  const restoreCodex = butler.setButlerCodexRunner(async () => ({ text: 'Codex 第一答' }));
  const restoreApi = butler.setButlerLoopRunner(async (options) => {
    capturedApiMessages = options.messages as Array<Record<string, unknown>>;
    return { text: 'API 第二答', messages: options.messages };
  });

  try {
    butler.useButler.getState().reset();
    brain.setButlerBrain('codex');
    await butler.useButler.getState().ask('Codex 第一问');
    brain.setButlerBrain('api');
    await butler.useButler.getState().ask('API 第二问');

    assert.deepEqual(
      capturedApiMessages?.slice(1).map((message) => ({ role: message.role, content: message.content })),
      [
        { role: 'user', content: 'Codex 第一问' },
        { role: 'assistant', content: 'Codex 第一答' },
        { role: 'user', content: 'API 第二问' },
      ],
    );
    const taskState = (butler.useButler.getState() as Record<string, unknown>).taskState as Record<string, unknown>;
    assert.equal(taskState.status, 'completed');
    assert.equal(taskState.goal, 'API 第二问');
  } finally {
    restoreApi();
    restoreCodex();
    await cleanup();
  }
});

test('七类 baseline 在 API 与 Codex 下产生同构证据、步骤和错误状态', { concurrency: false }, async () => {
  const { butler, brain, cleanup } = await setupButler();
  const context = {
    kind: 'room' as const,
    label: '基线房间',
    detail: '双引擎基线',
    sources: [{ kind: 'room' as const, id: 'baseline-room', rid: 'baseline-room', label: '基线房间' }],
  };
  const scenarios = [
    { input: '找昨天老李发的文件', tool: 'search_messages', result: [{ _id: 'm1', rid: 'baseline-room', text: '文件' }] },
    { input: '比较 PR #101 和 PR #102', tool: 'list_pull_requests', result: [{ id: 101, title: 'PR' }] },
    { input: '从研发群提取承诺', tool: 'search_messages', result: [{ _id: 'm3', rid: 'baseline-room', text: '承诺' }] },
    { input: '为逾期工作项生成跟进草稿', tool: 'list_work_items', result: [{ id: 4, title: '逾期项' }] },
    { input: '关联构建 #500 的失败提交', tool: 'list_builds', result: [{ id: 500, buildNumber: '500' }] },
    { input: '创建周五 18:30 的周报例行任务', tool: 'load_skill', result: [] },
    { input: '继续上次任务调查', tool: 'search_messages', result: [{ _id: 'm7', rid: 'baseline-room', text: '恢复' }], seed: true },
  ];

  async function runScenario(
    targetBrain: 'api' | 'codex',
    scenario: (typeof scenarios)[number],
    fail: boolean,
  ) {
    butler.useButler.getState().reset();
    brain.setButlerBrain(targetBrain);
    let currentFailure = false;
    const emit = (options: { onEvent?: (event: AgentLoopEvent) => void }) => {
      options.onEvent?.({
        type: 'tool-call',
        toolCall: { id: 'baseline-call', name: scenario.tool, arguments: '{}' },
      });
      options.onEvent?.({
        type: 'tool-result',
        toolCallId: 'baseline-call',
        content: currentFailure ? '工具执行失败：基线故障' : JSON.stringify(scenario.result),
      });
      if (currentFailure) throw new Error('baseline failure');
    };
    const restoreApi = butler.setButlerLoopRunner(async (options) => {
      emit(options);
      return { text: '基线答复', messages: options.messages };
    });
    const restoreCodex = butler.setButlerCodexRunner(async (options) => {
      emit(options);
      return { text: '基线答复' };
    });
    try {
      if (scenario.seed) await butler.useButler.getState().ask('准备恢复的调查', context);
      currentFailure = fail;
      await butler.useButler.getState().ask(scenario.input, context);
      return normalizeSnapshot(butler.useButler.getState() as never);
    } finally {
      restoreCodex();
      restoreApi();
    }
  }

  try {
    for (const [index, scenario] of scenarios.entries()) {
      const fail = index % 2 === 1;
      const api = await runScenario('api', scenario, fail);
      const codex = await runScenario('codex', scenario, fail);
      assert.equal((api.engineState as Record<string, unknown>).activeBrain, 'api');
      assert.equal((codex.engineState as Record<string, unknown>).activeBrain, 'codex');
      assert.deepEqual(
        { ...api, engineState: { ...api.engineState, activeBrain: 'engine' } },
        { ...codex, engineState: { ...codex.engineState, activeBrain: 'engine' } },
        scenario.input,
      );
    }
  } finally {
    await cleanup();
  }
});

test('Codex 切到 API 后首次失败，重试不会重复桥接 transcript', { concurrency: false }, async () => {
  const { butler, brain, cleanup } = await setupButler();
  const restoreCodex = butler.setButlerCodexRunner(async () => ({ text: 'Codex 第一答' }));
  let apiCall = 0;
  let retryMessages: Array<Record<string, unknown>> = [];
  const restoreApi = butler.setButlerLoopRunner(async (options) => {
    apiCall += 1;
    if (apiCall === 1) throw new Error('首次 API 失败');
    retryMessages = options.messages as Array<Record<string, unknown>>;
    return { text: 'API 重试答复', messages: options.messages };
  });

  try {
    brain.setButlerBrain('codex');
    await butler.useButler.getState().ask('Codex 第一问');
    brain.setButlerBrain('api');
    await butler.useButler.getState().ask('API 失败问');
    await butler.useButler.getState().ask('API 重试问');

    assert.deepEqual(retryMessages.slice(1).map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Codex 第一问' },
      { role: 'assistant', content: 'Codex 第一答' },
      { role: 'user', content: 'API 失败问' },
      { role: 'user', content: 'API 重试问' },
    ]);
  } finally {
    restoreApi();
    restoreCodex();
    await cleanup();
  }
});

test('Codex 切到 API 后首次停止，重试不会重复桥接 transcript', { concurrency: false }, async () => {
  const { butler, brain, cleanup } = await setupButler();
  const restoreCodex = butler.setButlerCodexRunner(async () => ({ text: 'Codex 第一答' }));
  let apiCall = 0;
  let retryMessages: Array<Record<string, unknown>> = [];
  const restoreApi = butler.setButlerLoopRunner(async (options) => {
    apiCall += 1;
    if (apiCall === 1) {
      return new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    }
    retryMessages = options.messages as Array<Record<string, unknown>>;
    return { text: 'API 重试答复', messages: options.messages };
  });

  try {
    brain.setButlerBrain('codex');
    await butler.useButler.getState().ask('Codex 第一问');
    brain.setButlerBrain('api');
    const asking = butler.useButler.getState().ask('API 停止问');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await butler.useButler.getState().stop();
    await asking;
    await butler.useButler.getState().ask('API 重试问');

    assert.deepEqual(retryMessages.slice(1).map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Codex 第一问' },
      { role: 'assistant', content: 'Codex 第一答' },
      { role: 'user', content: 'API 停止问' },
      { role: 'user', content: 'API 重试问' },
    ]);
  } finally {
    brain.setButlerBrain('api');
    await butler.useButler.getState().stop();
    restoreApi();
    restoreCodex();
    await cleanup();
  }
});

test('活跃 API turn 中切换到 Codex 后 stop 仍停止实际运行脑', { concurrency: false }, async () => {
  const { butler, brain, cleanup } = await setupButler();
  let stopped = false;
  const restoreApi = butler.setButlerLoopRunner(async (options) => {
    await new Promise<void>((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        stopped = true;
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error('stopped'));
      });
    });
    return { text: '', messages: options.messages };
  });

  try {
    butler.useButler.getState().reset();
    brain.setButlerBrain('api');
    const asking = butler.useButler.getState().ask('长任务');
    await new Promise((resolve) => setTimeout(resolve, 10));
    brain.setButlerBrain('codex');
    await butler.useButler.getState().stop();

    await Promise.race([
      asking,
      new Promise((_, reject) => setTimeout(() => reject(new Error('stop did not reach the running api turn')), 80)),
    ]);

    assert.equal(stopped, true);
    assert.equal(butler.useButler.getState().running, false);
  } finally {
    brain.setButlerBrain('api');
    await butler.useButler.getState().stop();
    restoreApi();
    await cleanup();
  }
});

test('engineState 会随 session 持久化并在 hydrate 后恢复', { concurrency: false }, async () => {
  const { butler, brain, auth, appData, cleanup } = await setupButler();
  const restoreApi = butler.setButlerLoopRunner(async (options) => ({
    text: '持久化回复',
    messages: options.messages,
  }));

  try {
    auth.useAuth.setState({ user: { _id: 'engine-user', username: 'engine-user' } as never });
    butler.useButler.getState().reset();
    await butler.useButler.getState().hydrate();
    brain.setButlerBrain('api');
    await butler.useButler.getState().ask('持久化问题');
    await butler.flushButlerPersist();

    const saved = await appData.get<Record<string, unknown>>(
      'builtin:butler',
      'session-registry:same-origin:engine-user',
    );
    const sessions = saved?.sessions as Array<Record<string, unknown>>;
    const savedEngineState = sessions[0].engineState as Record<string, unknown>;
    assert.deepEqual(normalizeEngineState(savedEngineState), {
      version: 1,
      activeBrain: 'api',
      status: 'ready',
      compatibility: { mode: 'native', reason: null },
    });
    assert.equal(savedEngineState.transcriptRevision, 2);
    assert.deepEqual(savedEngineState.resumeRevisionByBrain, { api: 2, codex: 0 });
    const legacy = await appData.get<Record<string, unknown>>('builtin:butler', 'same-origin:engine-user');
    assert.equal('engineState' in (legacy ?? {}), false);

    butler.resetButlerPersistenceForTests();
    butler.useButler.getState().reset();
    await butler.useButler.getState().hydrate();
    assert.deepEqual(normalizeEngineState((butler.useButler.getState() as Record<string, unknown>).engineState), {
      version: 1,
      activeBrain: 'api',
      status: 'ready',
      compatibility: { mode: 'native', reason: null },
    });
  } finally {
    restoreApi();
    await cleanup();
  }
});

test('每个 session 独立恢复自己的 engine brain 与 transcript revision', { concurrency: false }, async () => {
  const { butler, brain, auth, cleanup } = await setupButler();
  const restoreApi = butler.setButlerLoopRunner(async (options) => ({ text: 'API 答复', messages: options.messages }));
  const restoreCodex = butler.setButlerCodexRunner(async () => ({ text: 'Codex 答复' }));

  try {
    auth.useAuth.setState({ user: { _id: 'multi-engine-user', username: 'multi-engine-user' } as never });
    brain.setButlerBrain('api');
    await butler.useButler.getState().hydrate();
    await butler.useButler.getState().ask('API 会话问题');
    const apiSessionId = butler.useButler.getState().activeSessionId;

    await butler.useButler.getState().newConversation();
    const codexSessionId = butler.useButler.getState().activeSessionId;
    brain.setButlerBrain('codex');
    await butler.useButler.getState().ask('Codex 会话问题');

    await butler.useButler.getState().switchSession(apiSessionId);
    let engineState = (butler.useButler.getState() as Record<string, unknown>).engineState as Record<string, unknown>;
    assert.equal(engineState.activeBrain, 'api');
    assert.equal(engineState.transcriptRevision, 2);

    await butler.useButler.getState().switchSession(codexSessionId);
    engineState = (butler.useButler.getState() as Record<string, unknown>).engineState as Record<string, unknown>;
    assert.equal(engineState.activeBrain, 'codex');
    assert.equal(engineState.transcriptRevision, 2);
  } finally {
    restoreCodex();
    restoreApi();
    await cleanup();
  }
});

test('本地 transcript 更新不会掩盖既有 incompatible 状态', { concurrency: false }, async () => {
  const { butler, cleanup } = await setupButler();
  try {
    butler.useButler.setState({
      engineState: {
        version: 1,
        activeBrain: 'api',
        status: 'failed',
        transcriptRevision: 0,
        resumeRevisionByBrain: { api: 0, codex: 0 },
        compatibility: { mode: 'incompatible', reason: 'transcript-gap' },
      },
    });
    butler.appendButlerLine('assistant', '本地补充');
    const engineState = (butler.useButler.getState() as Record<string, unknown>).engineState as Record<string, unknown>;
    assert.deepEqual(engineState.compatibility, { mode: 'incompatible', reason: 'transcript-gap' });
    assert.equal(engineState.transcriptRevision, 1);
  } finally {
    await cleanup();
  }
});

test('重启恢复未完成回合时 engine 与 task state 一起转为 paused', { concurrency: false }, async () => {
  const { butler, auth, appData, cleanup } = await setupButler();
  try {
    auth.useAuth.setState({ user: { _id: 'interrupted-user', username: 'interrupted-user' } as never });
    const now = Date.now();
    await appData.set('builtin:butler', 'session-registry:same-origin:interrupted-user', {
      schemaVersion: 1,
      activeSessionId: 'default',
      sessions: [{
        id: 'default',
        title: '默认对话',
        createdAt: now,
        updatedAt: now,
        lines: [{ id: 'u1', role: 'user', text: '中断的问题' }],
        history: [{ role: 'user', content: '中断的问题' }],
        taskState: {
          id: 'task-1',
          goal: '中断的问题',
          status: 'running',
          createdAt: now,
          updatedAt: now,
          manifest: {
            schemaVersion: 1,
            scenario: 'general',
            capabilityPreflight: { available: [], missing: [] },
            sourcePlan: [],
            clarification: { required: false, missing: [] },
            prohibitedActions: [],
            recovery: '恢复后继续',
          },
          sources: [],
        },
        engineState: {
          version: 1,
          activeBrain: 'api',
          status: 'running',
          transcriptRevision: 1,
          resumeRevisionByBrain: { api: 0, codex: 0 },
          compatibility: { mode: 'native', reason: null },
        },
      }],
    });

    await butler.useButler.getState().hydrate();
    assert.equal((butler.useButler.getState() as Record<string, unknown>).engineState != null, true);
    assert.equal(((butler.useButler.getState() as Record<string, unknown>).engineState as Record<string, unknown>).status, 'paused');
    assert.equal(((butler.useButler.getState() as Record<string, unknown>).taskState as Record<string, unknown>).status, 'paused');
  } finally {
    await cleanup();
  }
});

test('旧 registry 缺失 engineState 字段时仍兼容初始化恢复', { concurrency: false }, async () => {
  const { butler, auth, appData, cleanup } = await setupButler();

  try {
    auth.useAuth.setState({ user: { _id: 'legacy-user', username: 'legacy-user' } as never });
    await appData.set('builtin:butler', 'same-origin:legacy-user', {
      lines: [
        { id: 'u1', role: 'user', text: '旧问题' },
        { id: 'a1', role: 'assistant', text: '旧回答' },
      ],
      history: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' },
      ],
      lastAt: Date.now(),
    });

    butler.useButler.getState().reset();
    await butler.useButler.getState().hydrate();

    const engineState = (butler.useButler.getState() as Record<string, unknown>).engineState as Record<string, unknown>;
    assert.deepEqual(normalizeEngineState(engineState), {
      version: 1,
      activeBrain: 'api',
      status: 'ready',
      compatibility: { mode: 'native', reason: null },
    });
    assert.equal(engineState.transcriptRevision, 2);
    assert.deepEqual(engineState.resumeRevisionByBrain, { api: 2, codex: 0 });
  } finally {
    await cleanup();
  }
});
