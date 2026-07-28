import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import type { AppServerClient, AppServerClientOptions } from '../../apps/web/src/agent/protocol';
import { setButlerBrainTauriProvider } from '../../apps/web/src/lib/butlerBrain';
import { createButlerTools } from '../../apps/web/src/lib/butlerTools';
import type { ButlerToolCheckpoint, ButlerToolRuntimeContext } from '../../apps/web/src/lib/butlerToolRuntime';
import { useAgentEnvironments } from '../../apps/web/src/stores/agentEnvironments';
import {
  setButlerPersistence,
  setButlerToolAuditWriter,
  useButler,
} from '../../apps/web/src/stores/butler';
import {
  recoverPersistedButlerErrands,
  setButlerErrandClientFactory,
  useButlerErrandRuns,
} from '../../apps/web/src/stores/butlerErrandRuns';
import { useToast } from '../../apps/web/src/stores/toast';
// 必须静态 import：tsx 下测试内 await import() 会产生第二个模块实例，
// 拿到的是另一个 store，断言永远对不上
import { installModuleValidator, useUI } from '../../apps/web/src/stores/ui';
import { useCalendar } from '../../apps/web/src/stores/calendar';

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

test('重启后保留派活责任，但中断执行安全停在待重试且不保留失效审批', () => {
  const recovered = recoverPersistedButlerErrands([{
    id: 'restart-run',
    title: '发布前核对',
    threadId: 'thread-1',
    workspaceRoot: 'D:\\Repos\\rocketchatx',
    workspaceName: 'RocketX',
    readOnly: false,
    startedAt: 100,
    status: 'awaiting-approval',
    activity: '等待审批',
    approvals: [{ id: 'approval-1', method: 'item/commandExecution/requestApproval', policy: {}, params: {}, at: 200 }],
    traces: [],
  }], 300);

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, 'failed');
  assert.equal(recovered[0]?.approvals.length, 0);
  assert.match(recovered[0]?.error ?? '', /原责任和记录已保留/);
  assert.match(recovered[0]?.traces[0]?.text ?? '', /避免重复外部动作/);
});
test.after(() => {
  if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

interface CodexCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeErrandClient {
  calls: CodexCall[];
  options: AppServerClientOptions;
  stopped: boolean;
  threadId: string;
  turnId: string;
}

function stubErrandClients() {
  const clients: FakeErrandClient[] = [];
  const restore = setButlerErrandClientFactory(async (_sessionId, _workspaceRoot, options) => {
    const index = clients.length + 1;
    const fake: FakeErrandClient = {
      calls: [],
      options,
      stopped: false,
      threadId: `thread-${index}`,
      turnId: `turn-${index}`,
    };
    const client = {
      request: async (method: string, params: Record<string, unknown>) => {
        fake.calls.push({ method, params });
        if (method === 'thread/start') {
          return { thread: { id: fake.threadId, cliVersion: 'test' } };
        }
        if (method === 'turn/start') return { turn: { id: fake.turnId } };
        return {};
      },
      stop: async () => {
        fake.stopped = true;
      },
    } as unknown as AppServerClient;
    clients.push(fake);
    return client;
  });
  return {
    clients,
    restore,
    notify: (index: number, method: string, params: unknown) => {
      clients[index]?.options.onNotification?.(method, params);
    },
    requestApproval: (index: number, method: string, params: unknown) => {
      const handler = clients[index]?.options.onServerRequest;
      assert.ok(handler, '测试 client 必须接到自己的服务端请求处理器');
      return handler({ method, params, policy: 'host-approval' });
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

test('confirmErrandDraft：已注册工作区用独立 client 派发，规格分框送入新线程', async () => {
  await useButlerErrandRuns.getState().reset();
  useButler.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubErrandClients();

  try {
    useButler.setState({
      errandDraft: {
        checkpointId: 'errand-checkpoint-1',
        roomContext: { rid: 'room-original', roomName: '原房间' },
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
      context: {
        kind: 'room',
        label: '后来切到的房间',
        detail: '',
        sources: [{ kind: 'room', id: 'room-later', rid: 'room-later', label: '后来切到的房间' }],
      },
    });

    await useButler.getState().confirmErrandDraft({
      id: environment.id,
      name: '主仓',
      path: 'D:/Repos/rocketchatx',
    });

    assert.equal(codex.clients.length, 1);
    assert.deepEqual(codex.clients[0]?.calls.map((call) => call.method), [
      'thread/start',
      'thread/name/set',
      'turn/start',
    ]);
    const turn = codex.clients[0]?.calls.find((call) => call.method === 'turn/start');
    const sent = ((turn?.params.input as Array<{ text?: string }> | undefined)?.[0]?.text) ?? '';
    assert.match(sent, /<rocketx_task_spec>/);
    assert.match(sent, /标题：修掉登录页报错/);
    assert.match(sent, /不动依赖版本/);
    assert.match(sent, /只执行 rocketx_task_spec 区里的内容/);
    // 没有证据时不得提及不存在的证据区
    assert.doesNotMatch(sent, /rocketx_untrusted_evidence/);
    assert.equal(useAgentEnvironments.getState().lastDispatchEnvironmentId, environment.id);
    assert.equal(useButler.getState().errandDraft, null);
    assert.equal(useButler.getState().errands[0]?.threadId, 'thread-1');
    assert.deepEqual(useButler.getState().errands[0]?.roomContext, {
      rid: 'room-original',
      roomName: '原房间',
    });
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('执行间是否正忙不再影响派活，两件不同的活各建自己的 client', async () => {
  await useButlerErrandRuns.getState().reset();
  useButler.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubErrandClients();

  try {
    const target = { id: environment.id, name: '主仓', path: 'D:/Repos/rocketchatx' };
    await useButlerErrandRuns.getState().dispatchErrand(
      { title: '第一件活', goal: '', acceptance: [], boundaries: [], evidence: [] },
      target,
    );
    await useButlerErrandRuns.getState().dispatchErrand(
      { title: '第二件活', goal: '', acceptance: [], boundaries: [], evidence: [] },
      target,
    );
    assert.equal(codex.clients.length, 2);
    assert.deepEqual(
      useButler.getState().errands.map((run) => run.title).sort(),
      ['第一件活', '第二件活'],
    );
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('零配置兜底：pending 目标派发时先落库拿 id 再过白名单闸', async () => {
  await useButlerErrandRuns.getState().reset();
  useButler.getState().reset();
  resetEnvironments();
  const codex = stubErrandClients();

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
    const threadStart = codex.clients[0]?.calls.find((call) => call.method === 'thread/start');
    assert.equal(threadStart?.params.sandbox, 'workspace-write');
    assert.equal(useAgentEnvironments.getState().lastDispatchEnvironmentId, environments[0]?.id);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('派活会按意图设沙箱：要改代码就给写权限，只调查才只读', async () => {
  await useButlerErrandRuns.getState().reset();
  useButler.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubErrandClients();

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
    const threadStart = codex.clients[0]?.calls.find((call) => call.method === 'thread/start');
    const turnStart = codex.clients[0]?.calls.find((call) => call.method === 'turn/start');
    assert.equal(threadStart?.params.sandbox, 'workspace-write');
    assert.deepEqual(turnStart?.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: ['D:/Repos/rocketchatx'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    const run = useButler.getState().errands[0];
    assert.ok(run, '派发后必须留下在办的活');
    assert.equal(run.title, '要改代码的活');
    assert.equal(run.readOnly, false);
    assert.equal(run.workspaceName, '主仓');
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('勾了「只调查」就保持只读，且在办的活如实标注', async () => {
  await useButlerErrandRuns.getState().reset();
  useButler.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubErrandClients();

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

    const threadStart = codex.clients[0]?.calls.find((call) => call.method === 'thread/start');
    const turnStart = codex.clients[0]?.calls.find((call) => call.method === 'turn/start');
    assert.equal(threadStart?.params.sandbox, 'read-only');
    assert.deepEqual(turnStart?.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(useButler.getState().errands[0]?.readOnly, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('工具白名单不放行未知目标：未注册路径直接拒绝', async () => {
  await useButlerErrandRuns.getState().reset();
  useButler.getState().reset();
  resetEnvironments();
  const codex = stubErrandClients();

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
    assert.equal(codex.clients.length, 0);
    assert.equal(useAgentEnvironments.getState().environments.length, 0);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('人不在管家页时：等你点头与回话了都要提示，且指回管家页不是执行间', async () => {
  // 生产环境的模块列表由 kernel 注册；测试里没有 kernel，得放行
  installModuleValidator(() => true);
  await useButlerErrandRuns.getState().reset();
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
  const codex = stubErrandClients();

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
    const runId = useButler.getState().errands[0]?.id;
    assert.ok(runId);

    // Codex 请求点头：不提示的话活会一直卡着
    const decision = codex.requestApproval(0, 'item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      command: 'pnpm test:regression',
    });
    const ask = useToast.getState().toasts.find((item) => item.message.includes('等你点个头'));
    assert.ok(ask, '离席时等审批必须提示');
    assert.equal(ask.action?.label, '去看看');
    ask.action?.onClick();
    assert.equal(useUI.getState().module, 'butler-view', '提示必须指回管家页，不是执行间');
    const approvalId = useButler.getState().errands[0]?.approvals[0]?.id;
    assert.ok(approvalId);
    await useButler.getState().resolveErrandApproval(runId, approvalId, true);
    assert.deepEqual(await decision, { decision: 'accept' });

    // 回合结束：状态要收敛，卡片组件没挂载也一样
    useUI.getState().setModule('messages');
    useToast.setState({ toasts: [] });
    codex.notify(0, 'item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: '改完了',
    });
    codex.notify(0, 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    });

    const run = useButler.getState().errands.find((item) => item.id === runId);
    assert.equal(run?.status, 'replied', '人不在管家页也要收敛状态，否则导航角标永远不亮');
    assert.equal(run?.reply, '改完了');
    assert.ok(useToast.getState().toasts.some((item) => item.message.includes('回话了')));
    // 中性措辞：不替 Codex 宣布成功
    assert.equal(useToast.getState().toasts.some((item) => item.message.includes('完成')), false);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
    useToast.setState({ toasts: [] });
    useUI.getState().setModule('messages');
    useButler.getState().reset();
  }
});

test('派活原样消费 turn plan，并能按自己的 turnId 单独叫停', async () => {
  await useButlerErrandRuns.getState().reset();
  useButler.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubErrandClients();

  try {
    const run = await useButlerErrandRuns.getState().dispatchErrand(
      { title: '实现纸面进度', goal: '', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
    );
    codex.notify(0, 'turn/plan/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      explanation: null,
      plan: [
        { step: '锁定回归', status: 'completed' },
        { step: '补齐行内进度', status: 'inProgress' },
        { step: '跑 UI 冒烟', status: 'pending' },
      ],
    });

    assert.deepEqual(useButler.getState().errands[0]?.plan, [
      { step: '锁定回归', status: 'completed' },
      { step: '补齐行内进度', status: 'inProgress' },
      { step: '跑 UI 冒烟', status: 'pending' },
    ]);

    await useButler.getState().stopErrand(run.id);
    assert.deepEqual(
      codex.clients[0]?.calls.find((call) => call.method === 'turn/interrupt')?.params,
      { threadId: 'thread-1', turnId: 'turn-1' },
    );
    assert.equal(useButler.getState().errands[0]?.status, 'failed');
    assert.equal(useButler.getState().errands[0]?.error, '已叫停');
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
    useButler.getState().reset();
  }
});

test('对话里的草案卡要跟随到底，派出去的活区则独立放在消息滚动区外', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const deps = /useStickToBottom\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? '';
  assert.ok(deps, '找不到 stickToBottom 依赖数组');
  // 真机上漏掉 errandDraft 让「从桌面页派活」整条链路静默失败：
  // 卡片渲染在消息之后，不触发自动滚动就永远停在视口下方
  for (const state of ['errandDraft', 'routineDraft', 'actionDraft']) {
    assert.ok(deps.includes(state), `${state} 必须在 stickToBottom 依赖里`);
    assert.ok(source.includes(`state.${state}`), `${state} 必须真的订阅了 store`);
  }
  assert.ok(
    source.indexOf('<ButlerErrandRunCard />') < source.indexOf('<main ref={scrollRef}'),
    '派出去的活区必须独立于对话消息流',
  );
});

test('日程记得住出处：消息来源存成 ButlerSource，跳转复用同一套导航', () => {
  const before = useCalendar.getState().events.length;
  const id = useCalendar.getState().add({
    title: '周五评审',
    date: '2026-07-31',
    allDay: true,
    color: '#3370ff',
    source: 'manual',
    origin: {
      kind: 'message',
      id: 'm-abc',
      mid: 'm-abc',
      rid: 'r-dev',
      label: '研发群 · 张三',
    },
  });
  try {
    const saved = useCalendar.getState().events.find((event) => event.id === id);
    assert.ok(saved, '日程要建出来');
    // 出处用管家那套统一模型：一个字段通吃七种来源，跳转交给 openButlerSource
    assert.equal(saved.origin?.kind, 'message');
    assert.equal(saved.origin?.mid, 'm-abc');
    assert.equal(saved.origin?.rid, 'r-dev');
    assert.equal(saved.origin?.label, '研发群 · 张三');
  } finally {
    useCalendar.getState().remove(id);
    assert.equal(useCalendar.getState().events.length, before);
  }
});

test('工作项与 PR 都能排进日历，出处按各自类型存好', () => {
  const source = readFileSync('apps/web/src/components/AdoLists.tsx', 'utf8');
  // 入口存在
  assert.match(source, /把工作项 #\$\{w\.id\} 排进日历/);
  assert.match(source, /把 PR #\$\{pr\.id\} 排进日历/);
  // 出处按各自的 ButlerSource 类型存——跳转靠 openButlerSource 分派，写错 kind 就跳不回去
  assert.match(source, /kind: 'work-item'/);
  assert.match(source, /kind: 'pull-request'/);
  // 两者都带 webUrl，没有 webUrl 时 openButlerSource 才退回工作台
  assert.match(source, /calendarItem\.webUrl \? \{ webUrl: calendarItem\.webUrl \}/);
  assert.match(source, /calendarPr\.webUrl \? \{ webUrl: calendarPr\.webUrl \}/);
});

test('两件活并行时审批各归各：批准 A 不得吞掉 B 的审批', async () => {
  await useButlerErrandRuns.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubErrandClients();
  try {
    const target = { id: environment.id, name: environment.name, path: environment.path };
    const runA = await useButlerErrandRuns.getState().dispatchErrand(
      { title: '修登录页', goal: '', acceptance: [], boundaries: [], evidence: [] },
      target,
    );
    const runB = await useButlerErrandRuns.getState().dispatchErrand(
      { title: '查构建红灯', goal: '', acceptance: [], boundaries: [], evidence: [] },
      target,
    );
    const decisionA = codex.requestApproval(0, 'item/commandExecution/requestApproval', {
      threadId: runA.threadId,
      command: 'pnpm typecheck',
    });
    const decisionB = codex.requestApproval(1, 'item/commandExecution/requestApproval', {
      threadId: runB.threadId,
      command: 'pnpm test:ui',
    });
    const approvalA = useButlerErrandRuns.getState().runs.find((run) => run.id === runA.id)?.approvals[0];
    const approvalB = useButlerErrandRuns.getState().runs.find((run) => run.id === runB.id)?.approvals[0];
    assert.ok(approvalA);
    assert.ok(approvalB);

    await useButlerErrandRuns.getState().resolveApproval(runA.id, approvalA.id, true);
    assert.deepEqual(await decisionA, { decision: 'accept' });
    assert.deepEqual(
      useButlerErrandRuns.getState().runs.find((run) => run.id === runA.id)?.approvals,
      [],
    );
    assert.deepEqual(
      useButlerErrandRuns.getState().runs.find((run) => run.id === runB.id)?.approvals.map((item) => item.id),
      [approvalB.id],
    );
    await useButlerErrandRuns.getState().resolveApproval(runB.id, approvalB.id, false);
    assert.deepEqual(await decisionB, { decision: 'decline' });
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('派出去的活排序按优先级且同态按启动时间倒序', async () => {
  const { visibleButlerErrands } = await import('../../apps/web/src/lib/butlerErrands');
  const base = {
    threadId: 'thread',
    workspaceRoot: 'D:/Repos/rocketchatx',
    workspaceName: '主仓',
    readOnly: false,
    activity: undefined,
    approvals: [],
    traces: [],
  };
  const ordered = visibleButlerErrands([
    { ...base, id: 'replied', title: '回话了', status: 'replied', startedAt: 9 },
    { ...base, id: 'failed', title: '没办成', status: 'failed', startedAt: 10 },
    { ...base, id: 'running-old', title: '较早在跑', status: 'running', startedAt: 2 },
    { ...base, id: 'waiting', title: '等你点头', status: 'awaiting-approval', startedAt: 1 },
    { ...base, id: 'running-new', title: '较晚在跑', status: 'running', startedAt: 8 },
  ]);
  assert.deepEqual(
    ordered.map((run) => run.id),
    ['waiting', 'running-new', 'running-old', 'failed', 'replied'],
  );
});

test('收下回话了的活后，它会从列表消失，不影响别的在办项', async () => {
  await useButlerErrandRuns.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubErrandClients();
  try {
    const run = await useButlerErrandRuns.getState().dispatchErrand(
      { title: '已经回话', goal: '', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
    );
    codex.notify(0, 'item/agentMessage/delta', {
      threadId: run.threadId,
      turnId: 'turn-1',
      delta: '改完了。',
    });
    codex.notify(0, 'turn/completed', {
      threadId: run.threadId,
      turn: { id: 'turn-1', status: 'completed' },
    });
    assert.equal(useButlerErrandRuns.getState().visibleRuns.length, 1);
    await useButlerErrandRuns.getState().archiveErrand(run.id);
    assert.equal(useButlerErrandRuns.getState().runs[0]?.archivedAt !== undefined, true);
    assert.deepEqual(useButlerErrandRuns.getState().visibleRuns, []);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('重复派发被拒：同一工作区里完全相同标题的在办活只能有一件', async () => {
  await useButlerErrandRuns.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubErrandClients();
  try {
    const target = { id: environment.id, name: environment.name, path: environment.path };
    const spec = { title: '核对发布清单', goal: '', acceptance: [], boundaries: [], evidence: [] };
    await useButlerErrandRuns.getState().dispatchErrand(spec, target);
    await assert.rejects(
      () => useButlerErrandRuns.getState().dispatchErrand(spec, target),
      /这件活正在干，别重复派/,
    );
    assert.equal(codex.clients.length, 1);
    assert.equal(useButlerErrandRuns.getState().visibleRuns.length, 1);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('未收下的活到 5 件后拒绝继续派，避免并发失控', async () => {
  await useButlerErrandRuns.getState().reset();
  resetEnvironments();
  const environment = useAgentEnvironments.getState().addEnvironment({
    name: '主仓',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: '',
    branchPrefix: '',
  });
  const codex = stubErrandClients();
  try {
    const target = { id: environment.id, name: environment.name, path: environment.path };
    for (let index = 1; index <= 5; index += 1) {
      await useButlerErrandRuns.getState().dispatchErrand(
        { title: `第 ${index} 件`, goal: '', acceptance: [], boundaries: [], evidence: [] },
        target,
      );
    }
    await assert.rejects(
      () => useButlerErrandRuns.getState().dispatchErrand(
        { title: '第 6 件', goal: '', acceptance: [], boundaries: [], evidence: [] },
        target,
      ),
      /手头 5 件了，收几件再派/,
    );
    assert.equal(codex.clients.length, 5);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

function readErrandListSurfaceSource(): string {
  for (const path of [
    'apps/web/src/components/ButlerErrandsCard.tsx',
    'apps/web/src/components/ButlerErrandRunCard.tsx',
  ]) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error('找不到派出去的活列表组件');
}

test('决策14刀1：butler store 以 errands 列表承载并行派活，不再把 errandRun 当唯一真相', () => {
  const source = readFileSync('apps/web/src/stores/butler.ts', 'utf8');
  assert.match(
    source,
    /\berrands\s*:\s*[^;=]+(?:\[\]|Array<)/,
    '派活状态应升级成 errands 列表，支持并行、排序与收下归档',
  );
  assert.doesNotMatch(
    source,
    /\berrandRun\s*:\s*ButlerErrandRun \| null/,
    '单个 errandRun 会把并行审批、并行进度和签收归档重新压回单活模型',
  );
});

test('决策14刀1：派活不再借 localCodex 单线程，因此第二件活不会被“执行间正忙”结构性拒绝', () => {
  const source = readFileSync('apps/web/src/lib/butlerErrands.ts', 'utf8');
  assert.doesNotMatch(
    source,
    /执行间正忙，等当前的活干完再派/,
    '并行派活落地后，不应再因为共享单线程而拒绝第二件活',
  );
  assert.doesNotMatch(
    source,
    /useLocalCodex/,
    '刀1要求每件活自持运行客户端，不再借 localCodex 的线程状态与审批队列',
  );
});

test('决策14刀1.5：活按等审批与在办分区，回话后的动作是“收下”而不是“收起”', () => {
  const source = readErrandListSurfaceSource();
  assert.match(source, /\berrands\b/, '活区应基于 errands 列表渲染');
  assert.match(source, /partitionButlerPaperErrands/, '纸应把等审批与其余在办活分成两个空区可隐藏的区');
  assert.match(source, /\bmap\(/, '列表渲染至少要支持两件以上并行的活');
  assert.match(source, /等你点头/);
  assert.match(source, /在办/);
  assert.match(source, /回话了/);
  assert.match(source, /收下/, '回话后的活应要求用户“收下”归档');
  assert.doesNotMatch(source, /收起/, '“收起”会把 GTD 收件箱语义变成临时藏起来');
});
