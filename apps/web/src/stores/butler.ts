import { create } from 'zustand';
import type { AgentLoopEvent } from '../kernel/ai/agent-loop';
import type { AiMessage, AiToolCall } from '../kernel/ai/provider';
import {
  butlerImageAttachments,
  type ButlerImageAttachment,
  type ButlerImageInput,
} from '../lib/butlerImages';
import { getServerBase } from '../lib/client';
import { codexBrainAvailability } from '../lib/butlerBrain';
import {
  extractButlerSources,
  mergeButlerSources,
  type ButlerSource,
  type ButlerSurfaceContext,
} from '../lib/butlerContext';
import {
  completeButlerEngineTurn,
  failButlerEngineTurn,
  initializeButlerEngineState,
  normalizeButlerEngineState,
  pauseButlerEngineTurn,
  prepareButlerEngineTurn,
  type ButlerEngineState,
  type ButlerEngineTranscriptLine,
} from '../lib/butlerEngineContract';
import { butlerStepLabel, butlerToolLabel } from '../lib/butlerToolLabels';
import {
  butlerTaskPrompt,
  compileButlerTask,
  compileButlerWorkflowTask,
  updateButlerTask,
  type ButlerTaskState,
  type ButlerWorkflowKind,
} from '../lib/butlerTaskContext';
import { normalizeDispatchSpec } from '../agent/dispatchSpec';
import {
  type ButlerErrandDraft,
  type ButlerErrandRun,
  type DispatchErrandOptions,
} from '../lib/butlerErrands';
import type { DispatchTarget } from '../lib/dispatchWorkspaces';
import { createButlerTools, type ButlerRoutineDraft } from '../lib/butlerTools';
import {
  beginButlerToolCheckpoint,
  cancelButlerToolCheckpoint,
  completeButlerToolCheckpoint,
  failButlerToolCheckpoint,
  normalizeButlerToolCheckpoint,
  recordButlerToolCheckpoint,
  recoverButlerToolCheckpoint,
  type ButlerToolAuditEntry,
  type ButlerToolCheckpoint,
  type ButlerToolRuntimeContext,
  type ButlerToolScope,
  type ButlerToolSourceRef,
} from '../lib/butlerToolRuntime';
import {
  BUTLER_AUDIT_UPDATED_EVENT,
  auditButlerAction,
  createButlerAdoStateActionDraft,
  createButlerActionCheckpoint,
  createButlerActionDraft,
  normalizeButlerActionDraft,
  preflightButlerAction,
  setButlerAdoStateDraftProvider,
  setButlerActionDraftProvider,
  updateButlerActionCheckpoint,
  type ButlerAdoStateDraftInput,
  type ButlerAnswerActionKind,
  type ButlerActionDraft,
} from '../lib/butlerActions';
import { useAuth } from './auth';
import { useWorkbench } from './workbench';
import {
  askButlerCodex,
  discardResidentCodexThread,
  friendlyButlerCodexError,
  hydrateResidentCodexThread,
  residentCodexThreadSnapshot,
  stopButlerCodexTurn,
  type ResidentCodexThreadSnapshot,
} from './butlerCodex';
import { dispatchButlerErrand, useButlerErrandRuns } from './butlerErrandRuns';
import { buildButlerLightweightMemoryContext } from '../lib/butlerMemoryContext';
import type { ButlerErrandInputResponse } from '../lib/butlerHostInput';

const HISTORY_LIMIT = 40;
/** 持久化的展示行上限：超出裁旧，避免本地存储无限增长 */
const LINES_LIMIT = 200;
const RUNTIME_CHECKPOINT_LIMIT = 50;
const APP_ID = 'builtin:butler';
const SESSION_REGISTRY_VERSION = 1;
const SESSION_REGISTRY_PREFIX = 'session-registry:';
const DEFAULT_SESSION_ID = 'default';
const DEFAULT_SESSION_TITLE = '默认对话';
const UNTITLED_SESSION_TITLES = new Set([DEFAULT_SESSION_TITLE, '新对话', '当前对话']);
const SESSION_TITLE_LIMIT = 32;
const WELCOME_TEXT = '我是你的管家。消息、待办、日程、工作项都可以直接问我。';

export { DEFAULT_PERSONA as BUTLER_SYSTEM_PROMPT } from '../lib/butlerProfile';

export interface ButlerLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments?: ButlerImageAttachment[];
  sources?: ButlerSource[];
}

/** 本轮的一个执行步骤（工具调用），给「过程」展示用 */
export interface ButlerStep {
  id: string;
  label: string;
  /** 带脱敏参数摘要的一行，如「搜索消息（发布）」；与 label 相同时不写 */
  detail?: string;
  status: 'running' | 'done' | 'failed';
  at: number;
  endedAt?: number;
}

export interface ButlerRoomContext {
  rid: string;
  roomName: string;
}

export type ButlerAskContext = ButlerRoomContext | ButlerSurfaceContext;

export interface ButlerSessionOrigin {
  rid: string;
  roomName: string;
}

export interface ButlerSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 「上回说到」预览：该会话最后一条用户消息（截断），无真实提问时缺省 */
  lastAsk?: string;
  origin?: ButlerSessionOrigin;
}

export interface ButlerSessionRecap {
  lastAsk: string;
  lastReply?: string;
}

/** recap 呈现用的相对时间标签（分钟/小时/天前） */
export function butlerRecapAgoLabel(updatedAt: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - updatedAt) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export interface ButlerWorkflowSnapshot {
  sessionId: string;
  key: string;
  kind: ButlerWorkflowKind;
  hidden: true;
  triggerReason?: string;
  attempts: number;
  paused: boolean;
  taskState: ButlerTaskState | null;
  engineState: ButlerEngineState;
  sources: ButlerSource[];
  workflowRuntimeCheckpoints: ButlerToolCheckpoint[];
  updatedAt: number;
}

export interface ButlerWorkflowRunContext {
  sessionId: string;
  taskState: ButlerTaskState;
  signal: AbortSignal;
  toolRuntimeContext: (
    callId: string,
    sources?: readonly ButlerSource[],
  ) => ButlerToolRuntimeContext;
}

export interface ButlerWorkflowRunResult<T> {
  value: T;
  summary?: string;
  sources?: ButlerSource[];
}

export interface ButlerWorkflowRunOptions<T> {
  key: string;
  kind: ButlerWorkflowKind;
  goal: string;
  triggerReason?: string;
  context?: ButlerSurfaceContext | null;
  sources?: ButlerSource[];
  execute: (context: ButlerWorkflowRunContext) => Promise<ButlerWorkflowRunResult<T>>;
}

export interface ButlerState {
  lines: ButlerLine[];
  sessions: ButlerSessionSummary[];
  activeSessionId: string;
  activity: string | null;
  /** 本轮（或上一轮）的执行步骤，新提问时清空 */
  steps: ButlerStep[];
  history: AiMessage[];
  running: boolean;
  error: string | null;
  routineDraft: ButlerRoutineDraft | null;
  errandDraft: ButlerErrandDraft | null;
  errands: ButlerErrandRun[];
  runtimeCheckpoints: ButlerToolCheckpoint[];
  workflowRuntimeCheckpoints: ButlerToolCheckpoint[];
  context: ButlerSurfaceContext | null;
  actionDraft: ButlerActionDraft | null;
  taskState: ButlerTaskState | null;
  engineState: ButlerEngineState;
  ask: (
    text: string,
    context?: ButlerAskContext,
    images?: readonly ButlerImageInput[],
    /**
     * 场景识别只看这段（缺省 = text）。
     * 入口把证据（消息转录等）拼进正文时必须传它：否则被选消息里的
     * 「查一下那个文档」会把场景劫持成找文件，管家反问后整轮空转。
     */
    intent?: string,
  ) => Promise<void>;
  setContext: (context: ButlerSurfaceContext | null) => void;
  proposeAction: (kind: ButlerAnswerActionKind, sourceLineId: string) => void;
  proposeAdoStateAction: (input: ButlerAdoStateDraftInput) => void;
  updateAction: (patch: Partial<Pick<ButlerActionDraft, 'title' | 'text' | 'rid' | 'committedTo' | 'due' | 'targetState'>>) => void;
  dismissAction: () => Promise<void>;
  beginAction: () => Promise<{ allowed: boolean; reason?: string }>;
  failAction: (reason: string, retryable?: boolean) => Promise<void>;
  completeAction: (message: string) => Promise<void>;
  /** 停止当前回答：保留已生成内容，不当错误处理 */
  stop: () => Promise<void>;
  /** 新对话：保留当前 session 并创建一个独立 session。 */
  newConversation: () => Promise<void>;
  /** 只读取得房间会话，不切换活动会话，也不中断当前回答。 */
  readRoomConversation: (room: ButlerRoomContext) => Promise<ButlerLine[]>;
  openRoomConversation: (room: ButlerRoomContext) => Promise<void>;
  openStandaloneConversation: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  /** 删除会话：删活动会话时切到最近的其他会话，没有则新建默认会话；workflow 会话不可删。 */
  deleteSession: (sessionId: string) => Promise<void>;
  hydrate: () => Promise<void>;
  setRoutineDraft: (draft: ButlerRoutineDraft) => void;
  setErrandDraftReadOnly: (readOnly: boolean) => void;
  approveToolCheckpoint: (checkpointId: string) => Promise<void>;
  dismissToolCheckpoint: (checkpointId: string) => Promise<void>;
  confirmRoutineDraft: () => Promise<void>;
  dismissRoutineDraft: () => Promise<void>;
  confirmErrandDraft: (target: DispatchTarget, options?: DispatchErrandOptions) => Promise<void>;
  resolveErrandApproval: (errandId: string, approvalId: string, approved: boolean) => Promise<void>;
  resolveErrandInput: (errandId: string, inputId: string, response: ButlerErrandInputResponse) => Promise<void>;
  stopErrand: (errandId: string) => Promise<void>;
  archiveErrand: (errandId: string) => Promise<void>;
  dismissErrandDraft: () => Promise<void>;
  reset: () => void;
}

/** 按服务器+账号隔离保存的管家对话记录。 */
interface PersistedButler {
  lines: ButlerLine[];
  history: AiMessage[];
  codexThread?: ResidentCodexThreadSnapshot;
  /** 最后一次对话活动时间，恢复时判断上下文是否过期 */
  lastAt?: number;
}

interface PersistedButlerSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  origin?: ButlerSessionOrigin;
  lines: ButlerLine[];
  history: AiMessage[];
  codexThread?: ResidentCodexThreadSnapshot;
  taskState?: ButlerTaskState;
  engineState?: ButlerEngineState;
  runtimeCheckpoints?: ButlerToolCheckpoint[];
  actionDraft?: ButlerActionDraft;
  kind?: 'interactive' | 'workflow';
  workflow?: {
    key: string;
    kind: ButlerWorkflowKind;
    triggerReason?: string;
    attempts: number;
    paused?: boolean;
  };
}

interface PersistedButlerSessionRegistry {
  schemaVersion: typeof SESSION_REGISTRY_VERSION;
  activeSessionId: string;
  lastStandaloneSessionId?: string;
  sessions: PersistedButlerSession[];
}

type ButlerCodexRunner = typeof askButlerCodex;

let codexRunner: ButlerCodexRunner = askButlerCodex;
let butlerNow = () => Date.now();

let persistScope = '';
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> = Promise.resolve();
let sessionRegistry: PersistedButlerSessionRegistry | null = null;
let suppressPersistence = false;
let sessionDirty = false;
let hydrateGeneration = 0;
let hydrateInFlight: { scope: string; promise: Promise<void> } | null = null;
const activeWorkflowRuns = new Map<string, Promise<unknown>>();
const activeWorkflowControllers = new Map<string, AbortController>();
let currentTurnFinished: Promise<void> | null = null;
let currentStopRequested = false;
let currentActionSourceLineId: string | null = null;

interface ButlerAppData {
  get<T>(appId: string, key: string): Promise<T | undefined>;
  set<T>(appId: string, key: string, value: T): Promise<void>;
}

let appDataOverride: ButlerAppData | null = null;
let toolAuditWriterOverride: ((entry: ButlerToolAuditEntry) => void | Promise<void>) | null = null;

async function butlerAppData(): Promise<ButlerAppData> {
  if (appDataOverride) return appDataOverride;
  return (await import('../kernel/store')).kernelStore.appData;
}

/** 测试用：注入内存版持久化后端（kernelStore 依赖 IndexedDB） */
export function setButlerPersistence(store: ButlerAppData): () => void {
  const previous = appDataOverride;
  appDataOverride = store;
  return () => {
    appDataOverride = previous;
  };
}

function registryKey(scope: string): string {
  return `${SESSION_REGISTRY_PREFIX}${scope}`;
}

function currentWorkflowScope(): string | undefined {
  const userId = useAuth.getState().user?._id;
  return userId ? `${getServerBase() || 'same-origin'}:${userId}` : undefined;
}

function workflowRunKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

const RECAP_ASK_LIMIT = 40;
const RECAP_REPLY_LIMIT = 80;

function recapText(value: string, limit: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function sessionTitleText(value: string): string {
  const normalized = value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。！？!?，,；;：:]+$/u, '');
  if (normalized === '[图片]') return '图片分析';
  return normalized;
}

function isGreeting(value: string): boolean {
  return /^(?:你好|您好|嗨|哈(?:喽|啰)?|在吗|hello|hi|hey)[\s!！。,.，]*$/iu.test(value);
}

function limitedSessionTitle(value: string): string {
  return value.length > SESSION_TITLE_LIMIT
    ? `${value.slice(0, SESSION_TITLE_LIMIT - 1)}…`
    : value;
}

function sessionTitlePrefix(
  origin: ButlerSessionOrigin | undefined,
  lines: readonly ButlerLine[],
): string | undefined {
  if (origin?.rid) return origin.roomName.trim();
  return lines
    .flatMap((item) => item.sources ?? [])
    .find((source) => source.kind === 'room')
    ?.label.trim();
}

/**
 * 占位标题只在遇到首个有效问题时自动替换；任何非占位标题都视为用户选择，不再覆盖。
 * 房间来源来自提问行的可信 context，而不是从问题正文猜房间名。
 */
function butlerAutoSessionTitle(
  lines: readonly ButlerLine[],
  currentTitle = DEFAULT_SESSION_TITLE,
  origin?: ButlerSessionOrigin,
): string {
  if (!UNTITLED_SESSION_TITLES.has(currentTitle)) return currentTitle;
  for (const candidate of lines) {
    if (candidate.role !== 'user') continue;
    const question = sessionTitleText(candidate.text);
    if (!question || isGreeting(question)) continue;
    const prefix = sessionTitlePrefix(origin, [candidate]);
    const titled = prefix && !question.toLocaleLowerCase().includes(prefix.toLocaleLowerCase())
      ? `${prefix} · ${question}`
      : question;
    return limitedSessionTitle(titled);
  }
  return currentTitle;
}

/** 「上回说到」派生：最后一条用户提问 + 它之后的最后一条回答；没有真实提问返回 null。 */
export function butlerSessionRecap(lines: readonly ButlerLine[]): ButlerSessionRecap | null {
  let askIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].role === 'user' && lines[index].text.trim()) {
      askIndex = index;
      break;
    }
  }
  if (askIndex === -1) return null;
  let reply: string | undefined;
  for (let index = lines.length - 1; index > askIndex; index--) {
    if (lines[index].role === 'assistant' && lines[index].text.trim()) {
      reply = recapText(lines[index].text, RECAP_REPLY_LIMIT);
      break;
    }
  }
  return {
    lastAsk: recapText(lines[askIndex].text, RECAP_ASK_LIMIT),
    ...(reply ? { lastReply: reply } : {}),
  };
}

function sessionSummaries(registry: PersistedButlerSessionRegistry): ButlerSessionSummary[] {
  return registry.sessions
    .filter((session) => session.kind !== 'workflow')
    .map(({ id, title, createdAt, updatedAt, lines, origin }) => {
      const lastAsk = butlerSessionRecap(lines)?.lastAsk;
      return {
        id,
        title,
        createdAt,
        updatedAt,
        ...(lastAsk ? { lastAsk } : {}),
        ...(origin ? { origin } : {}),
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
}

/** 测试用：捕获 tool runtime 审计，避免依赖浏览器 IndexedDB。 */
export function setButlerToolAuditWriter(
  writer: (entry: ButlerToolAuditEntry) => void | Promise<void>,
): () => void {
  const previous = toolAuditWriterOverride;
  toolAuditWriterOverride = writer;
  return () => {
    toolAuditWriterOverride = previous;
  };
}

function normalizeRuntimeCheckpoints(value: unknown): ButlerToolCheckpoint[] {
  if (!Array.isArray(value)) return [];
  const checkpoints: ButlerToolCheckpoint[] = [];
  for (const candidate of value.slice(-RUNTIME_CHECKPOINT_LIMIT)) {
    try {
      checkpoints.push(recoverButlerToolCheckpoint(normalizeButlerToolCheckpoint(candidate), butlerNow()));
    } catch {
      // 持久化数据不可信；忽略单条损坏记录，不影响其余会话恢复。
    }
  }
  return checkpoints;
}

function errandDraftFrom(checkpoints: readonly ButlerToolCheckpoint[]): ButlerErrandDraft | null {
  const checkpoint = [...checkpoints]
    .reverse()
    .find((item) => item.toolName === 'draft_errand'
      && (item.status === 'approval-required' || item.status === 'failed'));
  if (!checkpoint) return null;
  // 模型给的字段一律过白名单归一化；workspaceHint 只参与选择器排序
  const spec = normalizeDispatchSpec(checkpoint.params);
  const hint = checkpoint.params.workspaceHint;
  return {
    checkpointId: checkpoint.id,
    spec,
    ...(typeof hint === 'string' && hint.trim() ? { workspaceHint: hint.trim() } : {}),
  };
}

function routineDraftFrom(checkpoints: readonly ButlerToolCheckpoint[]): ButlerRoutineDraft | null {
  const checkpoint = [...checkpoints]
    .reverse()
    .find((item) => item.toolName === 'draft_routine'
      && (item.status === 'approval-required' || item.status === 'failed'));
  if (!checkpoint) return null;
  const { name, time, days, skillName } = checkpoint.params;
  if (typeof name !== 'string' || typeof time !== 'string' || typeof skillName !== 'string') return null;
  if (days !== undefined && (!Array.isArray(days) || days.some((day) => !Number.isInteger(day)))) return null;
  return {
    checkpointId: checkpoint.id,
    name,
    time,
    ...(Array.isArray(days) ? { days: days as number[] } : {}),
    skillName,
  };
}

function normalizeWorkflow(value: PersistedButlerSession['workflow']): PersistedButlerSession['workflow'] | undefined {
  if (!value || typeof value.key !== 'string' || !value.key.trim()) return undefined;
  if (
    value.kind !== 'today'
    && value.kind !== 'watcher'
    && value.kind !== 'rounds'
    && value.kind !== 'routine'
    && value.kind !== 'workflow'
  ) return undefined;
  return {
    key: value.key.trim(),
    kind: value.kind,
    ...(typeof value.triggerReason === 'string' && value.triggerReason.trim()
      ? { triggerReason: value.triggerReason.trim() }
      : {}),
    attempts: Number.isInteger(value.attempts) && value.attempts >= 0 ? value.attempts : 0,
    ...(value.paused ? { paused: true } : {}),
  };
}

function normalizeCodexThread(
  value: ResidentCodexThreadSnapshot | undefined,
): ResidentCodexThreadSnapshot | undefined {
  if (!value?.threadId || !value.promptHash) return undefined;
  const createdSource = value.createdWithRuntimeSource;
  const resumedSource = value.lastResumedWithRuntimeSource;
  const resumeMode = value.lastResumeMode;
  return {
    threadId: value.threadId,
    promptHash: value.promptHash,
    ...(typeof value.createdWithCodexVersion === 'string' && value.createdWithCodexVersion
      ? { createdWithCodexVersion: value.createdWithCodexVersion }
      : {}),
    ...(createdSource === 'manual' || createdSource === 'bundled' || createdSource === 'system'
      ? { createdWithRuntimeSource: createdSource }
      : {}),
    ...(typeof value.lastResumedWithCodexVersion === 'string' && value.lastResumedWithCodexVersion
      ? { lastResumedWithCodexVersion: value.lastResumedWithCodexVersion }
      : {}),
    ...(resumedSource === 'manual' || resumedSource === 'bundled' || resumedSource === 'system'
      ? { lastResumedWithRuntimeSource: resumedSource }
      : {}),
    ...(resumeMode === 'native' || resumeMode === 'transcript-rebuilt'
      ? { lastResumeMode: resumeMode }
      : {}),
  };
}

function normalizeSessionOrigin(value: unknown): ButlerSessionOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const rid = typeof candidate.rid === 'string' && candidate.rid.trim() ? candidate.rid.trim() : '';
  const roomName = typeof candidate.roomName === 'string' && candidate.roomName.trim()
    ? candidate.roomName.trim()
    : rid;
  if (!rid) return undefined;
  return { rid, roomName };
}

function roomSessionOrigin(room: ButlerRoomContext): ButlerSessionOrigin {
  return {
    rid: room.rid.trim(),
    roomName: room.roomName.trim() || room.rid.trim(),
  };
}

function sessionContextFromOrigin(origin: ButlerSessionOrigin | undefined): ButlerSurfaceContext | null {
  if (!origin?.rid) return null;
  return {
    kind: 'room',
    label: origin.roomName,
    detail: '当前 Rocket.Chat 房间',
    sources: [{ kind: 'room', id: origin.rid, rid: origin.rid, label: origin.roomName }],
  };
}

function normalizeRegistry(
  stored: PersistedButlerSessionRegistry | undefined,
): PersistedButlerSessionRegistry | undefined {
  if (stored?.schemaVersion !== SESSION_REGISTRY_VERSION || !Array.isArray(stored.sessions)) return undefined;
  const seen = new Set<string>();
  const sessions: PersistedButlerSession[] = [];
  for (const candidate of stored.sessions) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const updatedAt = Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : butlerNow();
    const createdAt = Number.isFinite(candidate.createdAt) ? candidate.createdAt : updatedAt;
    const workflow = candidate.kind === 'workflow' ? normalizeWorkflow(candidate.workflow) : undefined;
    if (candidate.kind === 'workflow' && !workflow) continue;
    const origin = normalizeSessionOrigin(candidate.origin);
    const codexThread = normalizeCodexThread(candidate.codexThread);
    let engineState = normalizeButlerEngineState(candidate.engineState);
    const runtimeCheckpoints = normalizeRuntimeCheckpoints(candidate.runtimeCheckpoints);
    const actionDraft = normalizeButlerActionDraft(candidate.actionDraft);
    const actionCheckpoint = actionDraft
      ? runtimeCheckpoints.find((item) => item.id === actionDraft.checkpointId)
      : undefined;
    let taskState = candidate.taskState?.manifest?.schemaVersion === 1 ? candidate.taskState : undefined;
    if (workflow && engineState?.status === 'running') {
      engineState = pauseButlerEngineTurn(engineState);
      workflow.paused = true;
    }
    if (workflow && taskState?.status === 'running') {
      taskState = updateButlerTask(taskState, { status: 'paused' }, butlerNow());
      workflow.paused = true;
    }
    const lines = Array.isArray(candidate.lines) && candidate.lines.length
      ? candidate.lines.slice(-LINES_LIMIT)
      : workflow ? [] : welcomeLines();
    const storedTitle = typeof candidate.title === 'string' && candidate.title.trim()
      ? candidate.title.trim()
      : DEFAULT_SESSION_TITLE;
    sessions.push({
      id: candidate.id,
      title: workflow ? storedTitle : butlerAutoSessionTitle(lines, storedTitle, origin),
      createdAt,
      updatedAt,
      ...(origin ? { origin } : {}),
      lines,
      history: trimButlerHistory(Array.isArray(candidate.history) ? candidate.history : []),
      ...(codexThread ? { codexThread } : {}),
      ...(taskState ? { taskState } : {}),
      ...(engineState ? { engineState } : {}),
      ...(runtimeCheckpoints.length ? { runtimeCheckpoints } : {}),
      ...(!workflow && actionDraft && actionCheckpoint
        && !checkpointClosed(actionCheckpoint)
        ? { actionDraft }
        : {}),
      ...(workflow ? { kind: 'workflow' as const, workflow } : {}),
    });
  }
  if (!sessions.length) return undefined;
  if (!sessions.some((session) => session.kind !== 'workflow')) sessions.unshift(defaultSession());
  const activeSessionId = sessions.some((session) => (
    session.id === stored.activeSessionId && session.kind !== 'workflow'
  ))
    ? stored.activeSessionId
    : sessions.find((session) => session.kind !== 'workflow')!.id;
  const active = sessions.find((session) => session.id === activeSessionId)!;
  const rememberedStandalone = isStandaloneSession(active)
    ? active
    : findRememberedStandaloneSession({
        schemaVersion: SESSION_REGISTRY_VERSION,
        activeSessionId,
        lastStandaloneSessionId: stored.lastStandaloneSessionId,
        sessions,
      });
  return {
    schemaVersion: SESSION_REGISTRY_VERSION,
    activeSessionId,
    ...(rememberedStandalone ? { lastStandaloneSessionId: rememberedStandalone.id } : {}),
    sessions: pruneEmptySessions(sessions, activeSessionId, rememberedStandalone?.id),
  };
}

/**
 * registry 体积控制：反复点「新对话」会留下一串只有欢迎语的空会话，它们没有内容却
 * 参与每次全量重写。这里只丢弃**没有任何用户提问**的非活动交互会话——零内容损失；
 * 有真实对话的会话永不静默删除，删除只能由用户经 deleteSession 显式执行。
 * 活动会话豁免：它可能是刚建出来、用户正要提问的那个。
 *
 * **只在 hydrate 时清理**：运行期清理会与界面竞争——`switchSession` 先落盘再切换，
 * 若此时把目标空会话清掉，切换会静默失败（回归 butler-context-freshness 抓到过）。
 * hydrate 是唯一没有会话处于半途状态的时点。
 */
function pruneEmptySessions(
  sessions: readonly PersistedButlerSession[],
  activeSessionId: string,
  lastStandaloneSessionId?: string,
): PersistedButlerSession[] {
  return sessions.filter((session) => (
    session.kind === 'workflow'
    || session.id === activeSessionId
    || session.id === lastStandaloneSessionId
    || session.lines.some((line) => line.role === 'user')
  ));
}

function defaultSession(legacy?: PersistedButler): PersistedButlerSession {
  const updatedAt = legacy?.lastAt != null && Number.isFinite(legacy.lastAt) ? legacy.lastAt : butlerNow();
  const codexThread = normalizeCodexThread(legacy?.codexThread);
  const lines = legacy?.lines?.length ? legacy.lines.slice(-LINES_LIMIT) : welcomeLines();
  return {
    id: DEFAULT_SESSION_ID,
    title: butlerAutoSessionTitle(lines),
    createdAt: updatedAt,
    updatedAt,
    lines,
    history: trimButlerHistory(legacy?.history ?? []),
    ...(codexThread ? { codexThread } : {}),
  };
}

function legacyRecord(session: PersistedButlerSession): PersistedButler {
  return {
    lines: session.lines.slice(-LINES_LIMIT),
    history: trimButlerHistory(session.history),
    lastAt: session.updatedAt,
    ...(session.codexThread ? { codexThread: session.codexThread } : {}),
  };
}

function activeSession(registry: PersistedButlerSessionRegistry): PersistedButlerSession {
  return registry.sessions.find((session) => session.id === registry.activeSessionId) ?? registry.sessions[0];
}

function createInteractiveSession(
  now: number,
  origin?: ButlerSessionOrigin,
): PersistedButlerSession {
  return {
    id: crypto.randomUUID(),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    ...(origin ? { origin } : {}),
    lines: welcomeLines(),
    history: [],
    engineState: initialEngineState([]),
  };
}

function isStandaloneSession(session: PersistedButlerSession): boolean {
  return session.kind !== 'workflow' && !session.origin;
}

function findStandaloneSession(
  registry: PersistedButlerSessionRegistry,
): PersistedButlerSession | undefined {
  return registry.sessions
    .filter((session) => isStandaloneSession(session))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)[0];
}

function findRememberedStandaloneSession(
  registry: PersistedButlerSessionRegistry,
): PersistedButlerSession | undefined {
  const remembered = registry.lastStandaloneSessionId
    ? registry.sessions.find((session) => session.id === registry.lastStandaloneSessionId)
    : undefined;
  return remembered && isStandaloneSession(remembered)
    ? remembered
    : findStandaloneSession(registry);
}

function findRoomSession(
  registry: PersistedButlerSessionRegistry,
  rid: string,
): PersistedButlerSession | undefined {
  const normalizedRid = rid.trim();
  if (!normalizedRid) return undefined;
  return registry.sessions.find((session) => (
    session.kind !== 'workflow'
    && session.origin?.rid === normalizedRid
  ));
}

function captureActiveSession(
  registry: PersistedButlerSessionRegistry,
  touchActivity: boolean,
): PersistedButlerSessionRegistry {
  const current = activeSession(registry);
  const {
    codexThread: _previousCodexThread,
    engineState: _previousEngineState,
    runtimeCheckpoints: _previousRuntimeCheckpoints,
    actionDraft: _previousActionDraft,
    ...base
  } = current;
  const state = useButler.getState();
  const codexThread = residentCodexThreadSnapshot();
  const captured: PersistedButlerSession = {
    ...base,
    title: butlerAutoSessionTitle(state.lines, current.title, current.origin),
    updatedAt: touchActivity ? butlerNow() : current.updatedAt,
    ...(current.origin ? { origin: current.origin } : {}),
    lines: state.lines.slice(-LINES_LIMIT),
    history: trimButlerHistory(state.history),
    ...(codexThread ? { codexThread } : {}),
    ...(state.taskState ? { taskState: state.taskState } : {}),
    engineState: state.engineState,
    ...(state.runtimeCheckpoints.length ? {
      runtimeCheckpoints: state.runtimeCheckpoints.slice(-RUNTIME_CHECKPOINT_LIMIT),
    } : {}),
    ...(state.actionDraft ? { actionDraft: state.actionDraft } : {}),
  };
  return {
    ...registry,
    sessions: registry.sessions.map((session) => session.id === captured.id ? captured : session),
  };
}

function queueRegistryWrite(scope: string, registry: PersistedButlerSessionRegistry): Promise<void> {
  const task = persistInFlight.catch(() => undefined).then(async () => {
    const appData = await butlerAppData();
    await appData.set<PersistedButlerSessionRegistry>(APP_ID, registryKey(scope), registry);
    await appData.set<PersistedButler>(APP_ID, scope, legacyRecord(activeSession(registry)));
  });
  persistInFlight = task;
  return task;
}

async function persistButler(touchActivity = sessionDirty): Promise<void> {
  if (!persistScope || !sessionRegistry) return;
  const scope = persistScope;
  const registry = captureActiveSession(sessionRegistry, touchActivity);
  sessionRegistry = registry;
  sessionDirty = false;
  useButler.setState({ sessions: sessionSummaries(registry) });
  await queueRegistryWrite(scope, registry);
}

/** 对话变更后防抖落盘；未 hydrate（不知道账号范围）前不写 */
function schedulePersist(): void {
  if (!persistScope || suppressPersistence) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistButler().catch(() => undefined);
  }, 500);
}

/** 测试用：立即落盘，绕过防抖 */
export async function flushButlerPersist(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistButler();
}

/** 测试用：清除已记录的持久化范围，模拟应用重启 */
export function resetButlerPersistenceForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  hydrateGeneration += 1;
  persistScope = '';
  sessionRegistry = null;
  suppressPersistence = false;
  sessionDirty = false;
  hydrateInFlight = null;
  for (const controller of activeWorkflowControllers.values()) controller.abort(new Error('测试重置'));
  activeWorkflowControllers.clear();
  activeWorkflowRuns.clear();
}

function line(role: ButlerLine['role'], text: string): ButlerLine {
  return { id: crypto.randomUUID(), role, text };
}

function conversationLines(lines: readonly ButlerLine[]): readonly ButlerLine[] {
  return lines[0]?.role === 'assistant' && lines[0].text === WELCOME_TEXT ? lines.slice(1) : lines;
}

function engineTranscript(
  lines: readonly ButlerLine[],
  engineState?: ButlerEngineState,
): ButlerEngineTranscriptLine[] {
  const transcript = conversationLines(lines);
  const latestRevision = Math.max(engineState?.transcriptRevision ?? 0, transcript.length);
  const firstRevision = latestRevision - transcript.length + 1;
  return transcript.map((item, index) => ({
    revision: firstRevision + index,
    role: item.role,
    text: item.attachments?.length
      ? `${item.text}\n[图片：${item.attachments.map((attachment) => attachment.name).join('、')}]`
      : item.text,
  }));
}

function initialEngineState(
  lines: readonly ButlerLine[],
  options?: { resumed?: boolean },
): ButlerEngineState {
  return initializeButlerEngineState({
    transcript: engineTranscript(lines),
    ...(options?.resumed ? { resumed: true } : {}),
  });
}

function sessionEngineState(session: PersistedButlerSession): ButlerEngineState {
  if (session.engineState) {
    const transcript = engineTranscript(session.lines, session.engineState);
    const transcriptRevision = transcript.at(-1)?.revision ?? session.engineState.transcriptRevision;
    if (session.engineState.status === 'running') {
      return {
        ...session.engineState,
        status: 'paused',
        transcriptRevision,
        compatibility: { mode: 'transcript', reason: 'interrupted-turn' },
      };
    }
    return { ...session.engineState, transcriptRevision };
  }
  // 没有 engineState 的旧会话：已有 Codex thread 说明这段对话喂过了，从当前进度接着走；
  // 否则从 0 开始，整段 transcript 会作为 bridge 重新喂给新 thread。
  return initialEngineState(session.lines, { resumed: Boolean(session.codexThread) });
}

function recordLocalTranscript(
  state: ButlerEngineState,
  addedLines: number,
  reason: string,
): ButlerEngineState {
  return {
    ...state,
    status: 'ready',
    transcriptRevision: state.transcriptRevision + addedLines,
    compatibility: state.compatibility.mode === 'incompatible'
      ? state.compatibility
      : { mode: 'transcript', reason },
  };
}

function normalizeContext(context: ButlerAskContext): ButlerSurfaceContext {
  if ('kind' in context) return context;
  return {
    kind: 'room',
    label: context.roomName,
    detail: '当前 Rocket.Chat 房间',
    sources: [{ kind: 'room', id: context.rid, rid: context.rid, label: context.roomName }],
  };
}

function welcomeLines(): ButlerLine[] {
  return [line('assistant', WELCOME_TEXT)];
}

function activityFor(event: AgentLoopEvent): string | null {
  // 保持 label（不带参数摘要）：既有回归逐字断言「正在调用 查询待办…」。
  if (event.type === 'tool-call') return `正在调用 ${butlerToolLabel(event.toolCall.name)}…`;
  return null;
}

export function trimButlerHistory(history: AiMessage[]): AiMessage[] {
  if (history.length <= HISTORY_LIMIT) return history;
  let start = history.length - HISTORY_LIMIT;
  while (history[start]?.role === 'tool') start += 1;
  return history.slice(start);
}

export function setButlerCodexRunner(runner: ButlerCodexRunner): () => void {
  const previous = codexRunner;
  codexRunner = runner;
  return () => {
    codexRunner = previous;
  };
}

export function setButlerNowProvider(provider: () => number): () => void {
  const previous = butlerNow;
  butlerNow = provider;
  return () => {
    butlerNow = previous;
  };
}

export function appendButlerLine(role: ButlerLine['role'], text: string): void {
  useButler.setState((state) => ({
    lines: [...state.lines, line(role, text)],
    engineState: recordLocalTranscript(state.engineState, 1, 'external-transcript'),
  }));
}

/**
 * 把后台结果写回发起它的真实 Butler 会话。
 *
 * 活动会话走现有 Zustand 落盘链；非活动会话先捕获当前屏幕上的最新状态，再只改
 * 目标 session，避免后台回话覆盖用户此刻正在输入的另一段对话。
 */
export function appendButlerSessionLine(
  sessionId: string,
  role: ButlerLine['role'],
  text: string,
): boolean {
  const targetId = sessionId.trim();
  const content = text.trim();
  if (!targetId || !content || !persistScope || !sessionRegistry) return false;
  if (sessionRegistry.activeSessionId === targetId) {
    appendButlerLine(role, content);
    return true;
  }

  const captured = captureActiveSession(sessionRegistry, false);
  const target = captured.sessions.find((session) => session.id === targetId);
  if (!target || target.kind === 'workflow') return false;
  const message = line(role, content);
  const updated: PersistedButlerSession = {
    ...target,
    updatedAt: butlerNow(),
    lines: [...target.lines, message].slice(-LINES_LIMIT),
    engineState: recordLocalTranscript(sessionEngineState(target), 1, 'external-transcript'),
  };
  const nextRegistry: PersistedButlerSessionRegistry = {
    ...captured,
    sessions: captured.sessions.map((session) => session.id === targetId ? updated : session),
  };
  sessionRegistry = nextRegistry;
  useButler.setState({ sessions: sessionSummaries(nextRegistry) });
  void queueRegistryWrite(persistScope, nextRegistry).catch(() => undefined);
  return true;
}

function upsertRuntimeCheckpoint(checkpoint: ButlerToolCheckpoint): void {
  if (checkpoint.effect === 'read') return;
  useButler.setState((state) => ({
    runtimeCheckpoints: [
      ...state.runtimeCheckpoints.filter((item) => item.id !== checkpoint.id),
      checkpoint,
    ].slice(-RUNTIME_CHECKPOINT_LIMIT),
  }));
}

async function writeToolAudit(entry: ButlerToolAuditEntry): Promise<void> {
  if (toolAuditWriterOverride) {
    await toolAuditWriterOverride(entry);
    return;
  }
  const { kernelStore } = await import('../kernel/store');
  await kernelStore.audit.append({ ...entry });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BUTLER_AUDIT_UPDATED_EVENT));
}

function runtimeCheckpoint(checkpointId: string): ButlerToolCheckpoint | undefined {
  return useButler.getState().runtimeCheckpoints.find((item) => item.id === checkpointId);
}

/**
 * 撤销之后忘掉这次审批记录，好让「再做一次」真的能再做。
 *
 * executeApprovedButlerOperation 见到 completed 会直接短路返回旧结果——
 * 那是为了防止同一次点击重复执行。但撤销是**新的意图**：不清掉记录的话，
 * 用户撤销后再点会拿到「已完成」的假成功，而实际什么都没发生。
 */
export function forgetButlerToolCheckpoint(checkpointId: string): void {
  useButler.setState((state) => ({
    runtimeCheckpoints: state.runtimeCheckpoints.filter((item) => item.id !== checkpointId),
  }));
}

function checkpointClosed(checkpoint: ButlerToolCheckpoint | undefined): boolean {
  return checkpoint?.status === 'completed' || checkpoint?.status === 'cancelled';
}

interface ButlerRuntimeSnapshot {
  context?: ButlerSurfaceContext | null;
  taskId?: string;
  sessionId?: string;
  sources?: readonly ButlerSource[];
}

function runtimeScope(context?: ButlerSurfaceContext | null): ButlerToolScope | undefined {
  const user = useAuth.getState().user;
  if (!user?._id) return undefined;
  const projects = new Set(
    context?.sources
      .map((source) => source.project?.trim())
      .filter((project): project is string => !!project),
  );
  const room = context?.kind === 'room'
    ? context.sources.find((source) => source.kind === 'room')?.rid
      ?? context.sources.find((source) => source.rid)?.rid
    : undefined;
  return {
    server: getServerBase() || 'same-origin',
    account: user._id,
    ...(projects.size === 1 ? { project: [...projects][0] } : {}),
    ...(room ? { room } : {}),
  };
}

function roomContextFromSurfaceContext(
  context: ButlerSurfaceContext | null | undefined,
): { rid: string; roomName: string } | undefined {
  const source = context?.sources.find((item) => item.kind === 'room' && (item.rid || item.id))
    ?? context?.sources.find((item) => item.rid);
  const rid = source?.rid ?? (source?.kind === 'room' ? source.id : undefined);
  if (!rid || !source) return undefined;
  const roomName = context?.kind === 'room'
    ? context.label
    : source.kind === 'message'
      ? source.label.split('：', 1)[0] || rid
      : rid;
  return { rid, roomName };
}

function runtimeSources(sources: readonly ButlerSource[] | undefined): ButlerToolSourceRef[] {
  return (sources ?? []).slice(0, 8).map(({ kind, id, rid, project }) => ({
    kind,
    id,
    ...(rid ? { rid } : {}),
    ...(project ? { project } : {}),
  }));
}

function runtimeContext(callId: string, snapshot: ButlerRuntimeSnapshot = {}): ButlerToolRuntimeContext {
  const state = useButler.getState();
  const context = snapshot.context === undefined ? state.context : snapshot.context;
  return {
    taskId: snapshot.taskId ?? state.taskState?.id ?? state.activeSessionId,
    callId,
    sessionId: snapshot.sessionId ?? state.activeSessionId,
    scope: runtimeScope(context),
    sources: runtimeSources(snapshot.sources ?? state.taskState?.sources ?? context?.sources),
    now: butlerNow,
    loadCheckpoint: runtimeCheckpoint,
    saveCheckpoint: upsertRuntimeCheckpoint,
    requestApproval: (checkpoint) => {
      if (checkpoint.toolName === 'draft_routine') {
        const draft = routineDraftFrom([checkpoint]);
        if (draft) useButler.setState({ routineDraft: draft });
        return;
      }
      if (checkpoint.toolName === 'draft_errand') {
        const draft = errandDraftFrom([checkpoint]);
        const roomContext = roomContextFromSurfaceContext(context);
        if (draft) {
          useButler.setState({
            errandDraft: roomContext ? { ...draft, roomContext } : draft,
          });
        }
      }
    },
    writeAudit: writeToolAudit,
  };
}

function runtimeContextForCheckpoint(checkpoint: ButlerToolCheckpoint): ButlerToolRuntimeContext {
  return runtimeContext(checkpoint.id);
}

function workflowSessionByKey(
  registry: PersistedButlerSessionRegistry | null,
  key: string,
): PersistedButlerSession | undefined {
  return registry?.sessions.find((session) => (
    session.kind === 'workflow' && session.workflow?.key === key
  ));
}

function workflowCheckpointById(
  checkpointId: string,
): { session: PersistedButlerSession; checkpoint: ButlerToolCheckpoint } | undefined {
  for (const session of sessionRegistry?.sessions ?? []) {
    if (session.kind !== 'workflow') continue;
    const checkpoint = session.runtimeCheckpoints?.find((item) => item.id === checkpointId);
    if (checkpoint) return { session, checkpoint };
  }
  return undefined;
}

function workflowCheckpointProjection(
  registry: PersistedButlerSessionRegistry | null,
): ButlerToolCheckpoint[] {
  return (registry?.sessions ?? []).flatMap((session) => (
    session.kind === 'workflow'
      ? (session.runtimeCheckpoints ?? []).filter((checkpoint) => (
          checkpoint.effect === 'write' && !checkpointClosed(checkpoint)
        ))
      : []
  )).slice(-RUNTIME_CHECKPOINT_LIMIT);
}

function workflowEngineState(session: PersistedButlerSession | undefined): ButlerEngineState {
  if (session) return sessionEngineState(session);
  return initializeButlerEngineState({ transcript: [] });
}

function workflowSnapshot(session: PersistedButlerSession): ButlerWorkflowSnapshot | undefined {
  const workflow = session.workflow;
  if (session.kind !== 'workflow' || !workflow) return undefined;
  return {
    sessionId: session.id,
    key: workflow.key,
    kind: workflow.kind,
    hidden: true,
    ...(workflow.triggerReason ? { triggerReason: workflow.triggerReason } : {}),
    attempts: workflow.attempts,
    paused: workflow.paused === true,
    taskState: session.taskState ?? null,
    engineState: workflowEngineState(session),
    sources: session.taskState?.sources ?? [],
    workflowRuntimeCheckpoints: normalizeRuntimeCheckpoints(session.runtimeCheckpoints),
    updatedAt: session.updatedAt,
  };
}

export function listButlerWorkflowSnapshots(): ButlerWorkflowSnapshot[] {
  return (sessionRegistry?.sessions ?? [])
    .map(workflowSnapshot)
    .filter((snapshot): snapshot is ButlerWorkflowSnapshot => !!snapshot)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

interface WorkflowBinding {
  scope: string;
  sessionId: string;
}

async function writeWorkflowRegistry(
  registry: PersistedButlerSessionRegistry,
  scope: string,
): Promise<void> {
  if (!persistScope || persistScope !== scope) {
    throw new Error('Butler workflow runtime 的登录作用域已切换。');
  }
  sessionRegistry = registry;
  useButler.setState({
    sessions: sessionSummaries(registry),
    workflowRuntimeCheckpoints: workflowCheckpointProjection(registry),
  });
  await queueRegistryWrite(scope, registry);
}

async function updateWorkflowSession(
  key: string,
  update: (session: PersistedButlerSession) => PersistedButlerSession,
  binding?: WorkflowBinding,
): Promise<PersistedButlerSession> {
  if (binding && persistScope !== binding.scope) {
    throw new Error('Butler workflow runtime 的登录作用域已切换。');
  }
  if (sessionDirty) await flushButlerPersist();
  if (binding && persistScope !== binding.scope) {
    throw new Error('Butler workflow runtime 的登录作用域已切换。');
  }
  const registry = sessionRegistry;
  const existing = workflowSessionByKey(registry, key);
  if (!registry || !existing || (binding && existing.id !== binding.sessionId)) {
    throw new Error(`未找到当前作用域的 Butler workflow session：${key}`);
  }
  const updated = update(existing);
  await writeWorkflowRegistry({
    ...registry,
    sessions: registry.sessions.map((session) => session.id === existing.id ? updated : session),
  }, binding?.scope ?? persistScope);
  return updated;
}

async function saveWorkflowCheckpoint(
  key: string,
  binding: WorkflowBinding,
  checkpoint: ButlerToolCheckpoint,
): Promise<void> {
  await updateWorkflowSession(key, (session) => ({
    ...session,
    updatedAt: butlerNow(),
    runtimeCheckpoints: [
      ...(session.runtimeCheckpoints ?? []).filter((item) => item.id !== checkpoint.id),
      checkpoint,
    ].slice(-RUNTIME_CHECKPOINT_LIMIT),
  }), binding);
}

function workflowRuntimeContext(
  key: string,
  scope: string,
  sessionId: string,
  taskState: ButlerTaskState,
  context: ButlerSurfaceContext | null | undefined,
  sources: readonly ButlerSource[],
  callId: string,
): ButlerToolRuntimeContext {
  return {
    taskId: taskState.id,
    callId,
    sessionId,
    scope: runtimeScope(context),
    sources: runtimeSources(sources),
    now: butlerNow,
    loadCheckpoint: (checkpointId) => (
      persistScope === scope
        ? workflowSessionByKey(sessionRegistry, key)?.runtimeCheckpoints?.find((item) => item.id === checkpointId)
        : undefined
    ),
    saveCheckpoint: (checkpoint) => saveWorkflowCheckpoint(key, { scope, sessionId }, checkpoint),
    requestApproval: () => undefined,
    writeAudit: writeToolAudit,
  };
}

export function runButlerWorkflowTask<T>(options: ButlerWorkflowRunOptions<T>): Promise<T> {
  const key = options.key.trim();
  if (!key) return Promise.reject(new Error('Butler workflow key 不能为空。'));
  const scope = currentWorkflowScope();
  if (!scope) return Promise.reject(new Error('Butler workflow runtime 需要已登录账号。'));
  const runKey = workflowRunKey(scope, key);
  const active = activeWorkflowRuns.get(runKey);
  if (active) return active as Promise<T>;

  const controller = new AbortController();
  activeWorkflowControllers.set(runKey, controller);
  const task = (async () => {
    await useButler.getState().hydrate();
    if (!sessionRegistry || persistScope !== scope) {
      throw new Error('Butler workflow runtime 的登录作用域已切换。');
    }
    await flushButlerPersist();
    if (!sessionRegistry || persistScope !== scope) {
      throw new Error('Butler workflow runtime 的登录作用域已切换。');
    }

    const startedAt = butlerNow();
    const previous = workflowSessionByKey(sessionRegistry, key);
    const taskState = compileButlerWorkflowTask({
      kind: options.kind,
      goal: options.goal,
      sources: options.sources ?? options.context?.sources,
    }, previous?.taskState, startedAt);
    const runningTask = updateButlerTask(taskState, { status: 'running' }, startedAt);
    const previousEngine = workflowEngineState(previous);
    const prepared = prepareButlerEngineTurn({
      engineState: previousEngine,
      transcript: engineTranscript(previous?.lines ?? [], previousEngine),
    });
    const sessionId = previous?.id ?? crypto.randomUUID();
    const userLine = line('user', options.goal);
    const workflow = {
      key,
      kind: options.kind,
      ...(options.triggerReason ? { triggerReason: options.triggerReason } : {}),
      attempts: (previous?.workflow?.attempts ?? 0) + 1,
    } satisfies NonNullable<PersistedButlerSession['workflow']>;
    const runningSession: PersistedButlerSession = {
      ...(previous ?? {
        id: sessionId,
        title: `workflow:${key}`,
        createdAt: startedAt,
        lines: [],
        history: [],
      }),
      id: sessionId,
      title: `workflow:${key}`,
      updatedAt: startedAt,
      lines: [...(previous?.lines ?? []), userLine].slice(-LINES_LIMIT),
      history: previous?.history ?? [],
      kind: 'workflow',
      workflow,
      taskState: runningTask,
      engineState: prepared.engineState,
    };
    const registry = sessionRegistry;
    const nextRegistry = previous
      ? {
          ...registry,
          sessions: registry.sessions.map((session) => session.id === previous.id ? runningSession : session),
        }
      : { ...registry, sessions: [...registry.sessions, runningSession] };
    const binding = { scope, sessionId };
    await writeWorkflowRegistry(nextRegistry, scope);

    try {
      const result = await options.execute({
        sessionId,
        taskState: runningTask,
        signal: controller.signal,
        toolRuntimeContext: (callId, sources) => workflowRuntimeContext(
          key,
          scope,
          sessionId,
          runningTask,
          options.context,
          sources ?? options.sources ?? options.context?.sources ?? [],
          callId,
        ),
      });
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('Butler workflow 已暂停。');
      }
      const completedAt = butlerNow();
      const sources = mergeButlerSources(runningTask.sources, result.sources ?? []);
      const assistantLine = line('assistant', result.summary?.trim() || 'workflow 已完成。');
      await updateWorkflowSession(key, (session) => {
        const pending = (session.runtimeCheckpoints ?? []).some((checkpoint) => (
          checkpoint.effect === 'write' && !checkpointClosed(checkpoint)
        ));
        const progressedEngine = {
          ...(session.engineState ?? prepared.engineState),
          transcriptRevision: (session.engineState ?? prepared.engineState).transcriptRevision + 2,
        };
        return {
          ...session,
          updatedAt: completedAt,
          lines: [...session.lines, assistantLine].slice(-LINES_LIMIT),
          taskState: updateButlerTask(
            runningTask,
            { status: pending ? 'paused' : 'completed', sources },
            completedAt,
          ),
          engineState: pending
            ? pauseButlerEngineTurn(progressedEngine)
            : completeButlerEngineTurn(progressedEngine, {
                transcriptRevision: progressedEngine.transcriptRevision,
              }),
          workflow: { ...workflow, ...(pending ? { paused: true } : {}) },
        };
      }, binding);
      return result.value;
    } catch (error) {
      if (persistScope !== scope) throw error;
      const paused = controller.signal.aborted;
      const failedAt = butlerNow();
      const message = error instanceof Error ? error.message : String(error);
      await updateWorkflowSession(key, (session) => {
        const progressedEngine = {
          ...(session.engineState ?? prepared.engineState),
          transcriptRevision: (session.engineState ?? prepared.engineState).transcriptRevision + 1,
        };
        return {
          ...session,
          updatedAt: failedAt,
          taskState: updateButlerTask(
            runningTask,
            { status: paused ? 'paused' : 'failed', ...(paused ? {} : { error: message }) },
            failedAt,
          ),
          engineState: paused
            ? pauseButlerEngineTurn(progressedEngine)
            : failButlerEngineTurn(progressedEngine, {
                error: 'workflow-failed',
              }),
          workflow: { ...workflow, ...(paused ? { paused: true } : {}) },
        };
      }, binding);
      throw error;
    }
  })();
  activeWorkflowRuns.set(runKey, task);
  void task.finally(() => {
    if (activeWorkflowRuns.get(runKey) === task) activeWorkflowRuns.delete(runKey);
    if (activeWorkflowControllers.get(runKey) === controller) activeWorkflowControllers.delete(runKey);
  }).catch(() => undefined);
  return task;
}

export async function pauseButlerWorkflowTask(
  key: string,
  reason = '用户暂停 workflow',
): Promise<void> {
  const normalized = key.trim();
  if (!normalized) return;
  const scope = currentWorkflowScope();
  if (!scope) return;
  activeWorkflowControllers.get(workflowRunKey(scope, normalized))?.abort(new Error(reason));
  await useButler.getState().hydrate();
  if (persistScope !== scope) return;
  const session = workflowSessionByKey(sessionRegistry, normalized);
  if (!session?.taskState) return;
  const binding = { scope, sessionId: session.id };
  const pausedAt = butlerNow();
  await updateWorkflowSession(normalized, (current) => {
    const engineState = workflowEngineState(current);
    return {
      ...current,
      updatedAt: pausedAt,
      taskState: updateButlerTask(current.taskState!, { status: 'paused' }, pausedAt),
      engineState: pauseButlerEngineTurn(engineState),
      workflow: current.workflow ? { ...current.workflow, paused: true } : current.workflow,
    };
  }, binding);
}

async function settleWorkflowCheckpoint(
  key: string,
  binding: WorkflowBinding,
  content?: string,
): Promise<void> {
  await updateWorkflowSession(key, (session) => {
    const pending = (session.runtimeCheckpoints ?? []).some((checkpoint) => (
      checkpoint.effect === 'write' && !checkpointClosed(checkpoint)
    ));
    if (pending || session.taskState?.status !== 'paused') return session;
    const now = butlerNow();
    const engineState = workflowEngineState(session);
    const nextRevision = engineState.transcriptRevision + (content ? 1 : 0);
    const progressedEngine = { ...engineState, transcriptRevision: nextRevision };
    const { paused: _paused, ...workflow } = session.workflow ?? {
      key,
      kind: 'workflow' as const,
      attempts: 0,
    };
    return {
      ...session,
      updatedAt: now,
      ...(content ? { lines: [...session.lines, line('assistant', content)].slice(-LINES_LIMIT) } : {}),
      taskState: updateButlerTask(session.taskState, { status: 'completed' }, now),
      engineState: completeButlerEngineTurn(progressedEngine, {
        transcriptRevision: nextRevision,
      }),
      workflow,
    };
  }, binding);
}

export async function executeApprovedButlerOperation<T extends string>(
  checkpoint: ButlerToolCheckpoint,
  execute: () => T | Promise<T>,
): Promise<T> {
  await useButler.getState().hydrate();
  const existing = runtimeCheckpoint(checkpoint.id);
  let current = existing ?? checkpoint;
  if (!existing) await recordButlerToolCheckpoint(current, runtimeContextForCheckpoint(current));
  current = await beginButlerToolCheckpoint(current, runtimeContextForCheckpoint(current));
  if (current.status === 'completed') return (current.result ?? '') as T;
  try {
    const result = await execute();
    await completeButlerToolCheckpoint(current, result, runtimeContextForCheckpoint(current));
    return result;
  } catch (error) {
    await failButlerToolCheckpoint(current, {
      kind: 'execution',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    }, runtimeContextForCheckpoint(current));
    throw error;
  }
}

function applyActiveSession(registry: PersistedButlerSessionRegistry): void {
  const session = activeSession(registry);
  const engineState = sessionEngineState(session);
  const runtimeCheckpoints = normalizeRuntimeCheckpoints(session.runtimeCheckpoints);
  const context = sessionContextFromOrigin(session.origin);
  const taskState = session.taskState?.status === 'running'
    && engineState.status === 'paused'
    && engineState.compatibility.reason === 'interrupted-turn'
    ? updateButlerTask(session.taskState, { status: 'paused' }, butlerNow())
    : session.taskState;
  sessionDirty = false;
  suppressPersistence = true;
  try {
    useButler.setState({
      lines: session.lines.length ? session.lines.slice(-LINES_LIMIT) : welcomeLines(),
      sessions: sessionSummaries(registry),
      activeSessionId: session.id,
      activity: null,
      steps: [],
      history: trimButlerHistory(session.history),
      running: false,
      error: null,
      routineDraft: routineDraftFrom(runtimeCheckpoints),
      errandDraft: errandDraftFrom(runtimeCheckpoints),
      runtimeCheckpoints,
      workflowRuntimeCheckpoints: workflowCheckpointProjection(registry),
      context,
      actionDraft: session.actionDraft ?? null,
      taskState: taskState ?? null,
      engineState,
    });
  } finally {
    suppressPersistence = false;
  }
  if (session.codexThread) {
    const { threadId, promptHash, ...provenance } = session.codexThread;
    hydrateResidentCodexThread(threadId, promptHash, provenance);
  }
}

export const useButler = create<ButlerState>((set, get) => ({
  lines: welcomeLines(),
  sessions: [],
  activeSessionId: '',
  activity: null,
  steps: [],
  history: [],
  running: false,
  error: null,
  routineDraft: null,
  errandDraft: null,
  errands: useButlerErrandRuns.getState().visibleRuns,
  runtimeCheckpoints: [],
  workflowRuntimeCheckpoints: [],
  context: null,
  actionDraft: null,
  taskState: null,
  engineState: initialEngineState(welcomeLines()),

  hydrate: async () => {
    const user = useAuth.getState().user;
    if (!user) return;
    const scope = `${getServerBase() || 'same-origin'}:${user._id}`;
    if (persistScope === scope && sessionRegistry) return;
    if (hydrateInFlight?.scope === scope) {
      await hydrateInFlight.promise;
      return;
    }

    const task = (async () => {
      const generation = ++hydrateGeneration;
      const firstHydrate = persistScope === '';
      const previousScope = persistScope;
      const startedState = get();
      const startedConversation = firstHydrate && startedState.lines.some((item) => item.role === 'user');
      const startedCodexThread = residentCodexThreadSnapshot();

      // scope 变更前先同步旧状态并等待已有写入，避免防抖回调把旧状态写进新账号/服务器。
      if (previousScope && sessionRegistry && get().running) await get().stop();
      if (previousScope && sessionRegistry) await flushButlerPersist();
      if (generation !== hydrateGeneration) return;
      persistScope = '';
      sessionRegistry = null;
      await discardResidentCodexThread();
      if (generation !== hydrateGeneration) return;

      const appData = await butlerAppData();
      const [storedRegistry, legacy] = await Promise.all([
        appData
          .get<PersistedButlerSessionRegistry>(APP_ID, registryKey(scope))
          .catch(() => undefined),
        appData.get<PersistedButler>(APP_ID, scope).catch(() => undefined),
      ]);
      if (generation !== hydrateGeneration) return;

      const recoveredInterruptedRuntime = storedRegistry?.sessions.some((session) => (
        session.runtimeCheckpoints?.some((checkpoint) => checkpoint.status === 'running')
      )) ?? false;
      const existingRegistry = normalizeRegistry(storedRegistry);
      let registry: PersistedButlerSessionRegistry = existingRegistry ?? {
        schemaVersion: SESSION_REGISTRY_VERSION,
        activeSessionId: DEFAULT_SESSION_ID,
        lastStandaloneSessionId: DEFAULT_SESSION_ID,
        sessions: [defaultSession(legacy)],
      };

      // 首次 hydrate 前用户已经开聊时保留当前内容；若另有旧记录，则作为独立 session 并存。
      if (startedConversation) {
        const hasStoredConversation = Boolean(existingRegistry || legacy);
        const id = hasStoredConversation ? crypto.randomUUID() : DEFAULT_SESSION_ID;
        const now = butlerNow();
        const startedSession: PersistedButlerSession = {
          id,
          title: butlerAutoSessionTitle(
            startedState.lines,
            hasStoredConversation ? '当前对话' : DEFAULT_SESSION_TITLE,
          ),
          createdAt: now,
          updatedAt: now,
          lines: startedState.lines.slice(-LINES_LIMIT),
          history: trimButlerHistory(startedState.history),
          ...(startedCodexThread ? { codexThread: startedCodexThread } : {}),
          engineState: startedState.engineState,
          ...(startedState.runtimeCheckpoints.length
            ? { runtimeCheckpoints: startedState.runtimeCheckpoints.slice(-RUNTIME_CHECKPOINT_LIMIT) }
            : {}),
          ...(startedState.actionDraft ? { actionDraft: startedState.actionDraft } : {}),
        };
        registry = {
          schemaVersion: SESSION_REGISTRY_VERSION,
          activeSessionId: id,
          lastStandaloneSessionId: id,
          sessions: hasStoredConversation ? [...registry.sessions, startedSession] : [startedSession],
        };
      }

      persistScope = scope;
      sessionRegistry = registry;
      applyActiveSession(registry);
      if (!existingRegistry || startedConversation || recoveredInterruptedRuntime) {
        await queueRegistryWrite(scope, registry).catch(() => undefined);
      }
    })();
    hydrateInFlight = { scope, promise: task };
    try {
      await task;
    } finally {
      if (hydrateInFlight?.promise === task) hydrateInFlight = null;
    }
  },

  ask: async (text, context, images = [], intent) => {
    const displayText = text.trim();
    const content = displayText || (images.length ? '请分析这些图片。' : '');
    const modelContent = images.length
      ? `${content}\n\n[用户附加图片：${images.map((image) => image.name).join('、')}]`
      : content;
    if (!content || get().running) return;
    const requestedRoom = context
      ? ('kind' in context ? roomContextFromSurfaceContext(context) : roomSessionOrigin(context))
      : undefined;
    if (requestedRoom) await get().openRoomConversation(requestedRoom);
    else await get().hydrate();
    if (get().running) return;

    const turnSessionId = get().activeSessionId;
    const turnContext = context ? normalizeContext(context) : get().context;
    // 学习标签只吃意图句；它不参与 Skill 发现、追问或工具路由。
    const intentText = intent?.trim() || content;
    const compiledTask = compileButlerTask(intentText, turnContext, get().taskState, butlerNow());
    const linesBeforeTurn = get().lines;
    const actionSourceLineId = latestActionableAssistantLine(linesBeforeTurn)?.id ?? null;
    currentActionSourceLineId = actionSourceLineId;
    const transcriptBeforeTurn = engineTranscript(linesBeforeTurn, get().engineState);
    const prepared = prepareButlerEngineTurn({
      engineState: get().engineState,
      transcript: transcriptBeforeTurn,
    });
    const conversationLineCountBeforeTurn = conversationLines(linesBeforeTurn).length;
    const runningTask = updateButlerTask(compiledTask, { status: 'running' }, butlerNow());
    let finishTurn: (() => void) | undefined;
    const turnFinished = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    currentTurnFinished = turnFinished;
    currentStopRequested = false;
    set((state) => ({
      lines: [
        ...state.lines,
        {
          ...line('user', displayText || '[图片]'),
          ...(images.length ? { attachments: butlerImageAttachments(images) } : {}),
          ...(turnContext?.sources.length ? { sources: turnContext.sources } : {}),
        },
      ],
      activity: null,
      steps: [],
      running: true,
      error: null,
      ...(context && 'kind' in context ? { context: turnContext } : {}),
      taskState: runningTask,
      engineState: prepared.engineState,
    }));

    let assistantLineId: string | undefined;
    let turnOpen = true;
    let turnSources = turnContext?.sources ?? [];
    const toolRuntimeContextFor = (toolCall: AiToolCall) => runtimeContext(toolCall.id, {
      context: turnContext,
      taskId: runningTask.id,
      sessionId: turnSessionId,
      sources: turnSources,
    });
    const toolCallNames = new Map<string, string>();
    const onEvent = (event: AgentLoopEvent) => {
      if (!turnOpen) return;
      if (event.type === 'content') {
        const id = assistantLineId ?? crypto.randomUUID();
        assistantLineId ??= id;
        set((state) => {
          const current = state.lines.find((item) => item.id === id);
          return {
            lines: current
              ? state.lines.map((item) => item.id === id ? { ...item, text: `${item.text}${event.content}` } : item)
              : [...state.lines, { id, role: 'assistant', text: event.content, ...(turnSources.length ? { sources: turnSources } : {}) }],
          };
        });
        return;
      }
      if (event.type === 'phase') {
        set({ activity: event.detail ?? null });
        return;
      }
      if (event.type === 'tool-call') {
        toolCallNames.set(event.toolCall.id, event.toolCall.name);
        const label = butlerToolLabel(event.toolCall.name);
        const detail = butlerStepLabel(event.toolCall.name, event.toolCall.arguments);
        set((state) => ({
          activity: activityFor(event),
          steps: [...state.steps, {
            id: event.toolCall.id,
            label,
            ...(detail !== label ? { detail } : {}),
            status: 'running' as const,
            at: butlerNow(),
          }],
        }));
        return;
      }
      if (event.type === 'tool-result') {
        const toolName = toolCallNames.get(event.toolCallId);
        turnSources = mergeButlerSources(turnSources, extractButlerSources(toolName, event.content));
        // 参数无效 / 未知工具 也是失败：漏掉它们会给失败步骤打绿色对勾。
        const failed = /^(?:工具(?:调用|执行)失败|工具参数无效|未知工具)/.test(event.content);
        set((state) => {
          const steps = state.steps.map((step) =>
            step.id === event.toolCallId
              ? { ...step, status: failed ? 'failed' as const : 'done' as const, endedAt: butlerNow() }
              : step,
          );
          const lines = assistantLineId
            ? state.lines.map((item) => item.id === assistantLineId
              ? { ...item, ...(turnSources.length ? { sources: turnSources } : {}) }
              : item)
            : state.lines;
          return {
            // 不回落 null：否则工具一返回就退回通用兜底「正在处理请求…」，
            // Codex 路径随后会发 summarizing 覆盖它。
            activity: '正在整理结果…',
            steps,
            lines,
            taskState: state.taskState
              ? updateButlerTask(state.taskState, { sources: turnSources }, butlerNow())
              : null,
          };
        });
      }
    };

    const transcriptRevisionAfter = (lines: readonly ButlerLine[]) => (
      prepared.engineState.transcriptRevision
      + Math.max(0, conversationLines(lines).length - conversationLineCountBeforeTurn)
    );
    const progressedEngineState = (state: ButlerState, lines: readonly ButlerLine[]) => ({
      ...state.engineState,
      transcriptRevision: transcriptRevisionAfter(lines),
    });

    try {
      const availability = codexBrainAvailability();
      if (!availability.available) throw new Error(availability.reason ?? 'Codex 暂不可用');
      const memoryContext = buildButlerLightweightMemoryContext(content, runtimeScope(turnContext));
      const result = await codexRunner({
        text: modelContent,
        images,
        context: turnContext ?? undefined,
        taskContext: [butlerTaskPrompt(runningTask), memoryContext].filter(Boolean).join('\n\n'),
        taskState: runningTask,
        bridgeTranscript: prepared.bridgeTranscript,
        fallbackTranscript: transcriptBeforeTurn,
        now: butlerNow(),
        onEvent,
        toolRuntimeContext: toolRuntimeContextFor,
      });
      const resultText = result.text;
      turnOpen = false;
      const stopped = currentStopRequested;
      set((state) => {
        let lines = state.lines;
        if (resultText) {
          lines = assistantLineId
            ? state.lines.map((item) => item.id === assistantLineId
              ? { ...item, text: resultText, ...(turnSources.length ? { sources: turnSources } : {}) }
              : item)
            : [...state.lines, { ...line('assistant', resultText), ...(turnSources.length ? { sources: turnSources } : {}) }];
        }
        const progressedEngine = progressedEngineState(state, lines);
        return {
          lines,
          activity: null,
          running: false,
          taskState: state.taskState
            ? updateButlerTask(state.taskState, { status: stopped ? 'paused' : 'completed', sources: turnSources }, butlerNow())
            : null,
          engineState: stopped
            ? pauseButlerEngineTurn(progressedEngine)
            : completeButlerEngineTurn(progressedEngine, {
              transcriptRevision: progressedEngine.transcriptRevision,
            }),
        };
      });
    } catch (error) {
      turnOpen = false;
      // 用户主动停止不是错误：保留已生成的内容，安静收尾
      if (currentStopRequested) {
        set((state) => {
          const progressedEngine = progressedEngineState(state, state.lines);
          return {
            activity: null,
            running: false,
            taskState: state.taskState
              ? updateButlerTask(state.taskState, { status: 'paused' }, butlerNow())
              : null,
            engineState: pauseButlerEngineTurn(progressedEngine),
          };
        });
        return;
      }
      const message = friendlyButlerCodexError(error);
      set((state) => {
        const progressedEngine = progressedEngineState(state, state.lines);
        return {
          activity: null,
          running: false,
          error: message,
          taskState: state.taskState
            ? updateButlerTask(state.taskState, { status: 'failed', error: message }, butlerNow())
            : null,
          engineState: failButlerEngineTurn(progressedEngine, { error: 'turn-failed' }),
        };
      });
    } finally {
      if (currentTurnFinished === turnFinished) {
        currentTurnFinished = null;
        currentStopRequested = false;
      }
      if (currentActionSourceLineId === actionSourceLineId) currentActionSourceLineId = null;
      finishTurn?.();
    }
  },

  setContext: (context) => set({ context }),

  proposeAction: (kind, sourceLineId) => {
    const source = get().lines.find((item) => item.id === sourceLineId && item.role === 'assistant');
    if (!source) return;
    const previous = get().actionDraft;
    if (previous) {
      const previousCheckpoint = runtimeCheckpoint(previous.checkpointId);
      if (previousCheckpoint) {
        void cancelButlerToolCheckpoint(previousCheckpoint, runtimeContextForCheckpoint(previousCheckpoint));
      }
      void auditButlerAction(previous.kind, 'cancelled', previous).catch(() => undefined);
    }
    const actionDraft = createButlerActionDraft(kind, source, get().context);
    const checkpoint = createButlerActionCheckpoint(actionDraft, butlerNow());
    set({ actionDraft });
    void recordButlerToolCheckpoint(checkpoint, runtimeContextForCheckpoint(checkpoint));
    void auditButlerAction(kind, 'proposed', actionDraft).catch(() => undefined);
  },

  proposeAdoStateAction: (input) => {
    const previous = get().actionDraft;
    if (previous) {
      const previousCheckpoint = runtimeCheckpoint(previous.checkpointId);
      if (previousCheckpoint) {
        void cancelButlerToolCheckpoint(previousCheckpoint, runtimeContextForCheckpoint(previousCheckpoint));
      }
      void auditButlerAction(previous.kind, 'cancelled', previous).catch(() => undefined);
    }
    const actionDraft = createButlerAdoStateActionDraft(input);
    const checkpoint = createButlerActionCheckpoint(actionDraft, butlerNow());
    set({ actionDraft });
    void recordButlerToolCheckpoint(checkpoint, runtimeContextForCheckpoint(checkpoint));
    void auditButlerAction(actionDraft.kind, 'proposed', actionDraft).catch(() => undefined);
  },

  updateAction: (patch) => set((state) => {
    if (!state.actionDraft) return { actionDraft: null };
    const actionDraft = { ...state.actionDraft, ...patch };
    const checkpoint = state.runtimeCheckpoints.find((item) => item.id === actionDraft.checkpointId);
    return {
      actionDraft,
      ...(checkpoint && checkpoint.status !== 'running'
        ? {
          runtimeCheckpoints: [
            ...state.runtimeCheckpoints.filter((item) => item.id !== checkpoint.id),
            updateButlerActionCheckpoint(checkpoint, actionDraft, butlerNow()),
          ].slice(-RUNTIME_CHECKPOINT_LIMIT),
        }
        : {}),
    };
  }),

  dismissAction: async () => {
    const draft = get().actionDraft;
    if (!draft) return;
    const checkpoint = runtimeCheckpoint(draft.checkpointId);
    if (checkpoint) await cancelButlerToolCheckpoint(checkpoint, runtimeContextForCheckpoint(checkpoint));
    set((state) => ({ actionDraft: state.actionDraft?.id === draft.id ? null : state.actionDraft }));
    await auditButlerAction(draft.kind, 'cancelled', draft).catch(() => undefined);
  },

  beginAction: async () => {
    const draft = get().actionDraft;
    if (!draft) return { allowed: false, reason: '没有待执行的动作草案' };
    const existing = runtimeCheckpoint(draft.checkpointId);
    if (!existing) return { allowed: false, reason: '这个动作已经不在了，重新问一次管家吧' };
    if (existing.status === 'failed' && existing.error?.retryable === false) {
      return { allowed: false, reason: existing.error.message };
    }
    const checkpoint = updateButlerActionCheckpoint(existing, draft, butlerNow());
    upsertRuntimeCheckpoint(checkpoint);
    const workbenchConfig = useWorkbench.getState().config;
    const reason = preflightButlerAction(draft, {
      adoDirectConfigured: Boolean(workbenchConfig?.adoBase),
      ...(workbenchConfig?.adoBase ? {
        adoConnection: {
          adoBase: workbenchConfig.adoBase,
          auth: workbenchConfig.auth,
          account: workbenchConfig.account,
        },
      } : {}),
    });
    if (reason) {
      await failButlerToolCheckpoint(checkpoint, {
        kind: 'preflight',
        message: reason,
        retryable: true,
      }, runtimeContextForCheckpoint(checkpoint));
      return { allowed: false, reason };
    }
    const running = await beginButlerToolCheckpoint(checkpoint, runtimeContextForCheckpoint(checkpoint));
    if (running.status !== 'running') return { allowed: false, reason: '动作已完成，不能重复执行' };
    return { allowed: true };
  },

  failAction: async (reason, retryable = true) => {
    const draft = get().actionDraft;
    if (!draft) return;
    const checkpoint = runtimeCheckpoint(draft.checkpointId);
    if (checkpoint) {
      await failButlerToolCheckpoint(checkpoint, {
        kind: 'execution',
        message: reason,
        retryable,
      }, runtimeContextForCheckpoint(checkpoint));
    }
    await auditButlerAction(draft.kind, 'failed', draft, reason).catch(() => undefined);
  },

  completeAction: async (message) => {
    const draft = get().actionDraft;
    if (!draft) return;
    const checkpoint = runtimeCheckpoint(draft.checkpointId);
    if (!checkpoint) return;
    await completeButlerToolCheckpoint(checkpoint, message, runtimeContextForCheckpoint(checkpoint));
    await auditButlerAction(draft.kind, 'executed', draft).catch(() => undefined);
    set((state) => ({
      actionDraft: state.actionDraft?.id === draft.id ? null : state.actionDraft,
      lines: [...state.lines, {
        ...line('assistant', `✅ ${message}`),
        ...(draft.sources.length ? { sources: draft.sources } : {}),
      }],
      engineState: recordLocalTranscript(state.engineState, 1, 'local-action-result'),
    }));
  },

  stop: async () => {
    if (!get().running) return;
    const turnFinished = currentTurnFinished;
    currentStopRequested = true;
    // 服务端中断本轮并就地完成，ask 会沿正常路径收尾
    await stopButlerCodexTurn();
    set({ activity: null });
    if (turnFinished) await turnFinished;
  },

  newConversation: async () => {
    await get().hydrate();
    if (get().running) await get().stop();
    if (!sessionRegistry || !persistScope) return;

    await flushButlerPersist();
    const scope = persistScope;
    const currentRegistry = sessionRegistry;
    await discardResidentCodexThread();
    const nextSession = createInteractiveSession(butlerNow());
    const nextRegistry: PersistedButlerSessionRegistry = {
      ...currentRegistry,
      activeSessionId: nextSession.id,
      lastStandaloneSessionId: nextSession.id,
      sessions: [...currentRegistry.sessions, nextSession],
    };
    sessionRegistry = nextRegistry;
    applyActiveSession(nextRegistry);
    await queueRegistryWrite(scope, nextRegistry);
  },

  readRoomConversation: async (room) => {
    const origin = roomSessionOrigin(room);
    if (!origin.rid) return [];
    await get().hydrate();
    if (!sessionRegistry) return [];
    return findRoomSession(sessionRegistry, origin.rid)?.lines.slice(-LINES_LIMIT) ?? [];
  },

  openRoomConversation: async (room) => {
    const origin = roomSessionOrigin(room);
    if (!origin.rid) return;
    await get().hydrate();
    if (get().running) await get().stop();
    if (!sessionRegistry || !persistScope) return;

    await flushButlerPersist();
    if (!sessionRegistry || !persistScope) return;
    const scope = persistScope;
    const existing = findRoomSession(sessionRegistry, origin.rid);
    const targetSession = existing
      ? { ...existing, origin }
      : createInteractiveSession(butlerNow(), origin);
    const current = activeSession(sessionRegistry);
    const replaceEmptyStandalone = !existing
      && isStandaloneSession(current)
      && !current.lines.some((line) => line.role === 'user');
    const retainedSessions = replaceEmptyStandalone
      ? sessionRegistry.sessions.filter((session) => session.id !== current.id)
      : sessionRegistry.sessions;
    const rememberedStandalone = isStandaloneSession(current) && !replaceEmptyStandalone
      ? current
      : findRememberedStandaloneSession({
          ...sessionRegistry,
          sessions: retainedSessions,
        });
    const switching = sessionRegistry.activeSessionId !== targetSession.id;
    const originChanged = existing?.origin?.roomName !== origin.roomName;
    const nextRegistry: PersistedButlerSessionRegistry = {
      ...sessionRegistry,
      activeSessionId: targetSession.id,
      lastStandaloneSessionId: rememberedStandalone?.id,
      sessions: existing
        ? sessionRegistry.sessions.map((session) => session.id === existing.id ? targetSession : session)
        : [
            ...sessionRegistry.sessions.filter((session) => (
              !replaceEmptyStandalone || session.id !== current.id
            )),
            targetSession,
          ],
    };
    if (!switching && !originChanged && get().context?.sources[0]?.rid === origin.rid) {
      sessionRegistry = nextRegistry;
      applyActiveSession(nextRegistry);
      return;
    }
    if (switching) await discardResidentCodexThread();
    sessionRegistry = nextRegistry;
    applyActiveSession(nextRegistry);
    if (switching || originChanged || !existing) await queueRegistryWrite(scope, nextRegistry);
  },

  openStandaloneConversation: async () => {
    await get().hydrate();
    if (get().running) await get().stop();
    if (!sessionRegistry || !persistScope) return;

    await flushButlerPersist();
    if (!sessionRegistry || !persistScope) return;
    const scope = persistScope;
    const current = activeSession(sessionRegistry);
    const rememberedStandalone = findRememberedStandaloneSession(sessionRegistry);
    const hadTarget = isStandaloneSession(current) || Boolean(rememberedStandalone);
    const targetSession = isStandaloneSession(current)
      ? current
      : rememberedStandalone ?? createInteractiveSession(butlerNow());
    const switching = sessionRegistry.activeSessionId !== targetSession.id;
    const nextRegistry: PersistedButlerSessionRegistry = {
      ...sessionRegistry,
      activeSessionId: targetSession.id,
      lastStandaloneSessionId: targetSession.id,
      sessions: sessionRegistry.sessions.some((session) => session.id === targetSession.id)
        ? sessionRegistry.sessions
        : [...sessionRegistry.sessions, targetSession],
    };
    if (!switching && get().context === null) return;
    if (switching) await discardResidentCodexThread();
    sessionRegistry = nextRegistry;
    applyActiveSession(nextRegistry);
    if (switching || !hadTarget) await queueRegistryWrite(scope, nextRegistry);
  },

  switchSession: async (sessionId) => {
    const targetId = sessionId.trim();
    if (!targetId) return;
    await get().hydrate();
    if (!sessionRegistry || !persistScope) return;
    if (sessionRegistry.activeSessionId === targetId) {
      applyActiveSession(sessionRegistry);
      return;
    }
    if (!sessionRegistry.sessions.some((session) => session.id === targetId)) return;
    if (get().running) await get().stop();

    await flushButlerPersist();
    if (!sessionRegistry || !sessionRegistry.sessions.some((session) => session.id === targetId)) return;
    const scope = persistScope;
    const target = sessionRegistry.sessions.find((session) => session.id === targetId)!;
    const nextRegistry: PersistedButlerSessionRegistry = {
      ...sessionRegistry,
      activeSessionId: targetId,
      ...(isStandaloneSession(target) ? { lastStandaloneSessionId: targetId } : {}),
    };
    await discardResidentCodexThread();
    sessionRegistry = nextRegistry;
    applyActiveSession(nextRegistry);
    await queueRegistryWrite(scope, nextRegistry);
  },

  renameSession: async (sessionId, title) => {
    const nextTitle = title.trim();
    if (!sessionId || !nextTitle) return;
    await get().hydrate();
    if (!sessionRegistry || !persistScope) return;
    const target = sessionRegistry.sessions.find((session) => session.id === sessionId);
    if (!target || target.title === nextTitle) return;

    await flushButlerPersist();
    if (!sessionRegistry) return;
    const scope = persistScope;
    const nextRegistry: PersistedButlerSessionRegistry = {
      ...sessionRegistry,
      sessions: sessionRegistry.sessions.map((session) => session.id === sessionId
        ? { ...session, title: nextTitle, updatedAt: butlerNow() }
        : session),
    };
    sessionRegistry = nextRegistry;
    sessionDirty = false;
    set({ sessions: sessionSummaries(nextRegistry) });
    await queueRegistryWrite(scope, nextRegistry);
  },

  deleteSession: async (sessionId) => {
    const targetId = sessionId.trim();
    if (!targetId) return;
    await get().hydrate();
    if (!sessionRegistry || !persistScope) return;
    const target = sessionRegistry.sessions.find((session) => session.id === targetId);
    if (!target || target.kind === 'workflow') return;
    const deletingActive = sessionRegistry.activeSessionId === targetId;
    if (deletingActive && get().running) await get().stop();

    await flushButlerPersist();
    if (!sessionRegistry || !sessionRegistry.sessions.some((session) => session.id === targetId)) return;
    const scope = persistScope;
    if (!deletingActive) {
      const remaining = sessionRegistry.sessions.filter((session) => session.id !== targetId);
      const rememberedStandalone = findRememberedStandaloneSession({
        ...sessionRegistry,
        sessions: remaining,
      });
      const nextRegistry: PersistedButlerSessionRegistry = {
        ...sessionRegistry,
        lastStandaloneSessionId: rememberedStandalone?.id,
        sessions: remaining,
      };
      sessionRegistry = nextRegistry;
      set({ sessions: sessionSummaries(nextRegistry) });
      await queueRegistryWrite(scope, nextRegistry);
      return;
    }
    await discardResidentCodexThread();
    // 停 app-server 是真实往返，这期间 workflow runtime 可能写过 registry：
    // 必须用 await 之后的 sessionRegistry 重算，否则会把那些写入整体回滚掉。
    if (!sessionRegistry || persistScope !== scope) return;
    if (!sessionRegistry.sessions.some((session) => session.id === targetId)) return;
    const remaining = sessionRegistry.sessions.filter((session) => session.id !== targetId);
    const nextActive = remaining
      .filter((session) => session.kind !== 'workflow')
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)[0];
    let nextRegistry: PersistedButlerSessionRegistry;
    if (nextActive) {
      const rememberedStandalone = isStandaloneSession(nextActive)
        ? nextActive
        : findRememberedStandaloneSession({ ...sessionRegistry, sessions: remaining });
      nextRegistry = {
        ...sessionRegistry,
        activeSessionId: nextActive.id,
        lastStandaloneSessionId: rememberedStandalone?.id,
        sessions: remaining,
      };
    } else {
      const nextSession = createInteractiveSession(butlerNow());
      nextRegistry = {
        ...sessionRegistry,
        activeSessionId: nextSession.id,
        lastStandaloneSessionId: nextSession.id,
        sessions: [...remaining, nextSession],
      };
    }
    sessionRegistry = nextRegistry;
    applyActiveSession(nextRegistry);
    await queueRegistryWrite(scope, nextRegistry);
  },

  setRoutineDraft: (routineDraft) => set({ routineDraft }),

  setErrandDraftReadOnly: (readOnly) => set((state) => ({
    errandDraft: state.errandDraft ? { ...state.errandDraft, readOnly } : null,
  })),

  approveToolCheckpoint: async (checkpointId) => {
    const workflowEntry = workflowCheckpointById(checkpointId);
    const checkpoint = runtimeCheckpoint(checkpointId) ?? workflowEntry?.checkpoint;
    if (checkpointClosed(checkpoint)) return;
    if (!checkpoint) return;
    const tool = createButlerTools().find((item) => item.name === checkpoint.toolName);
    if (!tool?.approve) return;
    const workflow = workflowEntry?.session.workflow;
    const workflowTask = workflowEntry?.session.taskState;
    const workflowBinding = workflowEntry && persistScope
      ? { scope: persistScope, sessionId: workflowEntry.session.id }
      : undefined;
    const context = workflow && workflowTask
      ? workflowRuntimeContext(
          workflow.key,
          persistScope,
          workflowEntry.session.id,
          workflowTask,
          undefined,
          workflowTask.sources,
          checkpoint.id,
        )
      : runtimeContextForCheckpoint(checkpoint);
    const result = await tool.approve(checkpoint, context);
    if (workflow && workflowBinding && result.status === 'completed') {
      await settleWorkflowCheckpoint(workflow.key, workflowBinding, result.content);
      return;
    }
    if (result.status !== 'completed') return;
    set((state) => {
      const prefix = checkpoint.capability === 'memory.write' ? '📌' : '✅';
      const lines = result.content
        ? [...state.lines, line('assistant', `${prefix} ${result.content}`)]
        : state.lines;
      return {
        lines,
        routineDraft: state.routineDraft?.checkpointId === checkpoint.id ? null : state.routineDraft,
        errandDraft: state.errandDraft?.checkpointId === checkpoint.id ? null : state.errandDraft,
        engineState: result.content
          ? recordLocalTranscript(state.engineState, 1, 'local-tool-result')
          : state.engineState,
      };
    });
  },

  dismissToolCheckpoint: async (checkpointId) => {
    const workflowEntry = workflowCheckpointById(checkpointId);
    const checkpoint = runtimeCheckpoint(checkpointId) ?? workflowEntry?.checkpoint;
    if (checkpointClosed(checkpoint)) return;
    if (!checkpoint) return;
    const workflow = workflowEntry?.session.workflow;
    const workflowTask = workflowEntry?.session.taskState;
    const workflowBinding = workflowEntry && persistScope
      ? { scope: persistScope, sessionId: workflowEntry.session.id }
      : undefined;
    const context = workflow && workflowTask
      ? workflowRuntimeContext(
          workflow.key,
          persistScope,
          workflowEntry.session.id,
          workflowTask,
          undefined,
          workflowTask.sources,
          checkpoint.id,
        )
      : runtimeContextForCheckpoint(checkpoint);
    await cancelButlerToolCheckpoint(checkpoint, context);
    if (workflow && workflowBinding) {
      await settleWorkflowCheckpoint(workflow.key, workflowBinding);
      return;
    }
    set((state) => ({
      routineDraft: state.routineDraft?.checkpointId === checkpoint.id ? null : state.routineDraft,
      errandDraft: state.errandDraft?.checkpointId === checkpoint.id ? null : state.errandDraft,
    }));
  },

  confirmRoutineDraft: async () => {
    const draft = get().routineDraft;
    if (!draft) return;
    await get().approveToolCheckpoint(draft.checkpointId);
  },

  dismissRoutineDraft: async () => {
    const draft = get().routineDraft;
    if (!draft) return;
    await get().dismissToolCheckpoint(draft.checkpointId);
  },

  confirmErrandDraft: async (target, options) => {
    const draft = get().errandDraft;
    if (!draft) return;
    // 先派发再确认 checkpoint：派发失败时草案留在卡上，用户改选工作区可重试
    const roomContext = draft.roomContext ?? roomContextFromSurfaceContext(get().context);
    await dispatchButlerErrand(draft.spec, target, {
      ...options,
      originSessionId: get().activeSessionId,
      ...(roomContext ? { roomContext } : {}),
    });
    await get().approveToolCheckpoint(draft.checkpointId);
  },

  resolveErrandApproval: async (errandId, approvalId, approved) => {
    await useButlerErrandRuns.getState().resolveApproval(errandId, approvalId, approved);
  },

  resolveErrandInput: async (errandId, inputId, response) => {
    await useButlerErrandRuns.getState().resolveInput(errandId, inputId, response);
  },

  stopErrand: async (errandId) => {
    await useButlerErrandRuns.getState().stopErrand(errandId);
  },

  archiveErrand: async (errandId) => {
    await useButlerErrandRuns.getState().archiveErrand(errandId);
  },

  dismissErrandDraft: async () => {
    const draft = get().errandDraft;
    if (!draft) return;
    await get().dismissToolCheckpoint(draft.checkpointId);
  },

  reset: () => {
    void useButlerErrandRuns.getState().reset();
    set(() => {
      const lines = welcomeLines();
      return {
        lines,
        sessions: [],
        activeSessionId: '',
        activity: null,
        steps: [],
        history: [],
        running: false,
        error: null,
        routineDraft: null,
        errandDraft: null,
        errands: [],
        runtimeCheckpoints: [],
        workflowRuntimeCheckpoints: [],
        context: null,
        actionDraft: null,
        taskState: null,
        engineState: initialEngineState(lines),
      };
    });
  },
}));

function isActionableAssistantLine(candidate: ButlerLine): boolean {
  return candidate.role === 'assistant'
    && !candidate.text.startsWith('我是你的管家')
    && !candidate.text.startsWith('📌')
    && !candidate.text.startsWith('✅');
}

function latestActionableAssistantLine(lines: readonly ButlerLine[]): ButlerLine | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (candidate && isActionableAssistantLine(candidate)) return candidate;
  }
  return undefined;
}

function draftButlerAction(kind: ButlerAnswerActionKind): boolean {
  const state = useButler.getState();
  const source = currentActionSourceLineId
    ? state.lines.find((candidate) =>
      candidate.id === currentActionSourceLineId && isActionableAssistantLine(candidate))
    : latestActionableAssistantLine(state.lines);
  if (!source) return false;
  state.proposeAction(kind, source.id);
  return useButler.getState().actionDraft?.kind === kind;
}

setButlerActionDraftProvider(draftButlerAction);

setButlerAdoStateDraftProvider((input) => {
  const state = useButler.getState();
  state.proposeAdoStateAction(input);
  const draft = useButler.getState().actionDraft;
  return draft?.kind === 'ado-state'
    && draft.workItemId === input.workItemId
    && draft.targetState === input.targetState.trim();
});

function syncErrandsIntoButler(): void {
  const errands = useButlerErrandRuns.getState().visibleRuns;
  const current = useButler.getState();
  if (current.errands === errands) return;
  useButler.setState({ errands });
}

function errandConversationExcerpt(value: string | undefined): string {
  const normalized = value?.trim().replace(/\s+/g, ' ') ?? '';
  if (!normalized) return '';
  return normalized.length > 400 ? `${normalized.slice(0, 400)}…` : normalized;
}

function deliverErrandConversationEvents(
  runs: readonly ButlerErrandRun[],
  previousRuns: readonly ButlerErrandRun[],
): void {
  for (const run of runs) {
    if (!run.originSessionId) continue;
    const previous = previousRuns.find((candidate) => candidate.id === run.id);
    if (!previous) continue;

    const firstApproval = run.status === 'awaiting-approval'
      && previous.approvals.length === 0
      && run.approvals.length > 0;
    if (firstApproval) {
      appendButlerSessionLine(
        run.originSessionId,
        'assistant',
        `「${run.title}」需要你确认一项操作，已经放在任务卡里。`,
      );
      continue;
    }

    if (run.status === previous.status) continue;
    if (run.status === 'paused') {
      const reason = errandConversationExcerpt(run.error);
      appendButlerSessionLine(
        run.originSessionId,
        'assistant',
        `「${run.title}」已安全暂停${reason ? `：${reason}` : '。'}`,
      );
    } else if (run.status === 'replied') {
      const result = errandConversationExcerpt(run.reply);
      appendButlerSessionLine(
        run.originSessionId,
        'assistant',
        `「${run.title}」回话了${result ? `：${result}` : '。'}`,
      );
    } else if (run.status === 'failed') {
      const reason = errandConversationExcerpt(run.error ?? run.reply);
      appendButlerSessionLine(
        run.originSessionId,
        'assistant',
        `「${run.title}」停下来了${reason ? `：${reason}` : '。'}`,
      );
    }
  }
}

syncErrandsIntoButler();

useButlerErrandRuns.subscribe((state, previous) => {
  deliverErrandConversationEvents(state.runs, previous.runs);
  if (state.visibleRuns === previous.visibleRuns) return;
  syncErrandsIntoButler();
});

// 当前已 hydrate 的 session 发生 transcript 或任务态变化时更新活动时间并防抖落盘。
useButler.subscribe((state, previous) => {
  if (
    state.lines === previous.lines
    && state.history === previous.history
    && state.taskState === previous.taskState
    && state.engineState === previous.engineState
    && state.runtimeCheckpoints === previous.runtimeCheckpoints
    && state.actionDraft === previous.actionDraft
  ) return;
  if (suppressPersistence || !persistScope || !sessionRegistry) return;
  sessionDirty = true;
  schedulePersist();
});
