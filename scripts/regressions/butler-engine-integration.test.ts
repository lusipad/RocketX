import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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

  return { butler, auth, appData: backend, cleanup };
}

test('自然语言 PR 比较交给 Codex 原生 Skill 发现，不由前端强制指定', { concurrency: false }, async () => {
  const { butler, cleanup } = await setupButler();
  let capturedSkill: string | undefined;
  const restoreCodex = butler.setButlerCodexRunner(async (options) => {
    capturedSkill = options.skillName;
    return { text: '已按固定快照比较。' };
  });

  try {
    await butler.useButler.getState().ask('比较 PR #101 和 PR #102');
    assert.equal(capturedSkill, undefined);
  } finally {
    restoreCodex();
    await cleanup();
  }
});

test('成功回合映射为公共终态合同：证据、步骤、任务状态、engine state', { concurrency: false }, async () => {
  const { butler, cleanup } = await setupButler();
  const context = {
    kind: 'room' as const,
    label: '发布群',
    detail: '当前 Rocket.Chat 房间',
    sources: [{ kind: 'room' as const, id: 'r1', rid: 'r1', label: '发布群' }],
  };
  const restoreCodex = butler.setButlerCodexRunner(async (options) => {
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
    await butler.useButler.getState().ask('统一问题', context);

    assert.deepEqual(normalizeSnapshot(butler.useButler.getState() as never), {
      lines: [
        { role: 'user', text: '统一问题', sources: ['r1'] },
        { role: 'assistant', text: '统一答复', sources: ['r1', 'm1'] },
      ],
      steps: [{ label: '搜索消息', status: 'done' }],
      taskState: { status: 'completed', sources: ['r1', 'm1'] },
      engineState: {
        version: 2,
        status: 'ready',
        compatibility: { mode: 'native', reason: null },
      },
      running: false,
    });
  } finally {
    restoreCodex();
    await cleanup();
  }
});

test('失败回合映射为公共失败终态合同，不静默丢上下文', { concurrency: false }, async () => {
  const { butler, cleanup } = await setupButler();
  const restoreCodex = butler.setButlerCodexRunner(async (options) => {
    options.onEvent?.({ type: 'tool-call', toolCall: { id: 'call-1', name: 'rocketx_azure_devops_server_read', arguments: '{}' } });
    options.onEvent?.({ type: 'tool-result', toolCallId: 'call-1', content: '工具执行失败：超时' });
    throw new Error('provider boom');
  });

  try {
    butler.useButler.getState().reset();
    await butler.useButler.getState().ask('失败问题');

    assert.deepEqual(normalizeSnapshot(butler.useButler.getState() as never), {
      lines: [{ role: 'user', text: '失败问题', sources: [] }],
      steps: [{ label: '查询 Azure DevOps', status: 'failed' }],
      taskState: { status: 'failed', sources: [] },
      engineState: {
        version: 2,
        status: 'failed',
        compatibility: { mode: 'incompatible', reason: 'turn-failed' },
      },
      running: false,
    });
  } finally {
    restoreCodex();
    await cleanup();
  }
});

test('本地补充的 transcript 行会在下一回合桥接给引擎，不重复已喂内容', { concurrency: false }, async () => {
  const { butler, cleanup } = await setupButler();
  let capturedBridge: unknown;
  let compatibilityWhileRunning: unknown;
  const restoreCodex = butler.setButlerCodexRunner(async (options) => {
    capturedBridge = options.bridgeTranscript;
    compatibilityWhileRunning = ((butler.useButler.getState() as Record<string, unknown>).engineState as Record<string, unknown>).compatibility;
    return { text: '第二答' };
  });

  try {
    butler.useButler.getState().reset();
    await butler.useButler.getState().ask('第一问');
    // 结论卡等本地动作会直接往 transcript 里补行，引擎没见过这些行
    butler.appendButlerLine('assistant', '本地补充');
    await butler.useButler.getState().ask('第二问');

    assert.deepEqual(capturedBridge, [
      { revision: 3, role: 'assistant', text: '本地补充' },
    ]);
    assert.deepEqual(compatibilityWhileRunning, { mode: 'transcript', reason: 'transcript-behind' });
  } finally {
    restoreCodex();
    await cleanup();
  }
});

test('engineState 会随 session 持久化并在 hydrate 后恢复', { concurrency: false }, async () => {
  const { butler, auth, appData, cleanup } = await setupButler();
  const restoreCodex = butler.setButlerCodexRunner(async () => ({ text: '持久化回复' }));

  try {
    auth.useAuth.setState({ user: { _id: 'engine-user', username: 'engine-user' } as never });
    butler.useButler.getState().reset();
    await butler.useButler.getState().hydrate();
    await butler.useButler.getState().ask('持久化问题');
    await butler.flushButlerPersist();

    const saved = await appData.get<Record<string, unknown>>(
      'builtin:butler',
      'session-registry:same-origin:engine-user',
    );
    const sessions = saved?.sessions as Array<Record<string, unknown>>;
    const savedEngineState = sessions[0].engineState as Record<string, unknown>;
    assert.deepEqual(normalizeEngineState(savedEngineState), {
      version: 2,
      status: 'ready',
      compatibility: { mode: 'native', reason: null },
    });
    assert.equal(savedEngineState.transcriptRevision, 2);
    assert.equal(savedEngineState.resumeRevision, 2);
    const legacy = await appData.get<Record<string, unknown>>('builtin:butler', 'same-origin:engine-user');
    assert.equal('engineState' in (legacy ?? {}), false);

    butler.resetButlerPersistenceForTests();
    butler.useButler.getState().reset();
    await butler.useButler.getState().hydrate();
    assert.deepEqual(normalizeEngineState((butler.useButler.getState() as Record<string, unknown>).engineState), {
      version: 2,
      status: 'ready',
      compatibility: { mode: 'native', reason: null },
    });
  } finally {
    restoreCodex();
    await cleanup();
  }
});

test('每个 session 独立恢复自己的 transcript revision', { concurrency: false }, async () => {
  const { butler, auth, cleanup } = await setupButler();
  const restoreCodex = butler.setButlerCodexRunner(async () => ({ text: '答复' }));

  try {
    auth.useAuth.setState({ user: { _id: 'multi-session-user', username: 'multi-session-user' } as never });
    await butler.useButler.getState().hydrate();
    await butler.useButler.getState().ask('第一个会话问题');
    const firstSessionId = butler.useButler.getState().activeSessionId;

    await butler.useButler.getState().newConversation();
    const secondSessionId = butler.useButler.getState().activeSessionId;
    await butler.useButler.getState().ask('第二个会话问题');

    await butler.useButler.getState().switchSession(firstSessionId);
    let engineState = (butler.useButler.getState() as Record<string, unknown>).engineState as Record<string, unknown>;
    assert.equal(engineState.version, 2);
    assert.equal(engineState.transcriptRevision, 2);

    await butler.useButler.getState().switchSession(secondSessionId);
    engineState = (butler.useButler.getState() as Record<string, unknown>).engineState as Record<string, unknown>;
    assert.equal(engineState.version, 2);
    assert.equal(engineState.transcriptRevision, 2);
  } finally {
    restoreCodex();
    await cleanup();
  }
});

test('本地 transcript 更新不会掩盖既有 incompatible 状态', { concurrency: false }, async () => {
  const { butler, cleanup } = await setupButler();
  try {
    butler.useButler.setState({
      engineState: {
        version: 2,
        status: 'failed',
        transcriptRevision: 0,
        resumeRevision: 0,
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
        history: [],
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
          version: 2,
          status: 'running',
          transcriptRevision: 1,
          resumeRevision: 0,
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

test('双大脑时代的 version 1 engineState 被拒绝并回退冷启动，不崩不丢对话', { concurrency: false }, async () => {
  const { butler, auth, appData, cleanup } = await setupButler();
  try {
    auth.useAuth.setState({ user: { _id: 'v1-user', username: 'v1-user' } as never });
    const now = Date.now();
    await appData.set('builtin:butler', 'session-registry:same-origin:v1-user', {
      schemaVersion: 1,
      activeSessionId: 'default',
      sessions: [{
        id: 'default',
        title: '默认对话',
        createdAt: now,
        updatedAt: now,
        lines: [
          { id: 'u1', role: 'user', text: '旧问题' },
          { id: 'a1', role: 'assistant', text: '旧回答' },
        ],
        history: [],
        taskState: null,
        engineState: {
          version: 1,
          activeBrain: 'api',
          status: 'ready',
          transcriptRevision: 2,
          resumeRevisionByBrain: { api: 2, codex: 0 },
          compatibility: { mode: 'native', reason: null },
        },
      }],
    });

    await butler.useButler.getState().hydrate();
    const state = butler.useButler.getState() as Record<string, unknown>;
    const engineState = state.engineState as Record<string, unknown>;
    assert.deepEqual(normalizeEngineState(engineState), {
      version: 2,
      status: 'ready',
      compatibility: { mode: 'native', reason: null },
    });
    // 没有 codexThread：从 0 起步，整段旧对话会作为 bridge 喂给新线程
    assert.equal(engineState.resumeRevision, 0);
    assert.equal(engineState.transcriptRevision, 2);
    const lines = state.lines as Array<Record<string, unknown>>;
    assert.equal(lines.some((line) => line.text === '旧回答'), true);
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
      version: 2,
      status: 'ready',
      compatibility: { mode: 'native', reason: null },
    });
    assert.equal(engineState.transcriptRevision, 2);
    assert.equal(engineState.resumeRevision, 0);
  } finally {
    await cleanup();
  }
});
