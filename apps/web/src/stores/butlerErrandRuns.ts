import { create } from 'zustand';
import {
  AppServerClient,
  TauriCodexTransport,
  type AppServerClientOptions,
  type ServerRequestPolicy,
} from '../agent/protocol';
import type { ThreadResumeResponse } from '../agent/protocol/generated/v2/ThreadResumeResponse';
import { businessMcpThreadConfig } from '../agent/businessMcp';
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
  type ButlerErrandInput,
  type ButlerErrandPlanStep,
  type ButlerErrandRun,
  type ButlerErrandTrace,
  type DispatchErrandOptions,
  visibleButlerErrands,
} from '../lib/butlerErrands';
import {
  isButlerErrandInputMethod,
  validateButlerErrandInputResponse,
  type ButlerErrandInputResponse,
} from '../lib/butlerHostInput';
import { useAgentEnvironments } from './agentEnvironments';
import { toast } from './toast';
import { useUI } from './ui';

const APPROVAL_POLICY = 'on-request' as const;
const ERRAND_RUNS_KEY = 'rcx-butler-errand-runs';
const PERSISTED_RUN_LIMIT = 50;
const ERRAND_DEVELOPER_INSTRUCTIONS = [
  '这是 RocketX 管家派出的持久任务。请直接完成目标并自行验证，不要把协调工作交还给用户。',
  '存在可独立并行、且能实质提高速度或质量的子任务时，使用 Codex 原生子代理并等待其结果。',
  '目标真正达成且没有剩余工作时，必须把当前 Goal 标记为 complete；否则保持 active 并继续处理。',
].join('\n');

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
  steerErrand: (runId: string, instruction: string) => Promise<void>;
  resumeErrand: (runId: string, instruction?: string) => Promise<void>;
  resolveApproval: (runId: string, approvalId: string, approved: boolean) => Promise<void>;
  resolveInput: (runId: string, inputId: string, response: ButlerErrandInputResponse) => Promise<void>;
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
const inputWaiters = new Map<string, ApprovalWaiter>();
const expectedStops = new Set<string>();
const settlingTurns = new Set<string>();
const turnSettleTimers = new Map<string, { runId: string; timer: ReturnType<typeof setTimeout> }>();
const goalPollTimers = new Map<string, { turnId: string; timer: ReturnType<typeof setTimeout> }>();
const resultProbeTimers = new Map<string, { turnId: string; timer: ReturnType<typeof setTimeout> }>();
const completedAgentSignals = new Set<string>();
const goalPollFailures = new Map<string, number>();
const probingPersistedResults = new Set<string>();
const resultProbeCompletionSeenAt = new Map<string, number>();
const FINAL_MESSAGE_IDLE_MS = 1_000;
const GOAL_RESULT_GRACE_MS = 5_000;
const GOAL_POLL_INTERVAL_MS = 5_000;
const GOAL_POLL_FAILURE_LIMIT = 2;

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
  return { label: '去看看', onClick: () => useUI.getState().setButlerView('tasks') };
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
      || !['running', 'paused', 'awaiting-approval', 'replied', 'failed'].includes(run.status ?? '')
      || !Array.isArray(run.approvals)
      || (run.inputs !== undefined && !Array.isArray(run.inputs))
      || !Array.isArray(run.traces)
    ) return [];
    const originSessionId = typeof run.originSessionId === 'string' && run.originSessionId.trim()
      ? run.originSessionId
      : undefined;
    if (run.status === 'running' || run.status === 'awaiting-approval') {
      return [{
        ...run,
        originSessionId,
        status: 'paused',
        activity: undefined,
        approvals: [],
        inputs: [],
        error: 'RocketX 重启时这次执行中断；原责任和记录已保留，请确认后手动继续。',
        traces: [...run.traces, {
          id: `trace-recovery-${run.id}`,
          at: now,
          kind: 'warning' as const,
          text: '重启后未恢复原执行，为避免重复外部动作，已安全停在暂停状态，等待你明确继续',
        }].slice(-BUTLER_ERRAND_TRACE_LIMIT),
      } as ButlerErrandRun];
    }
    return [{ ...run, originSessionId, approvals: [], inputs: [] } as ButlerErrandRun];
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

function rejectInputWaiters(runId: string, error: Error): void {
  for (const [inputId, waiter] of inputWaiters) {
    if (waiter.runId !== runId) continue;
    waiter.reject(error);
    inputWaiters.delete(inputId);
  }
}

function rejectInteractionWaiters(runId: string, error: Error): void {
  rejectApprovalWaiters(runId, error);
  rejectInputWaiters(runId, error);
}

function pendingInteractionCount(run: ButlerErrandRun): number {
  return run.approvals.length + (run.inputs?.length ?? 0);
}

function clearGoalPoll(runId: string): void {
  const pending = goalPollTimers.get(runId);
  if (!pending) return;
  clearTimeout(pending.timer);
  goalPollTimers.delete(runId);
}

function clearResultProbe(runId: string): void {
  const pending = resultProbeTimers.get(runId);
  if (!pending) return;
  clearTimeout(pending.timer);
  resultProbeTimers.delete(runId);
}

function cleanupRunBuffers(runId: string): void {
  for (const [turnId, buffer] of turnBuffers) {
    if (buffer.runId === runId) turnBuffers.delete(turnId);
  }
  for (const [itemId, tracked] of fileChangePaths) {
    if (tracked.runId === runId) fileChangePaths.delete(itemId);
  }
  for (const [turnId, pending] of turnSettleTimers) {
    if (pending.runId !== runId) continue;
    clearTimeout(pending.timer);
    turnSettleTimers.delete(turnId);
  }
  completedAgentSignals.delete(runId);
  goalPollFailures.delete(runId);
  resultProbeCompletionSeenAt.delete(runId);
  clearGoalPoll(runId);
  clearResultProbe(runId);
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
    inputs: [],
  }));
  if (!run) return;
  if (awayFromButler()) {
    toast.info(
      status === 'replied' ? `「${run.title}」回话了` : `「${run.title}」停下来了`,
      goLookAction(),
    );
  }
}

function goalStopMessage(status: string | undefined): string {
  if (status === 'paused') return '这件活已暂停';
  if (status === 'blocked') return '这件活遇到阻塞';
  if (status === 'usageLimited') return '这件活已达到使用限额';
  if (status === 'budgetLimited') return '这件活已达到预算上限';
  return 'Codex 没有返回这件活的目标状态';
}

async function readPersistedTurnReply(
  client: AppServerClient,
  threadId: string,
  turnId: string,
  allowCommentaryFallback = true,
): Promise<string> {
  const response = await client.request('thread/read', {
    threadId,
    includeTurns: true,
  });
  const turn = response.thread.turns.find((candidate) => candidate.id === turnId)
    ?? response.thread.turns.at(-1);
  if (!turn) return '';
  const messages = turn.items.filter((item) => item.type === 'agentMessage');
  const finalMessages = messages.filter((item) => item.phase !== 'commentary');
  if (!finalMessages.length && !allowCommentaryFallback) return '';
  return (finalMessages.length ? finalMessages : messages)
    .map((item) => item.text)
    .join('\n')
    .trim();
}

async function settleCompletedTurn(
  runId: string,
  turnId: string,
  turnStatus: string,
): Promise<void> {
  const key = runItemKey(runId, turnId);
  let output = redactAgentOutput(turnBuffers.get(key)?.text.trim() ?? '');
  turnBuffers.delete(key);
  if (turnStatus !== 'completed') {
    markRunTerminal(
      runId,
      { activity: undefined, ...(output.text ? { reply: output.text } : {}), error: `本轮未完成（${turnStatus}）` },
      'failed',
    );
    traceRun(runId, 'status', `本轮结束：${turnStatus}`);
    await stopClient(runId).catch(() => undefined);
    return;
  }

  const runtime = runtimes.get(runId);
  const client = clients.get(runId);
  if (!runtime?.threadId || !client) return;
  let goalStatus: string | undefined;
  try {
    const response = await client.request('thread/goal/get', { threadId: runtime.threadId });
    goalStatus = response.goal?.status;
  } catch (error) {
    if (completedAgentSignals.has(runId)) {
      traceRun(runId, 'warning', `原控制通道暂时无法确认结果，正在旁路核对持久线程：${safeText(error)}`);
      await probePersistedResult(runId, turnId);
      return;
    }
    const message = `本轮已结束，但结果暂时无法确认：${safeText(error)}。为避免重复执行，已安全暂停；请恢复连接后手动继续。`;
    updateRun(runId, (run) => ({
      ...run,
      status: 'paused',
      activity: undefined,
      approvals: [],
      inputs: [],
      error: message,
    }));
    traceRun(runId, 'warning', message);
    rejectInteractionWaiters(runId, new Error(message));
    runtimes.delete(runId);
    await stopClient(runId).catch(() => undefined);
    return;
  }

  const latestRuntime = runtimes.get(runId);
  if (!latestRuntime) return;
  if (latestRuntime.activeTurnId && latestRuntime.activeTurnId !== turnId) return;
  if (goalStatus === 'active') {
    updateRun(runId, (run) => ({
      ...run,
      status: pendingInteractionCount(run) > 0 ? 'awaiting-approval' : 'running',
      activity: '正在继续完成目标',
    }));
    traceRun(runId, 'status', '本轮结束，Codex 正在继续完成目标');
    scheduleGoalPoll(runId, turnId);
    return;
  }

  try {
    const persistedReply = await readPersistedTurnReply(client, runtime.threadId, turnId);
    if (persistedReply) output = redactAgentOutput(persistedReply);
  } catch (error) {
    traceRun(runId, 'warning', `读取持久执行记录失败：${safeText(error)}`);
  }
  const currentRuntime = runtimes.get(runId);
  if (!currentRuntime) return;
  if (currentRuntime.activeTurnId && currentRuntime.activeTurnId !== turnId) return;

  if (goalStatus === 'complete') {
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
      {
        activity: undefined,
        ...(output.text ? { reply: output.text } : {}),
        error: goalStopMessage(goalStatus),
      },
      'failed',
    );
  }
  traceRun(runId, 'status', `本轮结束：${goalStatus ?? 'unknown'}`);
  await stopClient(runId).catch(() => undefined);
}

function settleTurnOnce(runId: string, turnId: string, turnStatus: string): void {
  const key = runItemKey(runId, turnId);
  const pending = turnSettleTimers.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    turnSettleTimers.delete(key);
  }
  const run = useButlerErrandRuns.getState().runs.find((item) => item.id === runId);
  if (!run || run.status === 'replied' || run.status === 'failed' || settlingTurns.has(key)) return;
  settlingTurns.add(key);
  void settleCompletedTurn(runId, turnId, turnStatus).finally(() => settlingTurns.delete(key));
}

function scheduleTurnSettlement(
  runId: string,
  turnId: string,
  delayMs = FINAL_MESSAGE_IDLE_MS,
): void {
  const key = runItemKey(runId, turnId);
  const previous = turnSettleTimers.get(key);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    const pending = turnSettleTimers.get(key);
    if (pending?.timer !== timer) return;
    turnSettleTimers.delete(key);
    settleTurnOnce(runId, turnId, 'completed');
  }, delayMs);
  turnSettleTimers.set(key, { runId, timer });
}

function scheduleGoalPoll(
  runId: string,
  turnId: string,
  delayMs = GOAL_POLL_INTERVAL_MS,
): void {
  const previous = goalPollTimers.get(runId);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    const pending = goalPollTimers.get(runId);
    if (pending?.timer !== timer || pending.turnId !== turnId) return;
    goalPollTimers.delete(runId);
    void pollGoalCompletion(runId, turnId);
  }, delayMs);
  goalPollTimers.set(runId, { turnId, timer });
}

function scheduleResultProbe(
  runId: string,
  turnId: string,
  delayMs = GOAL_RESULT_GRACE_MS,
): void {
  if (resultProbeTimers.has(runId) || probingPersistedResults.has(runId)) return;
  const timer = setTimeout(() => {
    const pending = resultProbeTimers.get(runId);
    if (pending?.timer !== timer || pending.turnId !== turnId) return;
    resultProbeTimers.delete(runId);
    void probePersistedResult(runId, turnId);
  }, delayMs);
  resultProbeTimers.set(runId, { turnId, timer });
}

async function pollGoalCompletion(runId: string, turnId: string): Promise<void> {
  const run = useButlerErrandRuns.getState().runs.find((item) => item.id === runId);
  const runtime = runtimes.get(runId);
  const client = clients.get(runId);
  if (
    !run
    || run.status === 'replied'
    || run.status === 'failed'
    || !runtime?.threadId
    || !client
  ) return;
  if (runtime.activeTurnId && runtime.activeTurnId !== turnId) {
    scheduleGoalPoll(runId, runtime.activeTurnId);
    return;
  }

  try {
    const response = await client.request('thread/goal/get', { threadId: runtime.threadId });
    goalPollFailures.delete(runId);
    if (response.goal?.status === 'complete') {
      scheduleTurnSettlement(runId, turnId, GOAL_RESULT_GRACE_MS);
      return;
    }
  } catch (error) {
    const failures = (goalPollFailures.get(runId) ?? 0) + 1;
    goalPollFailures.set(runId, failures);
    if (completedAgentSignals.has(runId) && failures >= GOAL_POLL_FAILURE_LIMIT) {
      scheduleResultProbe(runId, turnId, 0);
    }
    // 原 app-server 可能只是正忙；旁路读取持久线程，不中断仍在执行的任务。
  }

  const current = useButlerErrandRuns.getState().runs.find((item) => item.id === runId);
  if (current?.status === 'running' || current?.status === 'awaiting-approval') {
    scheduleGoalPoll(runId, turnId);
  }
}

async function probePersistedResult(runId: string, turnId: string): Promise<void> {
  if (probingPersistedResults.has(runId)) return;
  const run = useButlerErrandRuns.getState().runs.find((item) => item.id === runId);
  if (!run?.threadId || run.status === 'replied' || run.status === 'failed') return;
  probingPersistedResults.add(runId);
  let probe: AppServerClient | undefined;
  let recovered = false;
  let retry = false;

  try {
    probe = await errandClientFactory(id('errand-result-probe'), run.workspaceRoot, {
      onNotification: () => undefined,
      onServerRequest: async () => {
        throw new Error('旁路结果探测不处理交互请求');
      },
      onInterrupted: () => undefined,
    });
    const config = await businessMcpThreadConfig();
    const response = await probe.request('thread/resume', {
      threadId: run.threadId,
      cwd: run.workspaceRoot,
      runtimeWorkspaceRoots: [run.workspaceRoot],
      approvalPolicy: APPROVAL_POLICY,
      approvalsReviewer: 'auto_review',
      sandbox: run.readOnly ? 'read-only' : 'workspace-write',
      developerInstructions: ERRAND_DEVELOPER_INSTRUCTIONS,
      ...(config ? { config } : {}),
    });
    const goalResponse = await probe.request('thread/goal/get', { threadId: response.thread.id });
    if (goalResponse.goal?.status === 'complete') {
      const completionSeenAt = resultProbeCompletionSeenAt.get(runId);
      const allowCommentaryFallback = completionSeenAt !== undefined
        && Date.now() - completionSeenAt >= GOAL_RESULT_GRACE_MS;
      const output = redactAgentOutput(await readPersistedTurnReply(
        probe,
        response.thread.id,
        turnId,
        allowCommentaryFallback,
      ));
      if (output.text || allowCommentaryFallback) {
        markRunTerminal(
          runId,
          output.text
            ? { reply: output.redacted ? `${output.text}\n\n（已脱敏 ${output.redacted} 处）` : output.text, activity: undefined }
            : { activity: undefined },
          'replied',
        );
        traceRun(runId, 'status', '旁路确认目标已完成，已回收持久结果');
        recovered = true;
      } else {
        resultProbeCompletionSeenAt.set(runId, completionSeenAt ?? Date.now());
        retry = true;
      }
    } else {
      resultProbeCompletionSeenAt.delete(runId);
      retry = true;
    }
  } catch (error) {
    retry = true;
    traceRun(runId, 'warning', `旁路结果确认暂时失败，将保留原任务继续执行：${safeText(error)}`);
  } finally {
    await probe?.stop().catch(() => undefined);
    probingPersistedResults.delete(runId);
  }

  if (recovered) {
    await stopClient(runId).catch(() => undefined);
    runtimes.delete(runId);
    return;
  }
  const current = useButlerErrandRuns.getState().runs.find((item) => item.id === runId);
  if (retry && (current?.status === 'running' || current?.status === 'awaiting-approval')) {
    scheduleResultProbe(runId, turnId);
  }
}

function onInterrupted(runId: string, error: Error): void {
  clients.delete(runId);
  clientStarts.delete(runId);
  cleanupRunBuffers(runId);
  rejectInteractionWaiters(runId, error);
  if (expectedStops.delete(runId)) return;
  const run = useButlerErrandRuns.getState().runs.find((item) => item.id === runId);
  runtimes.delete(runId);
  if (!run) return;
  const reason = safeText(error);
  if (run.status === 'replied' || run.status === 'failed') {
    traceRun(runId, 'warning', `任务进入终态后 Codex 连接中断：${reason}`);
    return;
  }
  if (run.threadId) {
    const message = `Codex 连接已中断：${reason}。原线程已保留，任务已安全暂停；请恢复连接后手动继续。`;
    updateRun(runId, (current) => ({
      ...current,
      status: 'paused',
      activity: undefined,
      error: message,
      approvals: [],
      inputs: [],
    }));
    traceRun(runId, 'warning', message);
    return;
  }
  updateRun(runId, (run) => ({
    ...run,
    status: 'failed',
    activity: undefined,
    error: reason,
    approvals: [],
    inputs: [],
  }));
  traceRun(runId, 'error', reason);
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
  if (request.policy === 'safe-reject' || request.policy === 'dynamic-tool') {
    throw new Error('该请求类型在派活会话中默认禁用');
  }
  if (request.policy === 'host-input') {
    if (!isButlerErrandInputMethod(request.method)) throw new Error('该请求类型没有可用的回答表单');
    const input: ButlerErrandInput = {
      id: id('input'),
      method: request.method,
      policy: request.policy,
      params: request.params,
      at: Date.now(),
    };
    const pending = updateRun(runId, (run) => ({
      ...run,
      inputs: [...(run.inputs ?? []), input],
      status: 'awaiting-approval',
      activity: undefined,
    }));
    traceRun(runId, 'tool', `等待回应：${request.method}`);
    if (pending && pendingInteractionCount(pending) === 1 && awayFromButler()) {
      toast.info(`「${pending.title}」等你回答`, goLookAction());
    }
    return new Promise((resolve, reject) => inputWaiters.set(input.id, { runId, resolve, reject }));
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
  if (previous && pendingInteractionCount(previous) === 1 && awayFromButler()) {
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
    const turnId = typeof params.turnId === 'string' ? params.turnId : (runtime.activeTurnId ?? '');
    const delta = typeof params.delta === 'string' ? params.delta : '';
    const key = runItemKey(runId, turnId);
    const previous = turnBuffers.get(key);
    turnBuffers.set(key, { runId, text: `${previous?.text ?? ''}${delta}` });
    if (turnId) scheduleTurnSettlement(runId, turnId);
    return;
  }

  if (method === 'thread/goal/updated') {
    const goal = record(params.goal);
    const turnId = typeof params.turnId === 'string' && params.turnId
      ? params.turnId
      : runtime.activeTurnId;
    if (goal.status === 'complete' && turnId) {
      // 部分运行时会在 Goal 完成后漏掉最终消息和 turn/completed 通知。
      // 留出最终答复落盘时间，再从 thread/read 回收真实结果。
      clearGoalPoll(runId);
      scheduleTurnSettlement(runId, turnId, GOAL_RESULT_GRACE_MS);
    }
    return;
  }

  if (method === 'turn/started') {
    const turn = record(params.turn);
    if (typeof turn.id === 'string') {
      runtime.activeTurnId = turn.id;
      scheduleGoalPoll(runId, turn.id);
    }
    updateRun(runId, (run) => ({
      ...run,
      status: pendingInteractionCount(run) > 0 ? 'awaiting-approval' : 'running',
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
    if (runtime.activeTurnId === turnId) runtime.activeTurnId = undefined;
    settleTurnOnce(runId, turnId, turnStatus);
    return;
  }

  if (method === 'item/started' || method === 'item/completed') {
    const item = record(params.item);
    const type = typeof item.type === 'string' ? item.type : 'tool';
    if (type === 'subAgentActivity') {
      const kind = item.kind;
      traceRun(
        runId,
        'tool',
        `${kind === 'interrupted' ? '完成' : '开始'}：subAgentActivity`,
      );
      return;
    }
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
    const completedTurnId = typeof params.turnId === 'string' ? params.turnId : runtime.activeTurnId;
    if (method === 'item/completed' && type === 'agentMessage') {
      completedAgentSignals.add(runId);
      if (!completedTurnId) return;
      if (item.phase === 'commentary') {
        // Responses Lite 可能在 commentary 之后漏掉工具、最终答复和 turn/completed。
        // 用已确认收到的回合重新挂起 Goal 看门狗，但不把 commentary 本身当成结论。
        scheduleGoalPoll(runId, completedTurnId, FINAL_MESSAGE_IDLE_MS);
        scheduleResultProbe(runId, completedTurnId);
      } else {
        // Provider 可能省略 phase、turnId 或 turn/completed；答复 item 已落项时，
        // 用该任务已记录的活动回合兜底并幂等复核 Goal，避免任务卡永久停在 running。
        settleTurnOnce(runId, completedTurnId, 'completed');
      }
    }
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

async function pauseGoal(
  client: AppServerClient | undefined,
  runtime: ButlerErrandRuntime | undefined,
): Promise<void> {
  if (!client || !runtime?.threadId) return;
  await client.request('thread/goal/set', {
    threadId: runtime.threadId,
    status: 'paused',
  });
}

function dispatchInstruction(spec: DispatchSpec): string {
  return renderDispatchSpec(spec);
}

function resumeInstruction(run: ButlerErrandRun, instruction?: string): string {
  const text = instruction?.trim();
  if (text) return text;
  return `请继续完成「${run.title}」。先核对当前线程和工作区的真实状态，再继续后续动作，不要重复已经完成的外部操作。`;
}

function resumeRuntime(run: ButlerErrandRun): ButlerErrandRuntime {
  return {
    sessionId: id('errand-session'),
    workspaceRoot: run.workspaceRoot,
    sandboxMode: run.readOnly ? 'read-only' : 'workspace-write',
    threadId: run.threadId || undefined,
  };
}

async function resumeThreadControl(
  runId: string,
  run: ButlerErrandRun,
): Promise<{
  appServer: AppServerClient;
  runtime: ButlerErrandRuntime;
  response: ThreadResumeResponse;
}> {
  if (!run.threadId) throw new Error('派活线程不存在');
  if (runtimes.has(runId)) await stopClient(runId).catch(() => undefined);
  const runtime = resumeRuntime(run);
  runtimes.set(runId, runtime);
  const appServer = await ensureClient(runId);
  const config = await businessMcpThreadConfig();
  const response = await appServer.request('thread/resume', {
    threadId: run.threadId,
    cwd: runtime.workspaceRoot,
    runtimeWorkspaceRoots: [runtime.workspaceRoot],
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: 'auto_review',
    sandbox: runtime.sandboxMode,
    developerInstructions: ERRAND_DEVELOPER_INSTRUCTIONS,
    ...(config ? { config } : {}),
  });
  runtime.threadId = response.thread.id;
  runtime.activeTurnId = [...response.thread.turns]
    .reverse()
    .find((turn) => turn.status === 'inProgress')?.id;
  updateRun(runId, (current) => ({ ...current, threadId: response.thread.id }));
  return { appServer, runtime, response };
}

async function startTurn(
  runId: string,
  threadId: string,
  instruction: string,
): Promise<string> {
  const runtime = runtimes.get(runId);
  if (!runtime) throw new Error('派活运行时不存在');
  const appServer = await ensureClient(runId);
  const codexSettings = getAgentHostingCodexSettings();
  const response = await appServer.request('turn/start', {
    ...(codexSettings.model ? { model: codexSettings.model } : {}),
    ...(codexSettings.effort === 'default' ? {} : { effort: codexSettings.effort }),
    threadId,
    input: [{ type: 'text', text: instruction, text_elements: [] }],
    cwd: runtime.workspaceRoot,
    runtimeWorkspaceRoots: [runtime.workspaceRoot],
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: 'auto_review',
    sandboxPolicy: sandboxPolicy(runtime.sandboxMode, runtime.workspaceRoot),
  });
  runtime.activeTurnId = response.turn.id;
  scheduleGoalPoll(runId, response.turn.id);
  updateRun(runId, (run) => ({ ...run, status: 'running', error: undefined }));
  return response.turn.id;
}

async function steerTurn(
  runId: string,
  threadId: string,
  turnId: string,
  instruction: string,
): Promise<string> {
  const runtime = runtimes.get(runId);
  if (!runtime) throw new Error('派活运行时不存在');
  const appServer = await ensureClient(runId);
  const response = await appServer.request('turn/steer', {
    threadId,
    expectedTurnId: turnId,
    input: [{ type: 'text', text: instruction, text_elements: [] }],
  });
  runtime.activeTurnId = response.turnId;
  scheduleGoalPoll(runId, response.turnId);
  traceRun(runId, 'status', '已把新的约束送进当前执行');
  return response.turnId;
}

async function continueErrandRun(runId: string, instruction: string): Promise<void> {
  const runtime = runtimes.get(runId);
  if (!runtime) throw new Error('派活运行时不存在');
  if (!runtime.threadId) throw new Error('派活线程不存在');
  const run = useButlerErrandRuns.getState().runs.find((item) => item.id === runId);
  if (run && pendingInteractionCount(run) > 0) {
    throw new Error('这件活正等你回应，先处理当前请求，再决定是否继续下指令。');
  }
  if (runtime.activeTurnId) {
    await steerTurn(runId, runtime.threadId, runtime.activeTurnId, instruction);
    return;
  }
  await startTurn(runId, runtime.threadId, instruction);
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
  const config = await businessMcpThreadConfig();
  const threadResponse = await appServer.request('thread/start', {
    ...(codexSettings.model ? { model: codexSettings.model } : {}),
    cwd: workspaceRoot,
    runtimeWorkspaceRoots: [workspaceRoot],
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: 'auto_review',
    sandbox: readOnly ? 'read-only' : 'workspace-write',
    ephemeral: false,
    developerInstructions: ERRAND_DEVELOPER_INSTRUCTIONS,
    ...(config ? { config } : {}),
  });
  runtime.threadId = threadResponse.thread.id;
  const baseRun = updateRun(runId, (run) => ({
    ...run,
    threadId: threadResponse.thread.id,
    status: 'running',
    error: undefined,
  }));
  if (!baseRun) throw new Error('派活记录丢失');
  await appServer.request('thread/goal/set', {
    threadId: threadResponse.thread.id,
    objective: spec.goal.trim() || spec.title.trim(),
    status: 'active',
  });
  void appServer.request('thread/name/set', {
    threadId: threadResponse.thread.id,
    name: rocketxThreadName('派活', `${spec.title} · ${workspaceLabel(workspaceRoot)}`),
  }).catch(() => undefined);
  await startTurn(runId, threadResponse.thread.id, dispatchInstruction(spec));
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
    const originSessionId = options.originSessionId?.trim() || undefined;
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
      throw new Error('手头 5 件了，收几件再派；暂停中的先继续或叫停');
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
      inputs: [],
      traces: [],
      plan: [],
      ...(options?.roomContext ? { roomContext: options.roomContext } : {}),
      ...(originSessionId ? { originSessionId } : {}),
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

  steerErrand: async (runId, instruction) => {
    const run = get().runs.find((item) => item.id === runId);
    const text = instruction.trim();
    if (!run || !text) return;
    if (run.status === 'paused') {
      await get().resumeErrand(runId, text);
      return;
    }
    if (run.status === 'awaiting-approval') {
      throw new Error('这件活正停在审批点，先处理当前审批，再决定是否继续下指令。');
    }
    if (run.status !== 'running') {
      throw new Error('这件活当前不接受继续指令。');
    }
    if (!run.threadId) throw new Error('派活线程不存在');
    if (!runtimes.has(runId)) runtimes.set(runId, resumeRuntime(run));
    updateRun(runId, (current) => ({
      ...current,
      status: 'running',
      activity: '正在接收新的约束',
      error: undefined,
    }));
    await continueErrandRun(runId, text);
  },

  resumeErrand: async (runId, instruction) => {
    const run = get().runs.find((item) => item.id === runId);
    if (!run || run.status !== 'paused') return;
    if (!run.threadId) throw new Error('派活线程不存在');
    updateRun(runId, (current) => ({
      ...current,
      status: 'running',
      activity: '正在恢复原线程',
      approvals: [],
      inputs: [],
      error: undefined,
    }));
    try {
      const { appServer, runtime, response } = await resumeThreadControl(runId, run);
      if (!runtime.threadId) throw new Error('派活线程不存在');
      const resumedStatus = response.thread.status;
      if (
        resumedStatus.type === 'active'
        && resumedStatus.activeFlags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')
      ) {
        await stopClient(runId).catch(() => undefined);
        runtimes.delete(runId);
        updateRun(runId, (current) => ({
          ...current,
          status: 'paused',
          activity: undefined,
          error: '原线程仍在等待输入或审批；为避免重复执行，已保持暂停。可展开任务卡复制 codex resume 接管。',
        }));
        traceRun(runId, 'warning', '恢复后发现原线程仍在等待输入或审批，已保守停回暂停状态');
        return;
      }
      if (resumedStatus.type === 'active' && !runtime.activeTurnId) {
        await stopClient(runId).catch(() => undefined);
        runtimes.delete(runId);
        updateRun(runId, (current) => ({
          ...current,
          status: 'paused',
          activity: undefined,
          error: '原线程仍处于活动态，但没有拿到可续跑的 turn；为避免重复启动，已保守停回暂停状态。',
        }));
        traceRun(runId, 'warning', '恢复后线程仍活动，但缺少可继续的 turnId，已保守停回暂停状态');
        return;
      }
      const goalResponse = await appServer.request('thread/goal/get', { threadId: runtime.threadId });
      const goal = goalResponse.goal;
      if (!goal) throw new Error('派活线程缺少目标');
      if (goal.status === 'complete') {
        let reply = '';
        try {
          reply = redactAgentOutput(await readPersistedTurnReply(appServer, runtime.threadId, '')).text;
        } catch (error) {
          traceRun(runId, 'warning', `读取持久执行记录失败：${safeText(error)}`);
        }
        markRunTerminal(
          runId,
          reply ? { reply, activity: undefined } : { activity: undefined },
          'replied',
        );
        traceRun(runId, 'status', '恢复时发现这件活其实已经完成，已直接回收结果');
        await stopClient(runId).catch(() => undefined);
        runtimes.delete(runId);
        return;
      }
      await appServer.request('thread/goal/set', {
        threadId: runtime.threadId,
        objective: goal.objective?.trim() || run.title,
        status: 'active',
      });
      await continueErrandRun(runId, resumeInstruction(run, instruction));
    } catch (error) {
      await stopClient(runId).catch(() => undefined);
      runtimes.delete(runId);
      updateRun(runId, (current) => ({
        ...current,
        status: 'paused',
        activity: undefined,
        error: safeText(error),
      }));
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
      const status: ButlerErrandRun['status'] = approvals.length + (current.inputs?.length ?? 0) > 0
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

  resolveInput: async (runId, inputId, response) => {
    const run = get().runs.find((item) => item.id === runId);
    const waiter = inputWaiters.get(inputId);
    if (!run || !waiter || waiter.runId !== runId) return;
    const input = run.inputs?.find((item) => item.id === inputId);
    if (!input) return;
    const validated = validateButlerErrandInputResponse(input.method, input.params, response);
    inputWaiters.delete(inputId);
    updateRun(runId, (current) => {
      const inputs = (current.inputs ?? []).filter((item) => item.id !== inputId);
      const status: ButlerErrandRun['status'] = current.approvals.length + inputs.length > 0
        ? 'awaiting-approval'
        : current.status === 'replied' || current.status === 'failed'
          ? current.status
          : 'running';
      return { ...current, inputs, status };
    });
    waiter.resolve(validated);
    traceRun(runId, 'status', '已提交回答，继续处理');
  },

  stopErrand: async (runId) => {
    const run = get().runs.find((item) => item.id === runId);
    if (!run || (run.status !== 'running' && run.status !== 'awaiting-approval' && run.status !== 'paused')) return;
    let runtime = runtimes.get(runId);
    const pending = clientStarts.get(runId);
    let client = clients.get(runId) ?? (pending ? await pending.catch(() => undefined) : undefined);
    if (run.status === 'paused' && run.threadId && (!runtime || !client)) {
      try {
        const control = await resumeThreadControl(runId, run);
        runtime = control.runtime;
        client = control.appServer;
      } catch (error) {
        await stopClient(runId).catch(() => undefined);
        runtimes.delete(runId);
        const message = `还不能确认原线程已经停下，请稍后重试：${safeText(error)}`;
        updateRun(runId, (current) => ({
          ...current,
          status: 'paused',
          activity: undefined,
          error: message,
        }));
        traceRun(runId, 'warning', message);
        return;
      }
    }
    const activeTurnId = runtime?.activeTurnId;
    const partial = activeTurnId
      ? redactAgentOutput(turnBuffers.get(runItemKey(runId, activeTurnId))?.text.trim() ?? '')
      : { text: '', redacted: 0 };

    let pauseError: unknown;
    try {
      await pauseGoal(client, runtime);
    } catch (error) {
      pauseError = error;
      traceRun(runId, 'warning', `暂停目标状态失败：${safeText(error)}`);
    }
    rejectInteractionWaiters(runId, new Error('这件活已叫停'));
    runtimes.delete(runId);
    let interruptError: unknown;
    if (client && runtime?.threadId && activeTurnId) {
      try {
        await client.request('turn/interrupt', {
          threadId: runtime.threadId,
          turnId: activeTurnId,
        });
      } catch (error) {
        interruptError = error;
        traceRun(runId, 'warning', `中断当前执行失败：${safeText(error)}`);
      }
    }
    if (pauseError || interruptError) {
      await stopClient(runId).catch(() => undefined);
      const message = `还不能确认原线程已经停下，请稍后重试：${safeText(pauseError ?? interruptError)}`;
      updateRun(runId, (current) => ({
        ...current,
        status: 'paused',
        activity: undefined,
        approvals: [],
        inputs: [],
        error: message,
      }));
      traceRun(runId, 'warning', message);
      return;
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
      const runtime = runtimes.get(runId);
      const pending = clientStarts.get(runId);
      const client = clients.get(runId) ?? (pending ? await pending.catch(() => undefined) : undefined);
      await pauseGoal(client, runtime).catch(() => undefined);
      rejectInteractionWaiters(runId, new Error('派活会话已重置'));
      await stopClient(runId).catch(() => undefined);
      runtimes.delete(runId);
    }
    turnBuffers.clear();
    fileChangePaths.clear();
    approvalWaiters.clear();
    inputWaiters.clear();
    settlingTurns.clear();
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
