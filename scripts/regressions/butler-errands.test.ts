import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import type { AppServerClient, AppServerClientOptions } from '../../apps/web/src/agent/protocol';
import { setBusinessMcpLaunchConfigProvider } from '../../apps/web/src/agent/businessMcp';
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
const restoreBusinessMcp = setBusinessMcpLaunchConfigProvider(async () => ({
  command: 'C:/Program Files/RocketX/rocketx.exe',
  args: ['--business-mcp'],
}));
test.after(() => {
  restoreBusinessMcp();
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
    originSessionId: 123,
    approvals: [{ id: 'approval-1', method: 'item/commandExecution/requestApproval', policy: {}, params: {}, at: 200 }],
    traces: [],
  }], 300);

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, 'paused');
  assert.equal(recovered[0]?.originSessionId, undefined);
  assert.equal(recovered[0]?.approvals.length, 0);
  assert.match(recovered[0]?.error ?? '', /原责任和记录已保留/);
  assert.match(recovered[0]?.traces[0]?.text ?? '', /避免重复外部动作/);
});

test('显式 resume：同一 thread 恢复后若已有活动 turn，就用 turn/steer 带 expectedTurnId 续跑', async () => {
  await useButlerErrandRuns.getState().reset();
  const codex = stubErrandClients();
  try {
    const run = recoverPersistedButlerErrands([{
      id: 'paused-run-steer',
      title: '恢复后继续收尾',
      threadId: 'thread-1',
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceName: 'RocketX',
      readOnly: false,
      startedAt: 100,
      status: 'paused',
      activity: undefined,
      approvals: [],
      traces: [],
    }])[0];
    assert.ok(run);
    useButlerErrandRuns.setState({ runs: [run], visibleRuns: [run] });
    codex.setResumeThreadState(0, { type: 'active', activeFlags: [] }, [
      { id: 'turn-active-1', status: 'inProgress' },
    ]);

    await useButlerErrandRuns.getState().resumeErrand(run.id, '先别动后端，只收尾前端。');

    assert.deepEqual(codex.clients[0]?.calls.map((call) => call.method), [
      'thread/resume',
      'thread/goal/get',
      'thread/goal/set',
      'turn/steer',
    ]);
    assert.equal(
      codex.clients[0]?.calls.find((call) => call.method === 'thread/resume')?.params.approvalsReviewer,
      'auto_review',
    );
    assert.equal(
      codex.clients[0]?.calls.find((call) => call.method === 'thread/resume')?.params.approvalPolicy,
      'on-request',
    );
    assert.deepEqual(
      codex.clients[0]?.calls.find((call) => call.method === 'thread/resume')?.params.config,
      {
        mcp_servers: {
          rocketx_business: {
            command: 'C:/Program Files/RocketX/rocketx.exe',
            args: ['--business-mcp'],
          },
        },
      },
    );
    assert.deepEqual(
      codex.clients[0]?.calls.find((call) => call.method === 'turn/steer')?.params,
      {
        threadId: 'thread-1',
        expectedTurnId: 'turn-active-1',
        input: [{ type: 'text', text: '先别动后端，只收尾前端。', text_elements: [] }],
      },
    );
    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'running');
    assert.equal(codex.clients[0]?.calls.some((call) => call.method === 'thread/start'), false);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
  }
});

test('显式 resume：同一 thread 恢复后没有活动 turn，才重新 turn/start', async () => {
  await useButlerErrandRuns.getState().reset();
  const codex = stubErrandClients();
  try {
    const run = recoverPersistedButlerErrands([{
      id: 'paused-run-start',
      title: '继续完成目标',
      threadId: 'thread-1',
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceName: 'RocketX',
      readOnly: false,
      startedAt: 100,
      status: 'paused',
      activity: undefined,
      approvals: [],
      traces: [],
    }])[0];
    assert.ok(run);
    useButlerErrandRuns.setState({ runs: [run], visibleRuns: [run] });
    codex.setResumeThreadState(0, { type: 'idle' }, []);

    await useButlerErrandRuns.getState().resumeErrand(run.id);

    assert.deepEqual(codex.clients[0]?.calls.map((call) => call.method), [
      'thread/resume',
      'thread/goal/get',
      'thread/goal/set',
      'turn/start',
    ]);
    const resumedInput = ((codex.clients[0]?.calls.find((call) => call.method === 'turn/start')?.params.input as Array<{ text: string }> | undefined)?.[0]?.text) ?? '';
    assert.match(resumedInput, /先核对当前线程和工作区的真实状态/);
    assert.equal(codex.clients[0]?.calls.some((call) => call.method === 'thread/start'), false);
    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'running');
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
  }
});

test('恢复后若原线程仍在等审批或输入，保持 paused，不自动续跑', async () => {
  await useButlerErrandRuns.getState().reset();
  const codex = stubErrandClients();
  try {
    const run = recoverPersistedButlerErrands([{
      id: 'paused-run-waiting',
      title: '等等再继续',
      threadId: 'thread-1',
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceName: 'RocketX',
      readOnly: false,
      startedAt: 100,
      status: 'paused',
      activity: undefined,
      approvals: [],
      traces: [],
    }])[0];
    assert.ok(run);
    useButlerErrandRuns.setState({ runs: [run], visibleRuns: [run] });
    codex.setResumeThreadState(0, { type: 'active', activeFlags: ['waitingOnApproval'] }, [
      { id: 'turn-active-1', status: 'inProgress' },
    ]);

    await useButlerErrandRuns.getState().resumeErrand(run.id);

    assert.deepEqual(codex.clients[0]?.calls.map((call) => call.method), ['thread/resume']);
    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'paused');
    assert.match(useButlerErrandRuns.getState().runs[0]?.error ?? '', /等待输入或审批/);
    assert.match(useButlerErrandRuns.getState().runs[0]?.error ?? '', /codex resume/);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
  }
});

test('重启后的 paused 任务叫停时先恢复控制面并暂停远端 Goal', async () => {
  await useButlerErrandRuns.getState().reset();
  const codex = stubErrandClients();
  try {
    const run = recoverPersistedButlerErrands([{
      id: 'paused-run-stop',
      title: '不要再继续',
      threadId: 'thread-1',
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceName: 'RocketX',
      readOnly: false,
      startedAt: 100,
      status: 'paused',
      activity: undefined,
      approvals: [],
      traces: [],
    }])[0];
    assert.ok(run);
    useButlerErrandRuns.setState({ runs: [run], visibleRuns: [run] });
    codex.setResumeThreadState(0, { type: 'active', activeFlags: ['waitingOnApproval'] }, [
      { id: 'turn-active-1', status: 'inProgress' },
    ]);

    await useButlerErrandRuns.getState().stopErrand(run.id);

    assert.deepEqual(codex.clients[0]?.calls.map((call) => call.method), [
      'thread/resume',
      'thread/goal/set',
      'turn/interrupt',
    ]);
    assert.deepEqual(
      codex.clients[0]?.calls.find((call) => call.method === 'thread/goal/set')?.params,
      { threadId: 'thread-1', status: 'paused' },
    );
    assert.deepEqual(
      codex.clients[0]?.calls.find((call) => call.method === 'turn/interrupt')?.params,
      { threadId: 'thread-1', turnId: 'turn-active-1' },
    );
    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'failed');
    assert.equal(useButlerErrandRuns.getState().runs[0]?.error, '已叫停');
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
  }
});

test('恢复后的 active turn 中断失败时保持 paused，不伪装成已经叫停', async () => {
  await useButlerErrandRuns.getState().reset();
  const codex = stubErrandClients();
  try {
    const run = recoverPersistedButlerErrands([{
      id: 'paused-run-stop-failed',
      title: '停止状态要诚实',
      threadId: 'thread-1',
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceName: 'RocketX',
      readOnly: false,
      startedAt: 100,
      status: 'paused',
      activity: undefined,
      approvals: [],
      traces: [],
    }])[0];
    assert.ok(run);
    useButlerErrandRuns.setState({ runs: [run], visibleRuns: [run] });
    codex.setResumeThreadState(0, { type: 'active', activeFlags: [] }, [
      { id: 'turn-active-1', status: 'inProgress' },
    ]);
    codex.failMethod(0, 'turn/interrupt');

    await useButlerErrandRuns.getState().stopErrand(run.id);

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'paused');
    assert.match(useButlerErrandRuns.getState().runs[0]?.error ?? '', /还不能确认原线程已经停下/);
    assert.notEqual(useButlerErrandRuns.getState().runs[0]?.error, '已叫停');
    assert.equal(codex.clients[0]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
  }
});

test('paused 上的 steer 走 resume，同线程续跑而不是新开 thread', async () => {
  await useButlerErrandRuns.getState().reset();
  const codex = stubErrandClients();
  try {
    const run = recoverPersistedButlerErrands([{
      id: 'paused-run-steer-entry',
      title: '直接补一句新约束',
      threadId: 'thread-1',
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceName: 'RocketX',
      readOnly: false,
      startedAt: 100,
      status: 'paused',
      activity: undefined,
      approvals: [],
      traces: [],
    }])[0];
    assert.ok(run);
    useButlerErrandRuns.setState({ runs: [run], visibleRuns: [run] });
    codex.setResumeThreadState(0, { type: 'idle' }, []);

    await useButlerErrandRuns.getState().steerErrand(run.id, '先补测试，再动实现。');

    assert.equal(codex.clients[0]?.calls[0]?.method, 'thread/resume');
    assert.equal(codex.clients[0]?.calls.some((call) => call.method === 'thread/start'), false);
    const turnStart = codex.clients[0]?.calls.find((call) => call.method === 'turn/start');
    assert.equal(((turnStart?.params.input as Array<{ text: string }> | undefined)?.[0]?.text) ?? '', '先补测试，再动实现。');
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
  }
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
  failMethods: Set<string>;
  interruptMethods: Set<string>;
  options: AppServerClientOptions;
  stopped: boolean;
  threadId: string;
  turnId: string;
  goalStatus: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  historyReply: string;
  resumeThreadStatus: { type: 'idle' } | { type: 'active'; activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'> };
  resumeTurns: Array<{ id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress' }>;
}

function stubErrandClients() {
  const clients: FakeErrandClient[] = [];
  const events: string[] = [];
  const pendingResumeThreadStates = new Map<number, {
    status: FakeErrandClient['resumeThreadStatus'];
    turns: FakeErrandClient['resumeTurns'];
  }>();
  const pendingFailMethods = new Map<number, Set<string>>();
  const pendingInterruptMethods = new Map<number, Set<string>>();
  const pendingGoalStatuses = new Map<number, FakeErrandClient['goalStatus']>();
  const pendingHistoryReplies = new Map<number, string>();
  const restore = setButlerErrandClientFactory(async (_sessionId, _workspaceRoot, options) => {
    const clientIndex = clients.length;
    const index = clients.length + 1;
    const pendingResume = pendingResumeThreadStates.get(index - 1);
    const fake: FakeErrandClient = {
      calls: [],
      failMethods: new Set(pendingFailMethods.get(index - 1) ?? []),
      interruptMethods: new Set(pendingInterruptMethods.get(index - 1) ?? []),
      options,
      stopped: false,
      threadId: `thread-${index}`,
      turnId: `turn-${index}`,
      goalStatus: pendingGoalStatuses.get(index - 1) ?? 'active',
      historyReply: pendingHistoryReplies.get(index - 1) ?? '',
      resumeThreadStatus: pendingResume?.status ?? { type: 'idle' },
      resumeTurns: pendingResume?.turns ?? [],
    };
    const client = {
      request: async (method: string, params: Record<string, unknown>) => {
        events.push(`request:${clientIndex}:${method}`);
        fake.calls.push({ method, params });
        if (fake.interruptMethods.has(method)) {
          const error = new Error(`${method} 期间 Codex app-server 已退出`);
          fake.options.onInterrupted?.(error);
          throw error;
        }
        if (fake.failMethods.has(method)) throw new Error(`${method} 测试失败`);
        if (method === 'thread/start') {
          return { thread: { id: fake.threadId, cliVersion: 'test' } };
        }
        if (method === 'thread/goal/set') {
          if (typeof params.status === 'string') {
            fake.goalStatus = params.status as FakeErrandClient['goalStatus'];
          }
          return {
            goal: {
              threadId: fake.threadId,
              objective: String(params.objective ?? ''),
              status: fake.goalStatus,
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === 'thread/goal/get') {
          return {
            goal: {
              threadId: fake.threadId,
              objective: '测试目标',
              status: fake.goalStatus,
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === 'thread/resume') {
          if (typeof params.threadId === 'string') fake.threadId = params.threadId;
          return {
            thread: {
              id: fake.threadId,
              status: fake.resumeThreadStatus,
              turns: fake.resumeTurns.map((turn) => ({ ...turn, items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: null, durationMs: null })),
            },
          };
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: fake.threadId,
              turns: fake.historyReply
                ? [{
                    id: fake.turnId,
                    items: [{ type: 'agentMessage', id: 'history-reply', text: fake.historyReply }],
                  }]
                : [],
            },
          };
        }
        if (method === 'turn/start') return { turn: { id: fake.turnId } };
        if (method === 'turn/steer') return { turnId: fake.turnId };
        return {};
      },
      stop: async () => {
        events.push(`stop:${clientIndex}`);
        fake.stopped = true;
      },
    } as unknown as AppServerClient;
    clients.push(fake);
    return client;
  });
  return {
    clients,
    events,
    restore,
    notify: (index: number, method: string, params: unknown) => {
      clients[index]?.options.onNotification?.(method, params);
    },
    requestApproval: (index: number, method: string, params: unknown) => {
      const handler = clients[index]?.options.onServerRequest;
      assert.ok(handler, '测试 client 必须接到自己的服务端请求处理器');
      return handler({ method, params, policy: 'host-approval' });
    },
    setGoalStatus: (index: number, status: FakeErrandClient['goalStatus']) => {
      const client = clients[index];
      if (client) {
        client.goalStatus = status;
        return;
      }
      pendingGoalStatuses.set(index, status);
    },
    setHistoryReply: (index: number, reply: string) => {
      const client = clients[index];
      if (client) {
        client.historyReply = reply;
        return;
      }
      pendingHistoryReplies.set(index, reply);
    },
    setResumeThreadState: (
      index: number,
      status: FakeErrandClient['resumeThreadStatus'],
      turns: FakeErrandClient['resumeTurns'] = [],
    ) => {
      const client = clients[index];
      if (client) {
        client.resumeThreadStatus = status;
        client.resumeTurns = turns;
        return;
      }
      pendingResumeThreadStates.set(index, { status, turns });
    },
    failMethod: (index: number, method: string) => {
      const client = clients[index];
      if (client) {
        client.failMethods.add(method);
        return;
      }
      const methods = pendingFailMethods.get(index) ?? new Set<string>();
      methods.add(method);
      pendingFailMethods.set(index, methods);
    },
    interruptMethod: (index: number, method: string) => {
      const client = clients[index];
      if (client) {
        client.interruptMethods.add(method);
        return;
      }
      const methods = pendingInterruptMethods.get(index) ?? new Set<string>();
      methods.add(method);
      pendingInterruptMethods.set(index, methods);
    },
  };
}

async function flushErrandEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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

test('list_errands 和 steer_errand 只控制当前 Butler 会话里的原任务', async () => {
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
    const target = { id: environment.id, name: environment.name, path: environment.path };
    const ownRun = await useButlerErrandRuns.getState().dispatchErrand(
      { title: '修登录页', goal: '', acceptance: [], boundaries: [], evidence: [] },
      target,
      { originSessionId: 'butler-session-a' },
    );
    const otherRun = await useButlerErrandRuns.getState().dispatchErrand(
      { title: '修构建', goal: '', acceptance: [], boundaries: [], evidence: [] },
      target,
      { originSessionId: 'butler-session-b' },
    );
    const tools = createButlerTools();
    const listErrands = tools.find((tool) => tool.name === 'list_errands');
    const steerErrand = tools.find((tool) => tool.name === 'steer_errand');
    assert.ok(listErrands);
    assert.ok(steerErrand);
    const harness = runtimeHarness();
    const context = { ...harness.context, sessionId: 'butler-session-a' };

    const listed = await listErrands.invoke({}, context);
    assert.equal(listed.status, 'completed');
    assert.deepEqual(
      JSON.parse(listed.content ?? '[]').map((run: { id: string }) => run.id),
      [ownRun.id],
    );

    const steered = await steerErrand.invoke({ instruction: '只改前端，不动后端。' }, context);
    assert.equal(steered.status, 'completed');
    assert.deepEqual(
      codex.clients[0]?.calls.find((call) => call.method === 'turn/steer')?.params,
      {
        threadId: ownRun.threadId,
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: '只改前端，不动后端。', text_elements: [] }],
      },
    );

    const crossSession = await steerErrand.invoke({
      runId: otherRun.id,
      instruction: '越过会话控制另一件活。',
    }, context);
    assert.equal(crossSession.status, 'failed');
    assert.match(crossSession.error?.message ?? '', /当前对话中没有这个派活任务/);
    assert.equal(codex.clients[1]?.calls.some((call) => call.method === 'turn/steer'), false);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
    useButler.getState().reset();
  }
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
      'thread/goal/set',
      'thread/name/set',
      'turn/start',
    ]);
    const thread = codex.clients[0]?.calls.find((call) => call.method === 'thread/start');
    assert.equal(thread?.params.ephemeral, false);
    assert.equal(thread?.params.approvalPolicy, 'on-request');
    assert.equal(thread?.params.approvalsReviewer, 'auto_review');
    assert.deepEqual(thread?.params.config, {
      mcp_servers: {
        rocketx_business: {
          command: 'C:/Program Files/RocketX/rocketx.exe',
          args: ['--business-mcp'],
        },
      },
    });
    assert.match(String(thread?.params.developerInstructions ?? ''), /可独立并行/);
    const goal = codex.clients[0]?.calls.find((call) => call.method === 'thread/goal/set');
    assert.deepEqual(goal?.params, {
      threadId: 'thread-1',
      objective: '修复未捕获异常。',
      status: 'active',
    });
    const turn = codex.clients[0]?.calls.find((call) => call.method === 'turn/start');
    assert.equal(turn?.params.approvalPolicy, 'on-request');
    assert.equal(turn?.params.approvalsReviewer, 'auto_review');
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
    assert.equal(useUI.getState().butlerView, 'tasks', '提示必须直接打开能处理审批的委托视图');
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
    codex.setGoalStatus(0, 'complete');
    codex.notify(0, 'turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    });
    await flushErrandEvents();

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

test('running 上的 steer：有 active turn 时用 turn/steer，带 expectedTurnId', async () => {
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
      { title: '边跑边加约束', goal: '', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
    );
    await useButlerErrandRuns.getState().steerErrand(run.id, '别改后端，只改前端。');
    const steer = codex.clients[0]?.calls.find((call) => call.method === 'turn/steer');
    assert.deepEqual(steer?.params, {
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: '别改后端，只改前端。', text_elements: [] }],
    });
    assert.equal(codex.clients[0]?.calls.filter((call) => call.method === 'turn/start').length, 1);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('running 上的 steer：当前没有 active turn 时，复用同一 thread 新开 turn/start', async () => {
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
      { title: '补一句后续指令', goal: '持续完成', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
    );
    codex.notify(0, 'turn/completed', {
      threadId: run.threadId,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await flushErrandEvents();
    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'running');

    await useButlerErrandRuns.getState().steerErrand(run.id, '继续把剩下的验收补齐。');

    const turnStarts = codex.clients[0]?.calls.filter((call) => call.method === 'turn/start') ?? [];
    assert.equal(turnStarts.length, 2);
    assert.equal(((turnStarts[1]?.params.input as Array<{ text: string }> | undefined)?.[0]?.text) ?? '', '继续把剩下的验收补齐。');
    assert.equal(codex.clients[0]?.calls.some((call) => call.method === 'turn/steer'), false);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
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

    codex.notify(0, 'item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'subAgentActivity',
        id: 'subagent-activity-1',
        kind: 'started',
        agentThreadId: 'child-thread-1',
        agentPath: 'research',
      },
    });
    assert.equal(useButler.getState().errands[0]?.activity, '正在分头处理');

    await useButler.getState().stopErrand(run.id);
    assert.deepEqual(
      codex.clients[0]?.calls.filter((call) => call.method === 'thread/goal/set').at(-1)?.params,
      { threadId: 'thread-1', status: 'paused' },
    );
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

test('原生 Goal 仍 active 时不把首轮回复误报成完成，并让 Codex 自动续跑到 complete', async () => {
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
      { title: '持续完成目标', goal: '做到验收条件全部通过', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
    );
    codex.notify(0, 'item/agentMessage/delta', {
      threadId: run.threadId,
      turnId: 'turn-1',
      delta: '第一轮还没做完。',
    });
    codex.notify(0, 'turn/completed', {
      threadId: run.threadId,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'running');
    assert.equal(codex.clients[0]?.stopped, false);
    assert.ok(codex.clients[0]?.calls.some((call) => call.method === 'thread/goal/get'));

    codex.setGoalStatus(0, 'complete');
    codex.setHistoryReply(0, '验收已经通过，持久历史完整。');
    codex.notify(0, 'item/agentMessage/delta', {
      threadId: run.threadId,
      turnId: 'turn-2',
      delta: '验收已经通过',
    });
    codex.notify(0, 'turn/completed', {
      threadId: run.threadId,
      turn: { id: 'turn-2', status: 'completed' },
    });
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(useButlerErrandRuns.getState().runs[0]?.reply, '验收已经通过，持久历史完整。');
    assert.ok(codex.clients[0]?.calls.some((call) => call.method === 'thread/read'));
    assert.equal(codex.clients[0]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('最终答复已完成但 turn/completed 丢失时，仍按 complete Goal 回收结果', async () => {
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
      { title: '只读检查工作区', goal: '返回工作区概况', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
      { readOnly: true },
    );
    codex.setGoalStatus(0, 'complete');
    codex.setHistoryReply(0, 'README 主标题是 RocketX。');
    codex.notify(0, 'item/agentMessage/delta', {
      threadId: run.threadId,
      turnId: 'turn-1',
      delta: 'README 主标题是 RocketX。',
    });
    codex.notify(0, 'item/completed', {
      threadId: run.threadId,
      item: {
        type: 'agentMessage',
        id: 'final-answer-1',
        text: 'README 主标题是 RocketX。',
        phase: null,
      },
    });
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(useButlerErrandRuns.getState().runs[0]?.reply, 'README 主标题是 RocketX。');
    assert.ok(codex.clients[0]?.calls.some((call) => call.method === 'thread/goal/get'));
    assert.equal(codex.clients[0]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('最终答复只有增量且终态通知丢失时，仍按 complete Goal 回收结果', async () => {
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
      { title: '只读复核工作区', goal: '返回工作区概况', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
      { readOnly: true },
    );
    codex.setGoalStatus(0, 'complete');
    codex.setHistoryReply(0, 'README 主标题是 RocketX。');
    codex.notify(0, 'item/agentMessage/delta', {
      threadId: run.threadId,
      turnId: 'turn-1',
      delta: 'README 主标题是 RocketX。',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(useButlerErrandRuns.getState().runs[0]?.reply, 'README 主标题是 RocketX。');
    assert.ok(codex.clients[0]?.calls.some((call) => call.method === 'thread/goal/get'));
    assert.equal(codex.clients[0]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('commentary 完成后其余通知中断时，重新挂起 Goal 复核并回收持久结果', async () => {
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
      { title: '恢复 commentary 后的终态', goal: '返回工作区概况', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
      { readOnly: true },
    );
    codex.setGoalStatus(0, 'complete');
    codex.setHistoryReply(0, 'README 主标题是 RocketX，目录枚举包含 .git。');
    codex.notify(0, 'item/completed', {
      threadId: run.threadId,
      turnId: 'turn-1',
      item: {
        type: 'agentMessage',
        id: 'commentary-1',
        text: '我正在进行只读检查。',
        phase: 'commentary',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 6_200));
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(
      useButlerErrandRuns.getState().runs[0]?.reply,
      'README 主标题是 RocketX，目录枚举包含 .git。',
    );
    assert.ok(codex.clients[0]?.calls.some((call) => call.method === 'thread/goal/get'));
    assert.equal(codex.clients[0]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('旧控制通道仍返回 active 时，旁路探测持久线程并回收已完成结果', async () => {
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
      { title: '旁路回收持久结果', goal: '返回 README 标题', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
      { readOnly: true },
    );
    codex.setGoalStatus(0, 'active');
    codex.setGoalStatus(1, 'complete');
    codex.setHistoryReply(1, 'README 主标题是 RocketX。');
    codex.notify(0, 'item/completed', {
      threadId: run.threadId,
      turnId: 'turn-1',
      item: {
        type: 'agentMessage',
        id: 'commentary-1',
        text: '我正在读取 README。',
        phase: 'commentary',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(useButlerErrandRuns.getState().runs[0]?.reply, 'README 主标题是 RocketX。');
    assert.equal(codex.clients.length, 2);
    assert.ok(codex.clients[1]?.calls.some((call) => call.method === 'thread/resume'));
    assert.ok(codex.clients[1]?.calls.some((call) => call.method === 'thread/read'));
    assert.ok(
      codex.events.indexOf('request:1:thread/resume') < codex.events.indexOf('stop:0'),
      '旁路探测必须在停止原控制通道之前完成 thread/resume',
    );
    assert.equal(codex.clients[0]?.stopped, true);
    assert.equal(codex.clients[1]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('旁路先看到 complete 但最终答复尚未落盘时，继续等待而不回收空结果', async () => {
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
      { title: '等待最终答复落盘', goal: '返回 README 第一行', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
      { readOnly: true },
    );
    codex.setGoalStatus(0, 'active');
    codex.setGoalStatus(1, 'complete');
    codex.notify(0, 'item/completed', {
      threadId: run.threadId,
      turnId: 'turn-1',
      item: {
        type: 'agentMessage',
        id: 'commentary-1',
        text: '我将只读读取 README 第一行。',
        phase: 'commentary',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'running');
    assert.equal(codex.clients[0]?.stopped, false);
    assert.equal(codex.clients[1]?.stopped, true);

    codex.setGoalStatus(2, 'complete');
    codex.setHistoryReply(2, '# RocketX');
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(useButlerErrandRuns.getState().runs[0]?.reply, '# RocketX');
    assert.equal(codex.clients.length, 3);
    assert.equal(codex.clients[0]?.stopped, true);
    assert.equal(codex.clients[2]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('commentary 后控制通道连续失联时，旁路 app-server 从原线程回收结果', async () => {
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
      { title: '恢复失联控制通道', goal: '返回工作区概况', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
      { readOnly: true },
    );
    codex.failMethod(0, 'thread/goal/get');
    codex.setGoalStatus(1, 'complete');
    codex.setHistoryReply(1, 'README 主标题是 RocketX，目录枚举包含 .git。');
    codex.notify(0, 'item/completed', {
      threadId: run.threadId,
      turnId: 'turn-1',
      item: {
        type: 'agentMessage',
        id: 'commentary-1',
        text: '我正在进行只读检查。',
        phase: 'commentary',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 6_400));
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(
      useButlerErrandRuns.getState().runs[0]?.reply,
      'README 主标题是 RocketX，目录枚举包含 .git。',
    );
    assert.equal(codex.clients.length, 2);
    assert.equal(codex.clients[0]?.stopped, true);
    assert.ok(codex.clients[1]?.calls.some((call) => call.method === 'thread/resume'));
    assert.equal(codex.clients[1]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('turn/completed 后 Goal 查询失联时，从原线程自动回收已完成结果', async () => {
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
      { title: '恢复已结束回合', goal: '返回工作区概况', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
      { readOnly: true },
    );
    codex.failMethod(0, 'thread/goal/get');
    codex.setGoalStatus(1, 'complete');
    codex.setHistoryReply(1, 'README 主标题是 RocketX，目录枚举包含 .git。');
    codex.notify(0, 'item/completed', {
      threadId: run.threadId,
      turnId: 'turn-1',
      item: {
        type: 'agentMessage',
        id: 'commentary-1',
        text: '我正在进行只读检查。',
        phase: 'commentary',
      },
    });
    codex.notify(0, 'turn/completed', {
      threadId: run.threadId,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(
      useButlerErrandRuns.getState().runs[0]?.reply,
      'README 主标题是 RocketX，目录枚举包含 .git。',
    );
    assert.equal(codex.clients.length, 2);
    assert.equal(codex.clients[0]?.stopped, true);
    assert.ok(codex.clients[1]?.calls.some((call) => call.method === 'thread/resume'));
    assert.equal(codex.clients[1]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('Goal 已完成但最终消息通知全部丢失时，仍从持久历史回收结果', async () => {
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
      { title: '只读终态复核', goal: '返回工作区概况', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
      { readOnly: true },
    );
    codex.setGoalStatus(0, 'complete');
    codex.setHistoryReply(0, 'README 主标题是 RocketX，共有 17 个一级目录。');
    codex.notify(0, 'thread/goal/updated', {
      threadId: run.threadId,
      turnId: 'turn-1',
      goal: { status: 'complete' },
    });
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(
      useButlerErrandRuns.getState().runs[0]?.reply,
      'README 主标题是 RocketX，共有 17 个一级目录。',
    );
    assert.ok(codex.clients[0]?.calls.some((call) => call.method === 'thread/read'));
    assert.equal(codex.clients[0]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('所有终态通知都丢失时，仍主动复核 complete Goal 并回收结果', async () => {
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
    await useButlerErrandRuns.getState().dispatchErrand(
      { title: '主动复核终态', goal: '返回工作区概况', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
      { readOnly: true },
    );
    codex.setGoalStatus(0, 'complete');
    codex.setHistoryReply(0, 'README 主标题是 RocketX，且执行过程只读。');
    await new Promise((resolve) => setTimeout(resolve, 10_200));
    await flushErrandEvents();

    assert.equal(useButlerErrandRuns.getState().runs[0]?.status, 'replied');
    assert.equal(
      useButlerErrandRuns.getState().runs[0]?.reply,
      'README 主标题是 RocketX，且执行过程只读。',
    );
    assert.ok(codex.clients[0]?.calls.some((call) => call.method === 'thread/goal/get'));
    assert.equal(codex.clients[0]?.stopped, true);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('本轮已完成但 Goal 暂时读不到时安全暂停，不继续伪装成运行中', async () => {
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
      { title: '确认目标状态', goal: '完成后核对真实状态', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
    );
    codex.failMethod(0, 'thread/goal/get');
    codex.notify(0, 'item/agentMessage/delta', {
      threadId: run.threadId,
      turnId: 'turn-1',
      delta: '本轮已经结束。',
    });
    codex.notify(0, 'turn/completed', {
      threadId: run.threadId,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await flushErrandEvents();

    const paused = useButlerErrandRuns.getState().runs.find((item) => item.id === run.id);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.activity, undefined);
    assert.deepEqual(paused?.approvals, []);
    assert.equal(paused?.threadId, run.threadId);
    assert.equal(paused?.workspaceRoot, environment.path);
    assert.match(paused?.error ?? '', /暂时无法确认/);
    assert.match(paused?.error ?? '', /安全暂停|手动继续/);
    assert.equal(codex.clients[0]?.stopped, true);
    assert.equal(codex.clients[0]?.calls.filter((call) => call.method === 'turn/start').length, 1);

    const persisted = JSON.parse(storageEntries.get('rcx-butler-errand-runs') ?? '[]') as Array<{
      id: string;
      status: string;
      error?: string;
    }>;
    const persistedRun = persisted.find((item) => item.id === run.id);
    assert.equal(persistedRun?.status, 'paused');
    assert.match(persistedRun?.error ?? '', /暂时无法确认/);
    const recovered = recoverPersistedButlerErrands(persisted)
      .find((item) => item.id === run.id);
    assert.equal(recovered?.status, 'paused');
    assert.match(recovered?.error ?? '', /暂时无法确认/);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('已有持久线程的 app-server 意外中断只暂停目标任务，不污染其他任务', async () => {
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
    const interruptedRun = await useButlerErrandRuns.getState().dispatchErrand(
      { title: '处理可恢复任务', goal: '保留原线程', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
    );
    const siblingRun = await useButlerErrandRuns.getState().dispatchErrand(
      { title: '处理另一个任务', goal: '不能被串扰', acceptance: [], boundaries: [], evidence: [] },
      { id: environment.id, name: environment.name, path: environment.path },
    );
    const interruptedApproval = codex.requestApproval(0, 'item/commandExecution/requestApproval', {
      threadId: interruptedRun.threadId,
      command: 'pnpm test:regression',
    });

    codex.clients[0]?.options.onInterrupted?.(new Error('Codex app-server 已退出（137）'));

    const interrupted = useButlerErrandRuns.getState().runs.find((item) => item.id === interruptedRun.id);
    const sibling = useButlerErrandRuns.getState().runs.find((item) => item.id === siblingRun.id);
    assert.equal(interrupted?.status, 'paused');
    assert.equal(interrupted?.activity, undefined);
    assert.deepEqual(interrupted?.approvals, []);
    assert.equal(interrupted?.threadId, interruptedRun.threadId);
    assert.match(interrupted?.error ?? '', /连接已中断/);
    assert.match(interrupted?.error ?? '', /手动继续/);
    await assert.rejects(interruptedApproval, /Codex app-server 已退出/);
    assert.equal(sibling?.status, 'running');
    assert.equal(codex.clients[0]?.calls.filter((call) => call.method === 'turn/start').length, 1);
    assert.equal(codex.clients[1]?.calls.filter((call) => call.method === 'turn/start').length, 1);
    const persisted = JSON.parse(storageEntries.get('rcx-butler-errand-runs') ?? '[]') as Array<{
      id: string;
      status: string;
      error?: string;
    }>;
    const persistedInterrupted = persisted.find((item) => item.id === interruptedRun.id);
    assert.equal(persistedInterrupted?.status, 'paused');
    assert.match(persistedInterrupted?.error ?? '', /连接已中断/);
    const recoveredInterrupted = recoverPersistedButlerErrands(persisted)
      .find((item) => item.id === interruptedRun.id);
    assert.equal(recoveredInterrupted?.status, 'paused');
    assert.match(recoveredInterrupted?.error ?? '', /手动继续/);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
  }
});

test('尚未取得 threadId 的启动中断直接报错，不创建可恢复的 paused 任务', async () => {
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
  codex.interruptMethod(0, 'thread/start');
  try {
    await assert.rejects(
      () => useButlerErrandRuns.getState().dispatchErrand(
        { title: '启动前就中断', goal: '不能声称可恢复', acceptance: [], boundaries: [], evidence: [] },
        { id: environment.id, name: environment.name, path: environment.path },
      ),
      /thread\/start 期间 Codex app-server 已退出/,
    );

    assert.deepEqual(useButlerErrandRuns.getState().runs, []);
    const persisted = JSON.parse(storageEntries.get('rcx-butler-errand-runs') ?? '[]') as Array<{
      status: string;
    }>;
    assert.equal(persisted.some((run) => run.status === 'paused'), false);
    assert.equal(codex.clients[0]?.calls.some((call) => call.method === 'turn/start'), false);
  } finally {
    codex.restore();
    await useButlerErrandRuns.getState().reset();
    resetEnvironments();
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
    { ...base, id: 'paused', title: '暂停中', status: 'paused', startedAt: 7 },
    { ...base, id: 'running-old', title: '较早在跑', status: 'running', startedAt: 2 },
    { ...base, id: 'waiting', title: '等你点头', status: 'awaiting-approval', startedAt: 1 },
    { ...base, id: 'running-new', title: '较晚在跑', status: 'running', startedAt: 8 },
  ]);
  assert.deepEqual(
    ordered.map((run) => run.id),
    ['waiting', 'running-new', 'running-old', 'paused', 'failed', 'replied'],
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
    codex.setGoalStatus(0, 'complete');
    codex.notify(0, 'turn/completed', {
      threadId: run.threadId,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await flushErrandEvents();
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
