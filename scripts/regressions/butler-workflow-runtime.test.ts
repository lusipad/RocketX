import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import type { ButlerSource, ButlerSurfaceContext } from '../../apps/web/src/lib/butlerContext';
import type { ButlerEngineState } from '../../apps/web/src/lib/butlerEngineContract';
import type { ButlerTaskState, ButlerWorkflowKind } from '../../apps/web/src/lib/butlerTaskContext';
import { createButlerTools } from '../../apps/web/src/lib/butlerTools';
import {
  formatButlerToolResult,
  type ButlerToolCheckpoint,
  type ButlerToolRuntimeContext,
} from '../../apps/web/src/lib/butlerToolRuntime';
import { getServerBase, setServerBase } from '../../apps/web/src/lib/client';
import { useAuth } from '../../apps/web/src/stores/auth';
import * as butlerStore from '../../apps/web/src/stores/butler';

const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
const restorePersistence = butlerStore.setButlerPersistence(appData);
const restoreAuditWriter = butlerStore.setButlerToolAuditWriter(async () => undefined);
const initialServerBase = getServerBase();
const initialLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const localStorageEntries = new Map<string, string>();

const localStorageShim = {
  getItem(key: string) {
    return localStorageEntries.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    localStorageEntries.set(key, String(value));
  },
  removeItem(key: string) {
    localStorageEntries.delete(key);
  },
};

interface WorkflowTaskExecuteInput {
  taskState: ButlerTaskState;
  toolRuntimeContext: (callId: string) => ButlerToolRuntimeContext;
}

interface WorkflowTaskExecuteResult {
  value: string;
  summary?: string;
  sources?: readonly ButlerSource[];
}

interface WorkflowSnapshot {
  key: string;
  kind: ButlerWorkflowKind;
  hidden: boolean;
  sessionId: string;
  attempts: number;
  taskState: ButlerTaskState;
  engineState: ButlerEngineState;
  sources: readonly ButlerSource[];
  workflowRuntimeCheckpoints: ButlerToolCheckpoint[];
}

interface WorkflowStoreContract extends typeof butlerStore {
  runButlerWorkflowTask(input: {
    key: string;
    kind: ButlerWorkflowKind;
    goal: string;
    triggerReason?: string;
    context?: ButlerSurfaceContext;
    execute: (input: WorkflowTaskExecuteInput) => Promise<WorkflowTaskExecuteResult> | WorkflowTaskExecuteResult;
  }): Promise<WorkflowTaskExecuteResult>;
  pauseButlerWorkflowTask(key: string, reason?: string): Promise<void>;
  listButlerWorkflowSnapshots(): WorkflowSnapshot[];
}

const workflowStore = butlerStore as WorkflowStoreContract;

function ensureLocalStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: localStorageShim,
  });
}

ensureLocalStorage();

function login(userId: string): void {
  useAuth.setState({ user: { _id: userId, username: `user-${userId}` } as never });
}

function workflowContext(overrides: Partial<ButlerSurfaceContext> = {}): ButlerSurfaceContext {
  const sources: ButlerSource[] = [
    { kind: 'room', id: 'room-release', rid: 'room-release', label: '发布群' },
    { kind: 'work-item', id: 'wi-177', project: 'rocketx', label: '#177' },
  ];
  return {
    kind: 'room',
    label: '发布群',
    detail: 'Butler workflow 测试上下文',
    sources,
    ...overrides,
  };
}

function workflowSnapshot(key: string): WorkflowSnapshot {
  const snapshot = workflowStore.listButlerWorkflowSnapshots().find((item) => item.key === key);
  assert.ok(snapshot, `缺少 workflow snapshot ${key}`);
  return snapshot;
}

function rememberTool() {
  const tool = createButlerTools().find((item) => item.name === 'remember');
  assert.ok(tool, '缺少 remember 工具');
  return tool;
}

function resetGlobalState(): void {
  butlerStore.resetButlerPersistenceForTests();
  workflowStore.useButler.getState().reset();
  useAuth.setState({ user: undefined } as never);
  localStorageEntries.clear();
  ensureLocalStorage();
  setServerBase(initialServerBase);
}

test.after(() => restorePersistence());
test.after(() => restoreAuditWriter());
test.after(() => {
  if (initialLocalStorage) Object.defineProperty(globalThis, 'localStorage', initialLocalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});
test.afterEach(() => resetGlobalState());

test('workflow session 复用 Butler 持久化 registry，但不会出现在 interactive sessions picker，完成态可跨重启恢复', async () => {
  setServerBase('https://chat.example');
  login('workflow-shared-user');
  const restoreRunner = butlerStore.setButlerLoopRunner(async (options) => ({
    text: '交互会话回复',
    messages: options.messages,
  }));

  try {
    await workflowStore.useButler.getState().hydrate();
    await workflowStore.useButler.getState().ask('用户侧交互会话');
    await workflowStore.runButlerWorkflowTask({
      key: 'workflow-shared',
      kind: 'workflow',
      goal: '整理发布调查结论',
      context: workflowContext(),
      execute: ({ taskState }) => {
        assert.ok(taskState.id);
        return {
          value: 'workflow 完成',
          summary: '已生成发布调查摘要',
          sources: workflowContext().sources,
        };
      },
    });
    await butlerStore.flushButlerPersist();

    const registry = await appData.get<{ sessions: Array<{ id: string }> }>(
      'builtin:butler',
      'session-registry:https://chat.example:workflow-shared-user',
    );
    assert.ok(registry);
    const snapshot = workflowSnapshot('workflow-shared');
    assert.equal(snapshot.hidden, true);
    assert.equal(snapshot.taskState.status, 'completed');
    assert.equal(snapshot.engineState.status, 'ready');
    assert.deepEqual(snapshot.sources, workflowContext().sources);
    assert.equal(registry.sessions.some((session) => session.id === snapshot.sessionId), true);
    assert.equal(workflowStore.useButler.getState().sessions.some((session) => session.id === snapshot.sessionId), false);

    butlerStore.resetButlerPersistenceForTests();
    workflowStore.useButler.getState().reset();
    await workflowStore.useButler.getState().hydrate();

    const restored = workflowSnapshot('workflow-shared');
    assert.equal(restored.taskState.status, 'completed');
    assert.equal(restored.engineState.status, 'ready');
    assert.deepEqual(restored.sources, workflowContext().sources);
    assert.equal(workflowStore.useButler.getState().sessions.some((session) => session.id === restored.sessionId), false);
  } finally {
    restoreRunner();
  }
});

test('workflow 失败后重试会复用 task id，attempts 递增，并在成功后转为 completed', async () => {
  setServerBase('https://chat.example');
  login('workflow-retry-user');
  await workflowStore.useButler.getState().hydrate();

  await assert.rejects(async () => {
    await workflowStore.runButlerWorkflowTask({
      key: 'workflow-retry',
      kind: 'watcher',
      goal: '轮询失败后允许重试',
      context: workflowContext(),
      execute: async () => {
        throw new Error('第一次失败');
      },
    });
  });

  const failed = workflowSnapshot('workflow-retry');
  assert.equal(failed.taskState.status, 'failed');

  await workflowStore.runButlerWorkflowTask({
    key: 'workflow-retry',
    kind: 'watcher',
    goal: '轮询失败后允许重试',
    context: workflowContext(),
    execute: async () => ({
      value: '第二次成功',
      summary: '已完成重试',
    }),
  });

  const completed = workflowSnapshot('workflow-retry');
  assert.equal(completed.taskState.id, failed.taskState.id);
  assert.equal(completed.attempts, failed.attempts + 1);
  assert.equal(completed.taskState.status, 'completed');
});

test('用户暂停 workflow 任务会跨重启恢复为 paused', async () => {
  setServerBase('https://chat.example');
  login('workflow-paused-user');
  await workflowStore.useButler.getState().hydrate();

  let releaseExecute!: () => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const execution = new Promise<WorkflowTaskExecuteResult>((resolve) => {
    releaseExecute = () => resolve({ value: '迟到的完成结果', summary: '应被忽略' });
  });

  const running = workflowStore.runButlerWorkflowTask({
    key: 'workflow-pause',
    kind: 'rounds',
    goal: '支持用户主动暂停',
    context: workflowContext(),
    execute: async () => {
      signalStarted();
      return execution;
    },
  });

  await started;
  await workflowStore.pauseButlerWorkflowTask('workflow-pause', '用户暂停');
  releaseExecute();
  await running.catch(() => undefined);
  await butlerStore.flushButlerPersist();

  assert.equal(workflowSnapshot('workflow-pause').taskState.status, 'paused');

  butlerStore.resetButlerPersistenceForTests();
  workflowStore.useButler.getState().reset();
  await workflowStore.useButler.getState().hydrate();
  assert.equal(workflowSnapshot('workflow-pause').taskState.status, 'paused');
});

test('账号切换不会复用或覆盖另一账号正在执行的同 key workflow', async () => {
  setServerBase('https://chat.example');
  login('workflow-scope-a');
  await workflowStore.useButler.getState().hydrate();

  let releaseFirst!: () => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = workflowStore.runButlerWorkflowTask({
    key: 'workflow-scope',
    kind: 'routine',
    goal: '账号 A 的例行事务',
    execute: async () => {
      signalStarted();
      await blocked;
      return { value: '账号 A 的迟到结果' };
    },
  });
  await started;

  login('workflow-scope-b');
  await workflowStore.useButler.getState().hydrate();
  const second = await workflowStore.runButlerWorkflowTask({
    key: 'workflow-scope',
    kind: 'routine',
    goal: '账号 B 的例行事务',
    execute: async () => ({ value: '账号 B 已完成' }),
  });
  assert.equal(second, '账号 B 已完成');
  assert.equal(workflowSnapshot('workflow-scope').taskState.status, 'completed');

  releaseFirst();
  await assert.rejects(first, /登录作用域已切换/);
  assert.equal(workflowSnapshot('workflow-scope').taskState.status, 'completed');

  login('workflow-scope-a');
  await workflowStore.useButler.getState().hydrate();
  assert.equal(workflowSnapshot('workflow-scope').taskState.status, 'paused');
});

test('workflow 完成写 registry 时不会覆盖并发产生的 interactive transcript', async () => {
  setServerBase('https://chat.example');
  login('workflow-concurrent-user');
  const restoreRunner = butlerStore.setButlerLoopRunner(async (options) => ({
    text: '交互更新已完成',
    messages: options.messages,
  }));
  await workflowStore.useButler.getState().hydrate();

  let releaseWorkflow!: () => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseWorkflow = resolve;
  });
  const workflow = workflowStore.runButlerWorkflowTask({
    key: 'workflow-concurrent',
    kind: 'watcher',
    goal: '并发 registry 写入测试',
    execute: async () => {
      signalStarted();
      await blocked;
      return { value: 'workflow 完成' };
    },
  });

  try {
    await started;
    await workflowStore.useButler.getState().ask('保留这条交互消息');
    releaseWorkflow();
    await workflow;
    await butlerStore.flushButlerPersist();

    butlerStore.resetButlerPersistenceForTests();
    workflowStore.useButler.getState().reset();
    await workflowStore.useButler.getState().hydrate();

    assert.equal(
      workflowStore.useButler.getState().lines.some((item) => item.text === '保留这条交互消息'),
      true,
    );
    assert.equal(workflowSnapshot('workflow-concurrent').taskState.status, 'completed');
  } finally {
    restoreRunner();
  }
});

test('workflow 写工具审批 checkpoint 进入 workflowRuntimeCheckpoints，但不污染 interactive runtimeCheckpoints', async () => {
  setServerBase('https://chat.example');
  login('workflow-checkpoint-user');
  await workflowStore.useButler.getState().hydrate();
  assert.equal(workflowStore.useButler.getState().runtimeCheckpoints.length, 0);

  await workflowStore.runButlerWorkflowTask({
    key: 'workflow-checkpoints',
    kind: 'routine',
    goal: '写入审批留痕',
    context: workflowContext(),
    execute: async ({ taskState, toolRuntimeContext }) => {
      const result = await rememberTool().invoke({
        kind: 'preference',
        scope: 'room',
        subject: 'workflow-style',
        value: '审批后再执行',
      }, {
        ...toolRuntimeContext('remember-workflow'),
        taskId: taskState.id,
      });
      return {
        value: formatButlerToolResult(result),
        summary: '已生成待审批 checkpoint',
      };
    },
  });

  const snapshot = workflowSnapshot('workflow-checkpoints');
  assert.equal(snapshot.workflowRuntimeCheckpoints.length, 1);
  assert.equal(snapshot.workflowRuntimeCheckpoints[0]?.toolName, 'remember');
  assert.equal(snapshot.workflowRuntimeCheckpoints[0]?.status, 'approval-required');
  assert.equal(snapshot.workflowRuntimeCheckpoints[0]?.capability, 'memory.write');
  assert.equal(workflowStore.useButler.getState().runtimeCheckpoints.length, 0);
});
