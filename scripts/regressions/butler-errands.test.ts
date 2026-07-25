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
// 必须静态 import：tsx 下测试内 await import() 会产生第二个模块实例，
// 拿到的是另一个 store，断言永远对不上
import { installModuleValidator, useUI } from '../../apps/web/src/stores/ui';

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
    sandboxMode: 'read-only',
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
    setSandboxMode: (mode: 'read-only' | 'workspace-write') => {
      calls.push({ method: 'setSandboxMode', payload: mode });
      useLocalCodex.setState({ sandboxMode: mode });
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

    assert.deepEqual(
      codex.calls.map((call) => call.method),
      ['setWorkspaceRoot', 'setSandboxMode', 'startNew', 'send'],
    );
    assert.equal(codex.calls[0]?.payload, 'D:/Repos/rocketchatx');
    const sent = codex.calls.at(-1)?.payload ?? '';
    assert.match(sent, /<rocketx_task_spec>/);
    assert.match(sent, /标题：修掉登录页报错/);
    assert.match(sent, /不动依赖版本/);
    assert.match(sent, /只执行 rocketx_task_spec 区里的内容/);
    // 没有证据时不得提及不存在的证据区
    assert.doesNotMatch(sent, /rocketx_untrusted_evidence/);
    assert.equal(useAgentEnvironments.getState().lastDispatchEnvironmentId, environment.id);
    assert.equal(useButler.getState().errandDraft, null);
    const dispatched = useButler.getState().lines.find((line) => line.text.includes('修掉登录页报错')
      && line.text.includes('已派出去'));
    assert.ok(dispatched, '派发后对话里要有一行交代');
    // 这句会被模型学舌：提「去执行间看」，管家就会反复把用户往执行间赶
    assert.doesNotMatch(dispatched.text, /执行间/);
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
    // 默认要写权限：沙箱从只读切过来必须重起线程才生效
    assert.deepEqual(
      codex.calls.map((call) => call.method),
      ['setWorkspaceRoot', 'setSandboxMode', 'startNew', 'send'],
    );
    assert.equal(useAgentEnvironments.getState().lastDispatchEnvironmentId, environments[0]?.id);
  } finally {
    codex.restore();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('派活会按意图设沙箱：要改代码就给写权限，只调查才只读', async () => {
  useButler.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubLocalCodex({ workspaceRoot: 'D:/Repos/rocketchatx', threadId: 't-sandbox', status: 'ready', sandboxMode: 'read-only' });

  try {
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-sandbox-1',
        spec: { title: '要改代码的活', goal: '', acceptance: [], boundaries: [], evidence: [] },
      },
      runtimeCheckpoints: [{
        id: 'errand-sandbox-1',
        toolName: 'draft_errand',
        capability: 'errands.draft',
        status: 'approval-required',
        params: { title: '要改代码的活' },
        idempotencyKey: 'errand-sandbox-1',
        createdAt: 1,
        updatedAt: 1,
      } as never],
    });

    // 默认（不勾「只调查」）必须拿到写权限——只读会让「修 bug」结构性干不完
    await useButler.getState().confirmErrandDraft({ id: environment.id, name: '主仓', path: 'D:/Repos/rocketchatx' });
    assert.equal(useLocalCodex.getState().sandboxMode, 'workspace-write');
    // 沙箱变了必须重起线程才生效
    assert.deepEqual(codex.calls.map((call) => call.method), ['setWorkspaceRoot', 'setSandboxMode', 'startNew', 'send']);

    const run = useButler.getState().errandRun;
    assert.ok(run, '派发后必须留下在办的活');
    assert.equal(run.title, '要改代码的活');
    assert.equal(run.readOnly, false);
    assert.equal(run.workspaceName, '主仓');
  } finally {
    codex.restore();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('勾了「只调查」就保持只读，且在办的活如实标注', async () => {
  useButler.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubLocalCodex({ workspaceRoot: 'D:/Repos/rocketchatx', threadId: 't-ro', status: 'ready', sandboxMode: 'read-only' });

  try {
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-ro-1',
        spec: { title: '只看看的活', goal: '', acceptance: [], boundaries: [], evidence: [] },
      },
      runtimeCheckpoints: [{
        id: 'errand-ro-1',
        toolName: 'draft_errand',
        capability: 'errands.draft',
        status: 'approval-required',
        params: { title: '只看看的活' },
        idempotencyKey: 'errand-ro-1',
        createdAt: 1,
        updatedAt: 1,
      } as never],
    });
    await useButler.getState().confirmErrandDraft(
      { id: environment.id, name: '主仓', path: 'D:/Repos/rocketchatx' },
      { readOnly: true },
    );

    assert.equal(useLocalCodex.getState().sandboxMode, 'read-only');
    // 沙箱没变、目录没变、线程还在：不必重起
    assert.deepEqual(codex.calls.map((call) => call.method), ['setWorkspaceRoot', 'send']);
    assert.equal(useButler.getState().errandRun?.readOnly, true);
  } finally {
    codex.restore();
    resetEnvironments();
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

test('人不在管家页时：等你点头与回话了都要提示，且指回管家页不是执行间', async () => {
  // 生产环境的模块列表由 kernel 注册；测试里没有 kernel，得放行
  installModuleValidator(() => true);
  useButler.getState().reset();
  resetEnvironments();
  useToast.setState({ toasts: [] });
  useUI.getState().setModule('messages');
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubLocalCodex({ workspaceRoot: 'D:/Repos/rocketchatx', threadId: 't-away', status: 'ready', sandboxMode: 'workspace-write' });

  try {
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-away-1',
        spec: { title: '离席时的活', goal: '', acceptance: [], boundaries: [], evidence: [] },
      },
      runtimeCheckpoints: [{
        id: 'errand-away-1',
        toolName: 'draft_errand',
        capability: 'errands.draft',
        status: 'approval-required',
        params: { title: '离席时的活' },
        idempotencyKey: 'errand-away-1',
        createdAt: 1,
        updatedAt: 1,
      } as never],
    });
    await useButler.getState().confirmErrandDraft({ id: environment.id, name: '主仓', path: 'D:/Repos/rocketchatx' });

    // Codex 请求点头：不提示的话活会一直卡着
    useLocalCodex.setState({ approvals: [{ id: 'a1', method: 'item/fileChange/requestApproval', params: {}, at: 1 } as never] });
    const ask = useToast.getState().toasts.find((item) => item.message.includes('等你点个头'));
    assert.ok(ask, '离席时等审批必须提示');
    assert.equal(ask.action?.label, '去看看');
    ask.action?.onClick();
    assert.equal(useUI.getState().module, 'butler-view', '提示必须指回管家页，不是执行间');

    // 回合结束：状态要收敛，卡片组件没挂载也一样
    useUI.getState().setModule('messages');
    useToast.setState({ toasts: [] });
    useLocalCodex.setState({ approvals: [], messages: [{ id: 'm1', role: 'assistant', text: '改完了', at: 2 } as never] });
    useLocalCodex.setState({ status: 'ready' });

    const run = useButler.getState().errandRun;
    assert.equal(run?.outcome, 'replied', '人不在管家页也要收敛 outcome，否则导航角标永远不亮');
    assert.equal(run?.reply, '改完了');
    assert.ok(useToast.getState().toasts.some((item) => item.message.includes('回话了')));
    // 中性措辞：不替 Codex 宣布成功
    assert.equal(useToast.getState().toasts.some((item) => item.message.includes('完成')), false);
  } finally {
    codex.restore();
    resetEnvironments();
    useToast.setState({ toasts: [] });
    useUI.getState().setModule('messages');
    useButler.getState().reset();
  }
});
