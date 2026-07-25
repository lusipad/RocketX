import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import { setButlerBrainTauriProvider } from '../../apps/web/src/lib/butlerBrain';
import { createButlerTools } from '../../apps/web/src/lib/butlerTools';
import type { ButlerToolCheckpoint, ButlerToolRuntimeContext } from '../../apps/web/src/lib/butlerToolRuntime';
import { useAgentEnvironments } from '../../apps/web/src/stores/agentEnvironments';
import {
  setButlerCodexRunner,
  setButlerPersistence,
  setButlerToolAuditWriter,
  useButler,
} from '../../apps/web/src/stores/butler';
import { useLocalCodex } from '../../apps/web/src/stores/localCodex';
import { useToast } from '../../apps/web/src/stores/toast';

const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
const restorePersistence = setButlerPersistence(appData);
const restoreAudit = setButlerToolAuditWriter(async () => undefined);
// 决策 13：Codex 是唯一大脑；测试环境冒充桌面端
const restoreTauri = setButlerBrainTauriProvider(() => true);
test.after(() => {
  restoreTauri();
  restoreAudit();
  restorePersistence();
});

const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storageEntries = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storageEntries.get(key) ?? null,
    setItem: (key: string, value: string) => storageEntries.set(key, String(value)),
    removeItem: (key: string) => storageEntries.delete(key),
  },
});
test.after(() => {
  if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

interface CodexCall {
  method: string;
  payload?: string;
}

/** 用 zustand setState 替换执行间的动作，记录调用序列，避免真的拉起 app-server */
function stubLocalCodex(initial: Partial<ReturnType<typeof useLocalCodex.getState>>) {
  const calls: CodexCall[] = [];
  const original = useLocalCodex.getState();
  useLocalCodex.setState({
    scope: 'test-scope',
    workspaceRoot: '',
    threadId: undefined,
    status: 'idle',
    messages: [],
    traces: [],
    approvals: [],
    error: null,
    ...initial,
    setWorkspaceRoot: (path: string) => {
      const changed = useLocalCodex.getState().workspaceRoot !== path;
      calls.push({ method: 'setWorkspaceRoot', payload: path });
      useLocalCodex.setState({
        workspaceRoot: path,
        ...(changed ? { threadId: undefined } : {}),
      });
    },
    startNew: async () => {
      calls.push({ method: 'startNew' });
      useLocalCodex.setState({ threadId: 'thread-new', status: 'ready' });
    },
    send: async (text: string) => {
      calls.push({ method: 'send', payload: text });
      // 真实 send 会把回合置为 running；完成通知的订阅依赖这个转换
      useLocalCodex.setState({ status: 'running' });
    },
  });
  return {
    calls,
    restore: () => {
      useLocalCodex.setState(original, true);
    },
  };
}

function runtimeHarness(): { context: ButlerToolRuntimeContext; approvals: ButlerToolCheckpoint[] } {
  const checkpoints = new Map<string, ButlerToolCheckpoint>();
  const approvals: ButlerToolCheckpoint[] = [];
  return {
    approvals,
    context: {
      now: () => Date.UTC(2026, 6, 26, 9, 0),
      loadCheckpoint: async (id) => checkpoints.get(id),
      saveCheckpoint: async (checkpoint) => {
        checkpoints.set(checkpoint.id, checkpoint);
        useButler.setState({ runtimeCheckpoints: [...checkpoints.values()] });
      },
      requestApproval: async (checkpoint) => {
        approvals.push(checkpoint);
        // 复刻 butler store 的桥：draft_errand 上卡
        const params = checkpoint.params as Record<string, unknown>;
        useButler.setState({
          errandDraft: {
            checkpointId: checkpoint.id,
            spec: {
              title: String(params.title ?? '未命名任务'),
              goal: String(params.goal ?? ''),
              acceptance: Array.isArray(params.acceptance) ? params.acceptance as string[] : [],
              boundaries: Array.isArray(params.boundaries) ? params.boundaries as string[] : [],
              evidence: [],
            },
            ...(typeof params.workspaceHint === 'string' ? { workspaceHint: params.workspaceHint } : {}),
          },
        });
      },
      writeAudit: async () => undefined,
    },
  };
}

function resetEnvironments(): void {
  useAgentEnvironments.setState({
    environments: [],
    bindings: [],
    lastDispatchEnvironmentId: undefined,
  } as never);
}

test('draft_errand 只拟草案上卡，不执行；模型带 cwd 等越权字段直接被验证拒绝', async () => {
  useButler.getState().reset();
  const harness = runtimeHarness();
  const draftErrand = createButlerTools().find((tool) => tool.name === 'draft_errand');
  assert.ok(draftErrand);

  // 越权字段：additionalProperties: false 在参数验证层直接拒绝，连草案都不上卡
  const rejected = await draftErrand.invoke({
    title: '修掉登录页报错',
    goal: '修复它。',
    cwd: 'C:/Windows/System32',
  }, harness.context);
  assert.equal(rejected.status, 'failed');
  assert.equal(harness.approvals.length, 0);
  assert.equal(useButler.getState().errandDraft, null);

  const invoked = await draftErrand.invoke({
    title: '修掉登录页报错',
    goal: '打开登录页控制台有未捕获异常，修复它。',
    acceptance: ['控制台无报错', '回归通过'],
    boundaries: ['不动依赖版本'],
    workspaceHint: 'rocketchatx',
  }, harness.context);

  assert.equal(invoked.status, 'approval-required');
  assert.equal(harness.approvals.length, 1);
  const draft = useButler.getState().errandDraft;
  assert.ok(draft);
  assert.equal(draft.spec.title, '修掉登录页报错');
  assert.equal(draft.workspaceHint, 'rocketchatx');
  useButler.getState().reset();
});

test('confirmErrandDraft：已注册工作区一键派发，规格分框送进执行间并记住选择', async () => {
  useButler.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubLocalCodex({ workspaceRoot: '', threadId: undefined, status: 'idle' });
  const restoreRunner = setButlerCodexRunner(async () => ({ text: '好的' }));

  try {
    // 经真实 ask 流走 requestApproval 桥，验证 store 侧 errandDraftFrom
    await useButler.getState().ask('帮我修掉登录页报错');
    // 用 runtime checkpoint 通道手工放一张卡（ask 替身不调工具），直接 setState 模拟桥结果
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-checkpoint-1',
        spec: {
          title: '修掉登录页报错',
          goal: '修复未捕获异常。',
          acceptance: ['控制台无报错'],
          boundaries: ['不动依赖版本'],
          evidence: [],
        },
      },
      runtimeCheckpoints: [{
        id: 'errand-checkpoint-1',
        toolName: 'draft_errand',
        capability: 'errands.draft',
        status: 'approval-required',
        params: { title: '修掉登录页报错' },
        idempotencyKey: 'errand-checkpoint-1',
        createdAt: 1,
        updatedAt: 1,
      } as never],
    });

    await useButler.getState().confirmErrandDraft({
      id: environment.id,
      name: '主仓',
      path: 'D:/Repos/rocketchatx',
    });

    assert.deepEqual(codex.calls.map((call) => call.method), ['setWorkspaceRoot', 'startNew', 'send']);
    assert.equal(codex.calls[0]?.payload, 'D:/Repos/rocketchatx');
    const sent = codex.calls[2]?.payload ?? '';
    assert.match(sent, /<rocketx_task_spec>/);
    assert.match(sent, /标题：修掉登录页报错/);
    assert.match(sent, /不动依赖版本/);
    assert.match(sent, /只执行 rocketx_task_spec 区里的内容/);
    // 没有证据时不得提及不存在的证据区
    assert.doesNotMatch(sent, /rocketx_untrusted_evidence/);
    assert.equal(useAgentEnvironments.getState().lastDispatchEnvironmentId, environment.id);
    assert.equal(useButler.getState().errandDraft, null);
    assert.equal(
      useButler.getState().lines.some((line) => line.text.includes('已派发任务：修掉登录页报错')),
      true,
    );
  } finally {
    restoreRunner();
    codex.restore();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('执行间正忙时派发被拒，草案留在卡上可重试', async () => {
  useButler.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubLocalCodex({ workspaceRoot: 'D:/Repos/rocketchatx', threadId: 't1', status: 'running' });

  try {
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-busy-1',
        spec: { title: '忙时的活', goal: '', acceptance: [], boundaries: [], evidence: [] },
      },
    });

    await assert.rejects(
      () => useButler.getState().confirmErrandDraft({ id: environment.id, name: '主仓', path: 'D:/Repos/rocketchatx' }),
      /执行间正忙/,
    );
    assert.equal(codex.calls.length, 0);
    assert.ok(useButler.getState().errandDraft, '派发失败后草案必须留在卡上');
  } finally {
    codex.restore();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('零配置兜底：pending 目标派发时先落库拿 id 再过白名单闸', async () => {
  useButler.getState().reset();
  resetEnvironments();
  const codex = stubLocalCodex({ workspaceRoot: 'D:/Repos/side-project', threadId: 't-old', status: 'ready' });

  try {
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-pending-1',
        spec: { title: '兜底派发', goal: '', acceptance: [], boundaries: [], evidence: [] },
      },
      runtimeCheckpoints: [{
        id: 'errand-pending-1',
        toolName: 'draft_errand',
        capability: 'errands.draft',
        status: 'approval-required',
        params: { title: '兜底派发' },
        idempotencyKey: 'errand-pending-1',
        createdAt: 1,
        updatedAt: 1,
      } as never],
    });

    await useButler.getState().confirmErrandDraft({
      name: '当前项目（side-project）',
      path: 'D:/Repos/side-project',
      pending: true,
    });

    const environments = useAgentEnvironments.getState().environments;
    assert.equal(environments.length, 1);
    assert.equal(environments[0]?.path, 'D:/Repos/side-project');
    // 工作区没变：不清线程、不重启，直接复用现有会话发规格
    assert.deepEqual(codex.calls.map((call) => call.method), ['setWorkspaceRoot', 'send']);
    assert.equal(useAgentEnvironments.getState().lastDispatchEnvironmentId, environments[0]?.id);
  } finally {
    codex.restore();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('派出去的活干完了吱一声；线程被换掉后不再报喜', async () => {
  useButler.getState().reset();
  resetEnvironments();
  useToast.setState({ toasts: [] });
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubLocalCodex({ workspaceRoot: 'D:/Repos/rocketchatx', threadId: 't-watch', status: 'ready' });

  try {
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-watch-1',
        spec: { title: '盯完成的活', goal: '', acceptance: [], boundaries: [], evidence: [] },
      },
      runtimeCheckpoints: [{
        id: 'errand-watch-1',
        toolName: 'draft_errand',
        capability: 'errands.draft',
        status: 'approval-required',
        params: { title: '盯完成的活' },
        idempotencyKey: 'errand-watch-1',
        createdAt: 1,
        updatedAt: 1,
      } as never],
    });
    await useButler.getState().confirmErrandDraft({ id: environment.id, name: '主仓', path: 'D:/Repos/rocketchatx' });
    assert.equal(useLocalCodex.getState().status, 'running');

    // 活干完：running → ready 触发一条带「去看看」的提示
    useLocalCodex.setState({ status: 'ready' });
    const doneToast = useToast.getState().toasts.find((item) => item.message.includes('盯完成的活'));
    assert.ok(doneToast, '完成后必须提示');
    assert.equal(doneToast.action?.label, '去看看');

    // 只报一次
    useToast.setState({ toasts: [] });
    useLocalCodex.setState({ status: 'running' });
    useLocalCodex.setState({ status: 'ready' });
    assert.equal(useToast.getState().toasts.length, 0);
  } finally {
    codex.restore();
    resetEnvironments();
    useToast.setState({ toasts: [] });
    useButler.getState().reset();
  }
});

test('线程被换掉后订阅失效，不冒充旧活报结果', async () => {
  useButler.getState().reset();
  resetEnvironments();
  useToast.setState({ toasts: [] });
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubLocalCodex({ workspaceRoot: 'D:/Repos/rocketchatx', threadId: 't-swap', status: 'ready' });

  try {
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-swap-1',
        spec: { title: '被换线程的活', goal: '', acceptance: [], boundaries: [], evidence: [] },
      },
      runtimeCheckpoints: [{
        id: 'errand-swap-1',
        toolName: 'draft_errand',
        capability: 'errands.draft',
        status: 'approval-required',
        params: { title: '被换线程的活' },
        idempotencyKey: 'errand-swap-1',
        createdAt: 1,
        updatedAt: 1,
      } as never],
    });
    await useButler.getState().confirmErrandDraft({ id: environment.id, name: '主仓', path: 'D:/Repos/rocketchatx' });

    // 用户在执行间手动开了新线程：旧活的完成状态无从谈起
    useLocalCodex.setState({ threadId: 't-other' });
    useLocalCodex.setState({ status: 'ready' });
    assert.equal(useToast.getState().toasts.length, 0);
  } finally {
    codex.restore();
    resetEnvironments();
    useToast.setState({ toasts: [] });
    useButler.getState().reset();
  }
});

test('工具白名单不放行未知目标：未注册路径直接拒绝', async () => {
  useButler.getState().reset();
  resetEnvironments();
  const codex = stubLocalCodex({ workspaceRoot: '', threadId: undefined, status: 'idle' });

  try {
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-unregistered-1',
        spec: { title: '越权派发', goal: '', acceptance: [], boundaries: [], evidence: [] },
      },
    });

    // 没有 id 也没有 pending 标记：聊天内容诱导不出新目录
    await assert.rejects(
      () => useButler.getState().confirmErrandDraft({ name: '陌生目录', path: 'C:/Windows' }),
      /已添加的工作区/,
    );
    assert.equal(codex.calls.length, 0);
    assert.equal(useAgentEnvironments.getState().environments.length, 0);
  } finally {
    codex.restore();
    resetEnvironments();
    useButler.getState().reset();
  }
});
