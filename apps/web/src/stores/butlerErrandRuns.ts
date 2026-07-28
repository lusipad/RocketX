import { create } from 'zustand';
import {
  AppServerClient,
  TauriCodexTransport,
  type AppServerClientOptions,
  type ServerRequestPolicy,
} from '../agent/protocol';
import { renderDispatchSpec, type DispatchSpec } from '../agent/dispatchSpec';
import { rocketxThreadName, workspaceLabel } from '../agent/threadName';
import {
  commandRequestMentionsSensitivePath,
  redactAgentOutput,
  validateApprovalPaths,
  validatePermissionRequest,
} from '../agent/safety';
import { getAgentHostingCodexSettings } from '../lib/agentHostingSettings';
import { isTauri } from '../lib/http';
import {
  assertRegisteredWorkspace,
  type DispatchTarget,
} from '../lib/dispatchWorkspaces';
import {
  currentErrandActivity,
  BUTLER_ERRAND_LIMIT,
  BUTLER_ERRAND_TRACE_LIMIT,
  type ButlerErrandApproval,
  type ButlerErrandPlanStep,
  type ButlerErrandRun,
  type ButlerErrandTrace,
  type DispatchErrandOptions,
  visibleButlerErrands,
} from '../lib/butlerErrands';
import { useAgentEnvironments } from './agentEnvironments';
import { toast } from './toast';
import { useUI } from './ui';

const APPROVAL_POLICY = {
  granular: {
    sandbox_approval: true,
    rules: false,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: false,
  },
} as const;
const ERRAND_RUNS_KEY = 'rcx-butler-errand-runs';
const PERSISTED_RUN_LIMIT = 50;

type SandboxMode = 'read-only' | 'workspace-write';

interface ButlerErrandRuntime {
  sessionId: string;
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  threadId?: string;
  activeTurnId?: string;
}

interface ButlerErrandRunsState {
  runs: ButlerErrandRun[];
  visibleRuns: ButlerErrandRun[];
  dispatchErrand: (
    spec: DispatchSpec,
    target: DispatchTarget,
    options?: DispatchErrandOptions,
  ) => Promise<ButlerErrandRun>;
  resolveApproval: (runId: string, approvalId: string, approved: boolean) => Promise<void>;
  stopErrand: (runId: string) => Promise<void>;
  archiveErrand: (runId: string) => Promise<void>;
  reset: () => Promise<void>;
}

type ApprovalWaiter = {
  runId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ErrandClientFactory = (
  sessionId: string,
  workspaceRoot: string,
  options: AppServerClientOptions,
) => Promise<AppServerClient>;

const clients = new Map<string, AppServerClient>();
const clientStarts = new Map<string, Promise<AppServerClient>>();
const runtimes = new Map<string, ButlerErrandRuntime>();
const turnBuffers = new Map<string, { runId: string; text: string }>();
const fileChangePaths = new Map<string, { runId: string; paths: string[] }>();
const approvalWaiters = new Map<string, ApprovalWaiter>();
const expectedStops = new Set<string>();

let errandClientFactory: ErrandClientFactory = async (sessionId, workspaceRoot, options) => {
  if (!isTauri) throw new Error('派活仅支持 RocketX 桌面端');
  const client = new AppServerClient(new TauriCodexTransport(sessionId, workspaceRoot), options);
  await client.start();
  return client;
};

function id(prefix: string): string {
  const value = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  return `${prefix}-${value}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeText(value: unknown): string {
  return redactAgentOutput(value instanceof Error ? value.message : String(value)).text;
}

function planSteps(value: unknown): ButlerErrandPlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const step = record(item);
    const text = typeof step.step === 'string' ? step.step.trim() : '';
    const status = step.status;
    if (!text || (status !== 'pending' && status !== 'inProgress' && status !== 'completed')) return [];
    return [{ step: text, status }];
  });
}

function runItemKey(runId: string, itemId: string): string {
  return `${runId}:${itemId}`;
}

function awayFromButler(): boolean {
  return useUI.getState().module !== 'butler-view';
}

function goLookAction() {
  return { label: '去看看', onClick: () => useUI.getState().setModule('butler-view') };
}

function sandboxPolicy(mode: SandboxMode, workspaceRoot: string) {
  return mode === 'workspace-write'
    ? {
        type: 'workspaceWrite' as const,
        writableRoots: [workspaceRoot],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    : { type: 'readOnly' as const, networkAccess: false };
}

function visibleRuns(runs: readonly ButlerErrandRun[]): ButlerErrandRun[] {
  return visibleButlerErrands(runs);
}

export function recoverPersistedButlerErrands(value: unknown, now = Date.now()): ButlerErrandRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const run = candidate as Partial<ButlerErrandRun>;
    if (
      typeof run.id !== 'string'
      || typeof run.title !== 'string'
      || typeof run.threadId !== 'string'
      || typeof run.workspaceRoot !== 'string'
      || typeof run.workspaceName !== 'string'
      || typeof run.readOnly !== 'boolean'
      || typeof run.startedAt !== 'number'
      || !['running', 'awaiting-approval', 'replied', 'failed'].includes(run.status ?? '')
      || !Array.isArray(run.approvals)
      || !Array.isArray(run.traces)
    ) return [];
    if (run.status === 'running' || run.status === 'awaiting-approval') {
      return [{
        ...run,
        status: 'failed',
        activity: undefined,
        approvals: [],
        error: 'RocketX 重启时这次执行中断；原责任和记录已保留，请确认后重新执行。',
        traces: [...run.traces, {
          id: `trace-recovery-${run.id}`,
          at: now,
          kind: 'warning' as const,
          text: '重启后未恢复原执行，为避免重复外部动作，已安全停在待重试状态',
        }].slice(-BUTLER_ERRAND_TRACE_LIMIT),
      } as ButlerErrandRun];
    }
    return [{ ...run, approvals: [] } as ButlerErrandRun];
  }).slice(-PERSISTED_RUN_LIMIT);
}

function readPersistedRuns(): ButlerErrandRun[] {
  try {
    const raw = localStorage.getItem(ERRAND_RUNS_KEY);
    return raw ? recoverPersistedButlerErrands(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function persistRuns(runs: readonly ButlerErrandRun[]): void {
  try {
    localStorage.setItem(ERRAND_RUNS_KEY, JSON.stringify(runs.slice(-PERSISTED_RUN_LIMIT)));
  } catch {
    // 运行状态仍保留在当前进程；存储不可用不能打断执行。
  }
}

const initialPersistedRuns = readPersistedRuns();

function setRuns(nextRuns: ButlerErrandRun[]): void {
  persistRuns(nextRuns);
  useButlerErrandRuns.setState({
    runs: nextRuns,
    visibleRuns: visibleRuns(nextRuns),
  });
}

function upsertRun(run: ButlerErrandRun): ButlerErrandRun {
  const state = useButlerErrandRuns.getState();
  const index = state.runs.findIndex((item) => item.id === run.id);
  const nextRuns = index === -1
    ? [...state.runs, run]
    : state.runs.map((item, currentIndex) => currentIndex === index ? run : item);
  setRuns(nextRuns);
  return run;
}

function updateRun(
  runId: string,
  updater: (run: ButlerErrandRun) => ButlerErrandRun,
): ButlerErrandRun | undefined {
  const current = useButlerErrandRuns.getState().runs.find((item) => item.id === runId);
  if (!current) return undefined;
  const next = updater(current);
  upsertRun(next);
  return next;
}

function removeRun(runId: string): void {
  const state = useButlerErrandRuns.getState();
  const nextRuns = state.runs.filter((item) => item.id !== runId);
  if (nextRuns.length === state.runs.length) return;
  setRuns(nextRuns);
}

function traceRun(runId: string, kind: ButlerErrandTrace['kind'], text: string): void {
  updateRun(runId, (run) => {
    const traces = [...run.traces, { id: id('trace'), at: Date.now(), kind, text }].slice(
      -BUTLER_ERRAND_TRACE_LIMIT,
    );
    return {
      ...run,
      traces,
      ...(kind === 'tool' ? { activity: currentErrandActivity(traces) } : {}),
    };
  });
}

function rejectApprovalWaiters(runId: string, error: Error): void {
  for (const [approvalId, waiter] of approvalWaiters) {
    if (waiter.runId !== runId) continue;
    waiter.reject(error);
    approvalWaiters.delete(approvalId);
  }
}

function cleanupRunBuffers(runId: string): void {
  for (const [turnId, buffer] of turnBuffers) {
    if (buffer.runId === runId) turnBuffers.delete(turnId);
  }
  for (const [itemId, tracked] of fileChangePaths) {
    if (tracked.runId === runId) fileChangePaths.delete(itemId);
  }
}

function markRunTerminal(
  runId: string,
  patch: Partial<Pick<ButlerErrandRun, 'reply' | 'error' | 'activity'>>,
  status: 'replied' | 'failed',
): void {
  const run = updateRun(runId, (current) => ({
    ...current,
    ...patch,
    status,
    approvals: [],
  }));
  if (!run) return;
  if (awayFromButler()) {
    toast.info(
      status === 'replied' ? `「${run.title}」回话了` : `「${run.title}」停下来了`,
      goLookAction(),
    );
  }
}

function onInterrupted(runId: string, error: Error): void {
  clients.delete(runId);
  clientStarts.delete(runId);
  cleanupRunBuffers(runId);
  rejectApprovalWaiters(runId, error);
  if (expectedStops.delete(runId)) return;
  const message = safeText(error);
  updateRun(runId, (run) => ({
    ...run,
    status: 'failed',
    activity: undefined,
    error: message,
    approvals: [],
  }));
  traceRun(runId, 'error', message);
}

async function onServerRequest(runId: string, request: {
  method: string;
  params: unknown;
  policy: ServerRequestPolicy | 'unknown';
}): Promise<unknown> {
  const params = record(request.params);
  const runtime = runtimes.get(runId);
  if (!runtime) throw new Error('派活会话不存在');
  if (typeof params.threadId === 'string' && runtime.threadId && params.threadId !== runtime.threadId) {
    throw new Error('请求不属于当前派活线程');
  }
  if (request.policy === 'unknown') throw new Error('未知服务端请求已被安全拒绝');
  if (request.policy === 'safe-reject' || request.policy === 'dynamic-tool' || request.policy === 'host-input') {
    throw new Error('该请求类型在派活会话中默认禁用');
  }
  const actionable = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ]);
  if (!actionable.has(request.method)) throw new Error('该请求类型没有安全的审批表单');
  const tracked = typeof params.itemId === 'string'
    ? fileChangePaths.get(runItemKey(runId, params.itemId))?.paths
    : undefined;
  if (request.method === 'item/fileChange/requestApproval' && !tracked?.length && typeof params.grantRoot !== 'string') {
    throw new Error('文件变更请求缺少可核验路径');
  }
  const approval: ButlerErrandApproval = {
    id: id('approval'),
    method: request.method,
    policy: request.policy,
    params: tracked?.length
      ? { ...params, fileChanges: Object.fromEntries(tracked.map((path) => [path, true])) }
      : request.params,
    at: Date.now(),
  };
  const previous = updateRun(runId, (run) => ({
    ...run,
    approvals: [...run.approvals, approval],
    status: 'awaiting-approval',
    activity: undefined,
  }));
  traceRun(runId, 'tool', `等待审批：${request.method}`);
  if (previous && previous.approvals.length === 1 && awayFromButler()) {
    toast.info(`「${previous.title}」等你点个头`, goLookAction());
  }
  return new Promise((resolve, reject) => approvalWaiters.set(approval.id, { runId, resolve, reject }));
}

function onNotification(runId: string, method: string, value: unknown): void {
  const params = record(value);
  const runtime = runtimes.get(runId);
  if (!runtime) return;
  if (typeof params.threadId === 'string' && runtime.threadId && params.threadId !== runtime.threadId) return;

  if (method === 'item/agentMessage/delta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : '';
    const delta = typeof params.delta === 'string' ? params.delta : '';
    const key = runItemKey(runId, turnId);
    const previous = turnBuffers.get(key);
    turnBuffers.set(key, { runId, text: `${previous?.text ?? ''}${delta}` });
    return;
  }

  if (method === 'turn/started') {
    const turn = record(params.turn);
    if (typeof turn.id === 'string') runtime.activeTurnId = turn.id;
    updateRun(runId, (run) => ({
      ...run,
      status: run.approvals.length > 0 ? 'awaiting-approval' : 'running',
      activity: run.activity ?? '正在处理',
    }));
    traceRun(runId, 'status', 'Codex 正在处理指令');
    return;
  }

  if (method === 'turn/plan/updated') {
    updateRun(runId, (run) => ({
      ...run,
      plan: planSteps(params.plan),
    }));
    return;
  }

  if (method === 'turn/completed') {
    const turn = record(params.turn);
    const turnId = typeof turn.id === 'string' ? turn.id : '';
    const turnStatus = typeof turn.status === 'string' ? turn.status : 'completed';
    const key = runItemKey(runId, turnId);
    const output = redactAgentOutput(turnBuffers.get(key)?.text.trim() ?? '');
    turnBuffers.delete(key);
    if (turnStatus === 'completed') {
      markRunTerminal(
        runId,
        output.text
          ? { reply: output.redacted ? `${output.text}\n\n（已脱敏 ${output.redacted} 处）` : output.text, activity: undefined }
          : { activity: undefined },
        'replied',
      );
    } else {
      markRunTerminal(
        runId,
        { activity: undefined, ...(output.text ? { reply: output.text } : {}), error: `本轮未完成（${turnStatus}）` },
        'failed',
      );
    }
    traceRun(runId, 'status', `本轮结束：${turnStatus}`);
    void stopClient(runId).catch(() => undefined);
    return;
  }

  if (method === 'item/started' || method === 'item/completed') {
    const item = record(params.item);
    const type = typeof item.type === 'string' ? item.type : 'tool';
    if (type === 'fileChange' && typeof item.id === 'string') {
      const key = runItemKey(runId, item.id);
      if (method === 'item/started' && Array.isArray(item.changes)) {
        fileChangePaths.set(key, {
          runId,
          paths: item.changes
            .map((change) => record(change).path)
            .filter((path): path is string => typeof path === 'string'),
        });
      } else {
        fileChangePaths.delete(key);
      }
    }
    traceRun(runId, 'tool', `${method === 'item/started' ? '开始' : '完成'}：${type}`);
    return;
  }

  if (method === 'warning' || method === 'error') {
    const message = safeText(JSON.stringify(params).slice(0, 1_000));
    if (method === 'error') {
      updateRun(runId, (run) => ({ ...run, error: message }));
    }
    traceRun(runId, method === 'error' ? 'error' : 'warning', message);
    return;
  }

}

async function ensureClient(runId: string): Promise<AppServerClient> {
  const current = clients.get(runId);
  if (current) return current;
  const pending = clientStarts.get(runId);
  if (pending) return pending;
  const runtime = runtimes.get(runId);
  if (!runtime) throw new Error('派活运行时不存在');
  const start = errandClientFactory(runtime.sessionId, runtime.workspaceRoot, {
    onNotification: (method, params) => onNotification(runId, method, params),
    onServerRequest: (request) => onServerRequest(runId, request),
    onInterrupted: (error) => onInterrupted(runId, error),
  }).then((client) => {
    clients.set(runId, client);
    return client;
  });
  clientStarts.set(runId, start);
  try {
    return await start;
  } finally {
    clientStarts.delete(runId);
  }
}

async function stopClient(runId: string): Promise<void> {
  const pending = clientStarts.get(runId);
  let current = clients.get(runId);
  expectedStops.add(runId);
  clients.delete(runId);
  clientStarts.delete(runId);
  if (!current && pending) current = await pending.catch(() => undefined);
  try {
    if (current) await current.stop().catch(() => undefined);
  } finally {
    expectedStops.delete(runId);
    cleanupRunBuffers(runId);
  }
}

async function startErrandRun(
  runId: string,
  spec: DispatchSpec,
  workspaceRoot: string,
  readOnly: boolean,
): Promise<{ threadId: string }> {
  const runtime = runtimes.get(runId);
  if (!runtime) throw new Error('派活运行时不存在');
  const appServer = await ensureClient(runId);
  const codexSettings = getAgentHostingCodexSettings();
  const threadResponse = await appServer.request('thread/start', {
    ...(codexSettings.model ? { model: codexSettings.model } : {}),
    cwd: workspaceRoot,
    runtimeWorkspaceRoots: [workspaceRoot],
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: 'user',
    sandbox: readOnly ? 'read-only' : 'workspace-write',
  });
  runtime.threadId = threadResponse.thread.id;
  const baseRun = updateRun(runId, (run) => ({
    ...run,
    threadId: threadResponse.thread.id,
    status: 'running',
  }));
  if (!baseRun) throw new Error('派活记录丢失');
  void appServer.request('thread/name/set', {
    threadId: threadResponse.thread.id,
    name: rocketxThreadName('派活', `${spec.title} · ${workspaceLabel(workspaceRoot)}`),
  }).catch(() => undefined);
  const turnResponse = await appServer.request('turn/start', {
    ...(codexSettings.model ? { model: codexSettings.model } : {}),
    ...(codexSettings.effort === 'default' ? {} : { effort: codexSettings.effort }),
    threadId: threadResponse.thread.id,
    input: [{ type: 'text', text: renderDispatchSpec(spec), text_elements: [] }],
    cwd: workspaceRoot,
    runtimeWorkspaceRoots: [workspaceRoot],
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: 'user',
    sandboxPolicy: sandboxPolicy(runtime.sandboxMode, workspaceRoot),
  });
  runtime.activeTurnId = turnResponse.turn.id;
  updateRun(runId, (run) => ({
    ...run,
    status: 'running',
  }));
  return { threadId: threadResponse.thread.id };
}

export function setButlerErrandClientFactory(factory: ErrandClientFactory): () => void {
  const previous = errandClientFactory;
  errandClientFactory = factory;
  return () => {
    errandClientFactory = previous;
  };
}

export const useButlerErrandRuns = create<ButlerErrandRunsState>((set, get) => ({
  runs: initialPersistedRuns,
  visibleRuns: visibleRuns(initialPersistedRuns),

  dispatchErrand: async (spec, target, options = {}) => {
    const readOnly = options.readOnly === true;
    const environmentsStore = useAgentEnvironments.getState();
    let workspaceId = target.id;
    if (!workspaceId) {
      if (!target.pending) throw new Error('派活的目标必须是已添加的工作区。');
      workspaceId = environmentsStore.addEnvironment({
        name: target.name,
        path: target.path,
        adoProjects: [],
        defaultBaseBranch: '',
        branchPrefix: '',
      }).id;
    }
    const environment = assertRegisteredWorkspace(
      workspaceId,
      useAgentEnvironments.getState().environments,
    );
    const duplicate = get().runs.find((run) =>
      !run.archivedAt
      && run.workspaceRoot === environment.path
      && run.title === spec.title
      && (run.status === 'running' || run.status === 'awaiting-approval'));
    if (duplicate) throw new Error('这件活正在干，别重复派');
    if (visibleRuns(get().runs).length >= BUTLER_ERRAND_LIMIT) {
      throw new Error('手头 5 件了，收几件再派');
    }

    const runId = id('errand');
    const now = Date.now();
    const initialRun: ButlerErrandRun = {
      id: runId,
      title: spec.title,
      threadId: '',
      workspaceRoot: environment.path,
      workspaceName: environment.name,
      readOnly,
      startedAt: now,
      status: 'running',
      activity: '正在建立会话',
      approvals: [],
      traces: [],
      plan: [],
      ...(options?.roomContext ? { roomContext: options.roomContext } : {}),
    };
    runtimes.set(runId, {
      sessionId: id('errand-session'),
      workspaceRoot: environment.path,
      sandboxMode: readOnly ? 'read-only' : 'workspace-write',
    });
    upsertRun(initialRun);
    try {
      await startErrandRun(runId, spec, environment.path, readOnly);
      useAgentEnvironments.getState().rememberDispatchEnvironment(environment.id);
      const run = get().runs.find((item) => item.id === runId);
      if (!run) throw new Error('派活记录丢失');
      return run;
    } catch (error) {
      await stopClient(runId).catch(() => undefined);
      runtimes.delete(runId);
      removeRun(runId);
      throw error;
    }
  },

  resolveApproval: async (runId, approvalId, approved) => {
    const run = get().runs.find((item) => item.id === runId);
    const waiter = approvalWaiters.get(approvalId);
    if (!run || !waiter || waiter.runId !== runId) return;
    const approval = run.approvals.find((item) => item.id === approvalId);
    if (!approval) return;
    let accepted = approved;
    let permissions = {};
    const params = record(approval.params);
    if (accepted) {
      try {
        validateApprovalPaths(params, [run.workspaceRoot]);
        if (commandRequestMentionsSensitivePath(params.command)) throw new Error('命令涉及敏感路径');
        const requested = params.permissions ?? params.additionalPermissions;
        if (requested) {
          permissions = validatePermissionRequest(
            requested as Parameters<typeof validatePermissionRequest>[0],
            [run.workspaceRoot],
          );
        }
      } catch (error) {
        accepted = false;
        traceRun(runId, 'warning', error instanceof Error ? error.message : String(error));
      }
    }
    const decision =
      approval.method === 'item/permissions/requestApproval'
        ? { permissions: accepted ? permissions : {}, scope: 'turn', strictAutoReview: true }
        : approval.method.startsWith('item/')
          ? { decision: accepted ? 'accept' : 'decline' }
          : { decision: accepted ? 'approved' : 'denied' };
    approvalWaiters.delete(approvalId);
    updateRun(runId, (current) => {
      const approvals = current.approvals.filter((item) => item.id !== approvalId);
      const status: ButlerErrandRun['status'] = approvals.length > 0
        ? 'awaiting-approval'
        : current.status === 'replied' || current.status === 'failed'
          ? current.status
          : 'running';
      return {
        ...current,
        approvals,
        status,
      };
    });
    waiter.resolve(decision);
    traceRun(runId, 'status', accepted ? '已允许请求' : '已拒绝请求');
  },

  stopErrand: async (runId) => {
    const run = get().runs.find((item) => item.id === runId);
    if (!run || (run.status !== 'running' && run.status !== 'awaiting-approval')) return;
    const runtime = runtimes.get(runId);
    const pending = clientStarts.get(runId);
    const client = clients.get(runId) ?? (pending ? await pending.catch(() => undefined) : undefined);
    const activeTurnId = runtime?.activeTurnId;
    const partial = activeTurnId
      ? redactAgentOutput(turnBuffers.get(runItemKey(runId, activeTurnId))?.text.trim() ?? '')
      : { text: '', redacted: 0 };

    rejectApprovalWaiters(runId, new Error('这件活已叫停'));
    runtimes.delete(runId);
    if (client && runtime?.threadId && activeTurnId) {
      await client.request('turn/interrupt', {
        threadId: runtime.threadId,
        turnId: activeTurnId,
      }).catch(() => undefined);
    }
    markRunTerminal(
      runId,
      {
        ...(partial.text
          ? { reply: partial.redacted ? `${partial.text}\n\n（已脱敏 ${partial.redacted} 处）` : partial.text }
          : {}),
        error: '已叫停',
        activity: undefined,
      },
      'failed',
    );
    traceRun(runId, 'status', '你叫停了这件活');
    await stopClient(runId).catch(() => undefined);
  },

  archiveErrand: async (runId) => {
    const run = get().runs.find((item) => item.id === runId);
    if (!run || run.archivedAt) return;
    if (run.status !== 'replied' && run.status !== 'failed') return;
    updateRun(runId, (current) => ({
      ...current,
      archivedAt: Date.now(),
    }));
    await stopClient(runId).catch(() => undefined);
    runtimes.delete(runId);
  },

  reset: async () => {
    const runIds = [...runtimes.keys()];
    for (const runId of runIds) {
      rejectApprovalWaiters(runId, new Error('派活会话已重置'));
      await stopClient(runId).catch(() => undefined);
      runtimes.delete(runId);
    }
    turnBuffers.clear();
    fileChangePaths.clear();
    approvalWaiters.clear();
    persistRuns([]);
    set({ runs: [], visibleRuns: [] });
  },
}));

export async function dispatchButlerErrand(
  spec: DispatchSpec,
  target: DispatchTarget,
  options?: DispatchErrandOptions,
): Promise<ButlerErrandRun> {
  return useButlerErrandRuns.getState().dispatchErrand(spec, target, options);
}
