import { create } from 'zustand';
import { DshController, type DshServerRequest } from '../agent/dsh/DshController';
import { approvalResponse, questionResponse } from '../agent/dsh/protocol';
import {
  permissionSelection,
  permissionSettings,
  type DshAgentPreset,
  type DshModelDirectory,
  type DshModelFailure,
  type DshModelGroup,
  type DshModelSelection,
  type DshPermissionOption,
  type DshPermissionSelection,
  type DshSettingsDescription,
} from '../agent/dsh/config';
import {
  dshPreview,
  projectDshTranscript,
  type DshActivity,
  type DshMessage,
  type DshSessionEvent,
} from '../agent/dsh/project';
import { isTauriRuntime } from '../lib/client';

const WORKSPACE_STORAGE_KEY = 'rocketx.dsh.workspace-root';
const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY';

export type DshConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error';

export interface DshSession {
  id: string;
  title?: string;
  preview?: string;
  updatedAt: number;
  status: 'idle' | 'running' | 'error';
  blank: boolean;
  agentPreset?: string;
}

export interface DshPendingApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

export interface DshQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface DshQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface DshPendingQuestion {
  rpcId: string;
  sessionId: string;
  questions: DshQuestion[];
}

export interface DshQueuedMessage {
  id: string;
  placement: 'queued' | 'steering';
  text: string;
}

interface DshWorkspaceState {
  status: DshConnectionStatus;
  error: string | null;
  workspaceRoot: string;
  sessions: DshSession[];
  activeSessionId: string | null;
  messages: DshMessage[];
  activities: DshActivity[];
  pendingApproval: DshPendingApproval | null;
  pendingQuestion: DshPendingQuestion | null;
  queuedMessages: DshQueuedMessage[];
  isRunning: boolean;
  credentialConfigured: boolean | null;
  credentialWritable: boolean;
  configurationStatus: DshConnectionStatus;
  configurationError: string | null;
  configurationWritable: boolean;
  modelSelection: DshModelSelection | null;
  modelGroups: DshModelGroup[];
  modelFailures: DshModelFailure[];
  agentPresets: DshAgentPreset[];
  defaultAgentPreset: string | null;
  permissionPresets: DshPermissionOption[];
  defaultPermissionPreset: string | null;
  activePermission: DshPermissionSelection | null;
  setWorkspaceRoot: (path: string) => Promise<void>;
  connect: () => Promise<void>;
  refresh: () => Promise<void>;
  startSession: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  respondApproval: (approved: boolean) => Promise<void>;
  respondQuestion: (answers: DshQuestionAnswer[]) => Promise<void>;
  setDeepSeekApiKey: (apiKey: string) => Promise<void>;
  clearDeepSeekApiKey: () => Promise<void>;
  refreshConfiguration: () => Promise<void>;
  selectModel: (selection: DshModelSelection) => Promise<void>;
  selectAgentPreset: (agentPreset: string) => Promise<void>;
  selectPermissionPreset: (permissionPreset: string) => Promise<void>;
}

interface SessionSummaryWire {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  origin?: 'subagent';
  agentPreset?: string;
  projections?: { asOfSeq?: number; values?: Record<string, unknown> };
}

interface HistoryWire {
  events: Array<{ event: DshSessionEvent }>;
  hasMore: boolean;
  projections?: { asOfSeq?: number; values?: Record<string, unknown> };
}

interface DshCommandExecutionWire {
  commandId: string;
  result: {
    kind: 'success' | 'error';
    text?: string;
  };
}

let controller: DshController | null = null;
let connectedWorkspace: string | null = null;
let connectionGeneration = 0;
let connectPromise: Promise<void> | null = null;
const TRANSCRIPT_RENDER_INTERVAL_MS = 50;
const eventsBySession = new Map<string, Map<number, DshSessionEvent>>();
const transcriptRenderTimers = new Map<string, ReturnType<typeof setTimeout>>();
const approvalsBySession = new Map<string, DshPendingApproval[]>();
const questionsBySession = new Map<string, DshPendingQuestion[]>();
const queueBySession = new Map<string, DshQueuedMessage[]>();
const titleBySession = new Map<string, { seq: number; title?: string }>();
const permissionBySession = new Map<string, DshPermissionSelection>();

function savedWorkspaceRoot(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function normalizedPath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

function sameWorkspace(left: string | undefined, right: string): boolean {
  return typeof left === 'string' && normalizedPath(left) === normalizedPath(right);
}

function titleFromSummary(summary: SessionSummaryWire): string | undefined {
  const title = summary.projections?.values?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}

function sortSessions(sessions: DshSession[]): DshSession[] {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
}

function eventMap(sessionId: string): Map<number, DshSessionEvent> {
  let events = eventsBySession.get(sessionId);
  if (!events) {
    events = new Map();
    eventsBySession.set(sessionId, events);
  }
  return events;
}

function activeConversationState(sessionId: string | null): Pick<
  DshWorkspaceState,
  'pendingApproval' | 'pendingQuestion' | 'queuedMessages' | 'activePermission'
> {
  return {
    pendingApproval: sessionId ? approvalsBySession.get(sessionId)?.[0] ?? null : null,
    pendingQuestion: sessionId ? questionsBySession.get(sessionId)?.[0] ?? null : null,
    queuedMessages: sessionId ? queueBySession.get(sessionId) ?? [] : [],
    activePermission: sessionId ? permissionBySession.get(sessionId) ?? null : null,
  };
}

export function resetDshConversationAfterDisconnect(message: string): void {
  for (const timer of transcriptRenderTimers.values()) clearTimeout(timer);
  transcriptRenderTimers.clear();
  approvalsBySession.clear();
  questionsBySession.clear();
  queueBySession.clear();
  useDshWorkspace.setState((state) => ({
    status: 'error',
    error: message,
    sessions: state.sessions.map((session) => (
      session.status === 'running' ? { ...session, status: 'error' } : session
    )),
    pendingApproval: null,
    pendingQuestion: null,
    queuedMessages: [],
    isRunning: false,
    configurationStatus: 'error',
    configurationError: message,
  }));
}

function addPending<T extends { rpcId: string }>(items: T[] | undefined, item: T): T[] {
  if (items?.some((entry) => entry.rpcId === item.rpcId)) return items;
  return [...(items ?? []), item];
}

function queueText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
    const entry = block as Record<string, unknown>;
    return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : [];
  }).join('\n').trim();
}

function applyTitleProjection(sessionId: string, value: unknown, seq: unknown): void {
  if (!Number.isInteger(seq) || (seq as number) < 0) return;
  const current = titleBySession.get(sessionId);
  if ((seq as number) <= (current?.seq ?? -1)) return;
  const title = typeof value === 'string' && value.trim() ? value.trim() : undefined;
  titleBySession.set(sessionId, { seq: seq as number, title });
  useDshWorkspace.setState((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, title } : session),
  }));
}

function updateTranscript(sessionId: string): void {
  const events = [...eventMap(sessionId).values()];
  const transcript = projectDshTranscript(sessionId, events);
  const preview = dshPreview(transcript.messages);
  const updatedAt = events.reduce((latest, event) => Math.max(latest, event.time), 0);
  useDshWorkspace.setState((state) => ({
    ...(state.activeSessionId === sessionId ? transcript : {}),
    sessions: sortSessions(state.sessions.map((session) => session.id === sessionId
      ? {
          ...session,
          ...(preview ? { preview } : {}),
          updatedAt: Math.max(session.updatedAt, updatedAt),
          blank: events.length === 0 ? session.blank : false,
        }
      : session)),
  }));
}

function clearTranscriptRenderTimer(sessionId: string): void {
  const timer = transcriptRenderTimers.get(sessionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  transcriptRenderTimers.delete(sessionId);
}

function flushTranscript(sessionId: string): void {
  clearTranscriptRenderTimer(sessionId);
  updateTranscript(sessionId);
}

function scheduleTranscript(sessionId: string): void {
  if (transcriptRenderTimers.has(sessionId)) return;
  transcriptRenderTimers.set(sessionId, setTimeout(() => {
    transcriptRenderTimers.delete(sessionId);
    updateTranscript(sessionId);
  }, TRANSCRIPT_RENDER_INTERVAL_MS));
}

function isAssistantTextDelta(event: DshSessionEvent): boolean {
  if (event.type !== 'assistant/chunk' || !event.data || typeof event.data !== 'object') return false;
  const chunk = (event.data as Record<string, unknown>).chunk;
  return !!chunk && typeof chunk === 'object'
    && (chunk as Record<string, unknown>).type === 'text-delta'
    && typeof (chunk as Record<string, unknown>).text === 'string';
}

function upsertSession(session: DshSession): void {
  useDshWorkspace.setState((state) => ({
    sessions: sortSessions([
      session,
      ...state.sessions.filter((entry) => entry.id !== session.id),
    ]),
  }));
}

export function applyDshMuxFrame(request: DshServerRequest): void {
  const frame = request.payload as Record<string, unknown> | null;
  if (!frame || typeof frame.type !== 'string' || request.method !== frame.type) return;
  const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : null;

  if (frame.type === 'session/event' && sessionId) {
    const event = frame.event as DshSessionEvent | undefined;
    if (!event || typeof event.type !== 'string' || !Number.isInteger(event.seq)) return;
    eventMap(sessionId).set(event.seq, event);
    if (event.type === 'user/message') {
      const message = event.data as { id?: unknown } | null;
      if (typeof message?.id === 'string') {
        const remaining = (queueBySession.get(sessionId) ?? [])
          .filter((item) => item.placement !== 'steering' || item.id !== message.id);
        queueBySession.set(sessionId, remaining);
      }
    }
    if (isAssistantTextDelta(event)) scheduleTranscript(sessionId);
    else flushTranscript(sessionId);
    useDshWorkspace.setState((state) => ({
      error: state.activeSessionId === sessionId ? null : state.error,
      queuedMessages: state.activeSessionId === sessionId
        ? queueBySession.get(sessionId) ?? []
        : state.queuedMessages,
    }));
    return;
  }

  if (frame.type === 'session/projection' && sessionId && frame.key === 'title') {
    applyTitleProjection(sessionId, frame.value, frame.seq);
    return;
  }

  if (frame.type === 'session/projection' && sessionId && frame.key === 'permissions') {
    const selection = permissionSelection(frame.value);
    if (!selection) return;
    permissionBySession.set(sessionId, selection);
    if (useDshWorkspace.getState().activeSessionId === sessionId) {
      useDshWorkspace.setState({ activePermission: selection });
    }
    return;
  }

  if (frame.type === 'approval/requested' && sessionId && typeof frame.approvalId === 'string' && typeof frame.toolName === 'string') {
    const approval: DshPendingApproval = {
      rpcId: request.rpcId,
      sessionId,
      approvalId: frame.approvalId,
      toolName: frame.toolName,
      callId: typeof frame.callId === 'string' ? frame.callId : undefined,
      reason: typeof frame.reason === 'string' ? frame.reason : undefined,
    };
    const approvals = addPending(approvalsBySession.get(sessionId), approval);
    approvalsBySession.set(sessionId, approvals);
    if (useDshWorkspace.getState().activeSessionId === sessionId) {
      useDshWorkspace.setState({ pendingApproval: approvals[0] ?? null });
    }
    return;
  }

  if (frame.type === 'approval/resolved' && sessionId && typeof frame.approvalId === 'string') {
    const approvals = (approvalsBySession.get(sessionId) ?? [])
      .filter((approval) => approval.approvalId !== frame.approvalId);
    if (approvals.length > 0) approvalsBySession.set(sessionId, approvals);
    else approvalsBySession.delete(sessionId);
    if (useDshWorkspace.getState().activeSessionId === sessionId) {
      useDshWorkspace.setState({ pendingApproval: approvals[0] ?? null });
    }
    return;
  }

  if (frame.type === 'question/requested' && sessionId && Array.isArray(frame.questions)) {
    const questions = frame.questions.filter((question): question is DshQuestion => {
      const value = question as Partial<DshQuestion> | null;
      return !!value && typeof value.id === 'string' && typeof value.question === 'string';
    });
    if (questions.length === 0) return;
    const pending: DshPendingQuestion = { rpcId: request.rpcId, sessionId, questions };
    const pendingQuestions = addPending(questionsBySession.get(sessionId), pending);
    questionsBySession.set(sessionId, pendingQuestions);
    if (useDshWorkspace.getState().activeSessionId === sessionId) {
      useDshWorkspace.setState({ pendingQuestion: pendingQuestions[0] ?? null });
    }
    return;
  }

  if (frame.type === 'question/resolved' && sessionId) {
    const pendingQuestions = (questionsBySession.get(sessionId) ?? [])
      .filter((question) => question.rpcId !== frame.questionRpcId);
    if (pendingQuestions.length > 0) questionsBySession.set(sessionId, pendingQuestions);
    else questionsBySession.delete(sessionId);
    if (useDshWorkspace.getState().activeSessionId === sessionId) {
      useDshWorkspace.setState({ pendingQuestion: pendingQuestions[0] ?? null });
    }
    return;
  }

  if (frame.type === 'session/queue' && sessionId && Array.isArray(frame.items)) {
    const queued = frame.items.flatMap((item): DshQueuedMessage[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const entry = item as Record<string, unknown>;
      if (entry.placement !== 'queued' && entry.placement !== 'steering') return [];
      const message = entry.message as Record<string, unknown> | null;
      const id = typeof message?.id === 'string'
        ? message.id
        : typeof entry.id === 'string' ? entry.id : null;
      const text = queueText(message?.content);
      return id && text ? [{ id, placement: entry.placement, text }] : [];
    });
    queueBySession.set(sessionId, queued);
    if (useDshWorkspace.getState().activeSessionId === sessionId) {
      useDshWorkspace.setState({ queuedMessages: queued });
    }
    return;
  }

  if (frame.type === 'stream/error') {
    const error = frame.error as { message?: unknown } | undefined;
    useDshWorkspace.setState({ error: typeof error?.message === 'string' ? error.message : 'DSH 事件流失败' });
  }
}

function handleMux(request: DshServerRequest, generation: number): void {
  if (generation === connectionGeneration) applyDshMuxFrame(request);
}

function handleHost(request: DshServerRequest, generation: number): void {
  if (generation !== connectionGeneration) return;
  const frame = request.payload as Record<string, unknown> | null;
  if (!frame || typeof frame.type !== 'string' || request.method !== frame.type) return;
  const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : null;

  if (frame.type === 'stream/error') {
    const error = frame.error as { message?: unknown } | undefined;
    useDshWorkspace.setState({ error: typeof error?.message === 'string' ? error.message : 'DSH 主机事件流失败' });
    return;
  }

  if (frame.type === 'host/session-status' && sessionId && typeof frame.running === 'boolean') {
    useDshWorkspace.setState((state) => ({
      error: state.activeSessionId === sessionId && frame.running ? null : state.error,
      isRunning: state.activeSessionId === sessionId ? frame.running as boolean : state.isRunning,
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, status: frame.running ? 'running' : 'idle', blank: frame.running ? false : session.blank }
        : session),
    }));
    return;
  }

  if (frame.type === 'host/session-added' && sessionId) {
    const state = useDshWorkspace.getState();
    if (!sameWorkspace(typeof frame.cwd === 'string' ? frame.cwd : undefined, state.workspaceRoot)) return;
    upsertSession({
      id: sessionId,
      updatedAt: Date.now(),
      status: 'idle',
      blank: frame.blank === true,
    });
    return;
  }

  if (frame.type === 'host/session-removed' && sessionId) {
    clearTranscriptRenderTimer(sessionId);
    eventsBySession.delete(sessionId);
    approvalsBySession.delete(sessionId);
    questionsBySession.delete(sessionId);
    queueBySession.delete(sessionId);
    titleBySession.delete(sessionId);
    permissionBySession.delete(sessionId);
    useDshWorkspace.setState((state) => {
      const activeSessionId = state.activeSessionId === sessionId ? null : state.activeSessionId;
      return {
        sessions: state.sessions.filter((session) => session.id !== sessionId),
        activeSessionId,
        ...(activeSessionId ? {} : { messages: [], activities: [], isRunning: false, ...activeConversationState(null) }),
      };
    });
    return;
  }

  if (frame.type === 'host/agent-error' && sessionId) {
    const message = typeof frame.message === 'string' ? frame.message : 'DeepSeek 执行失败';
    useDshWorkspace.setState((state) => ({
      error: state.activeSessionId === sessionId ? message : state.error,
      isRunning: state.activeSessionId === sessionId ? false : state.isRunning,
      sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, status: 'error' } : session),
    }));
  }
}

async function describeCredential(active: DshController): Promise<Pick<
  DshWorkspaceState,
  'credentialConfigured' | 'credentialWritable'
>> {
  const value = await active.call<{
    credentials: Record<string, { configured: boolean; writable: boolean }>;
  }>('credentials.describe', { refs: [DEEPSEEK_API_KEY_REF] });
  return dshCredentialState(value.credentials?.[DEEPSEEK_API_KEY_REF]);
}

export function dshCredentialState(credential: {
  configured?: unknown;
  writable?: unknown;
} | undefined): Pick<DshWorkspaceState, 'credentialConfigured' | 'credentialWritable'> {
  return {
    credentialConfigured: credential?.configured === true,
    credentialWritable: credential?.writable === true,
  };
}

interface DshHostDescriptionWire {
  provider?: string;
  model?: string;
}

type DshConfigurationPatch = Pick<
  DshWorkspaceState,
  | 'configurationStatus'
  | 'configurationError'
  | 'configurationWritable'
  | 'modelSelection'
  | 'modelGroups'
  | 'modelFailures'
  | 'agentPresets'
  | 'defaultAgentPreset'
  | 'permissionPresets'
  | 'defaultPermissionPreset'
>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function configuredModel(
  settings: DshSettingsDescription,
  host: DshHostDescriptionWire,
): DshModelSelection | null {
  const value = record(settings.namespaces.find((entry) => entry.ns === 'agent-default-model')?.value);
  const provider = typeof value?.provider === 'string' ? value.provider : host.provider;
  const model = typeof value?.model === 'string' ? value.model : host.model;
  if (!provider || !model) return null;
  return {
    provider,
    model,
    ...(typeof value?.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
  };
}

async function readConfiguration(
  active: DshController,
  host: DshHostDescriptionWire,
): Promise<DshConfigurationPatch> {
  const [presetValue, settings, modelValue] = await Promise.all([
    active.call<{ presets: DshAgentPreset[] }>('agentPreset.list'),
    active.call<DshSettingsDescription>('settings.describe'),
    active.call<{ groups: DshModelGroup[]; failures: DshModelFailure[] }>('llm.models'),
  ]);
  const permission = permissionSettings(settings);
  return {
    configurationStatus: 'ready',
    configurationError: null,
    configurationWritable: settings.writable,
    modelSelection: configuredModel(settings, host),
    modelGroups: modelValue.groups,
    modelFailures: modelValue.failures,
    agentPresets: presetValue.presets,
    defaultAgentPreset: presetValue.presets.find((preset) => preset.isDefault)?.id ?? null,
    permissionPresets: permission?.options ?? [],
    defaultPermissionPreset: permission?.currentValue ?? null,
  };
}

async function loadSessionModel(active: DshController, sessionId: string, onlyIfUnset = false): Promise<void> {
  const directory = await active.call<DshModelDirectory>('session.models', { sessionId });
  if (controller !== active || useDshWorkspace.getState().activeSessionId !== sessionId) return;
  if (onlyIfUnset && useDshWorkspace.getState().modelSelection) return;
  useDshWorkspace.setState({
    modelSelection: directory.current,
    modelGroups: directory.groups,
    modelFailures: directory.failures,
    configurationError: null,
  });
}

async function listSessions(active: DshController, workspaceRoot: string): Promise<DshSession[]> {
  const value = await active.call<{ items: SessionSummaryWire[] }>('session.list');
  return sortSessions(value.items
    .filter((summary) => summary.origin !== 'subagent' && sameWorkspace(summary.cwd, workspaceRoot))
    .map((summary) => {
      const seq = summary.projections?.asOfSeq;
      const current = titleBySession.get(summary.sessionId);
      const summarySeq = Number.isInteger(seq) ? seq as number : -1;
      const summaryTitle = titleFromSummary(summary);
      const permission = permissionSelection(summary.projections?.values?.permissions);
      if (permission) permissionBySession.set(summary.sessionId, permission);
      if (summarySeq >= (current?.seq ?? -1)) {
        titleBySession.set(summary.sessionId, { seq: summarySeq, title: summaryTitle });
      }
      return {
        id: summary.sessionId,
        title: current && current.seq > summarySeq ? current.title : summaryTitle,
        updatedAt: summary.updatedAt,
        status: summary.running ? 'running' : 'idle',
        blank: summary.blank,
        ...(summary.agentPreset ? { agentPreset: summary.agentPreset } : {}),
      };
    }));
}

async function loadHistory(active: DshController, sessionId: string): Promise<void> {
  const history = await active.call<HistoryWire>('session.history', { sessionId, maxMessages: 200 });
  if (controller !== active) return;
  const events = eventMap(sessionId);
  for (const entry of history.events) {
    if (entry?.event && Number.isInteger(entry.event.seq)) events.set(entry.event.seq, entry.event);
  }
  if (history.projections?.values && 'title' in history.projections.values) {
    applyTitleProjection(sessionId, history.projections.values.title, history.projections.asOfSeq);
  }
  const permission = permissionSelection(history.projections?.values?.permissions);
  if (permission) {
    permissionBySession.set(sessionId, permission);
    if (useDshWorkspace.getState().activeSessionId === sessionId) {
      useDshWorkspace.setState({ activePermission: permission });
    }
  }
  flushTranscript(sessionId);
}

function requireController(): DshController {
  if (!controller || useDshWorkspace.getState().status !== 'ready') throw new Error('DSH 尚未连接');
  return controller;
}

async function disconnect(): Promise<void> {
  connectionGeneration += 1;
  const active = controller;
  controller = null;
  connectedWorkspace = null;
  if (active) await active.stop();
}

async function connectWorkspace(): Promise<void> {
  if (connectPromise) return connectPromise;
  const workspaceRoot = useDshWorkspace.getState().workspaceRoot.trim();
  if (!workspaceRoot) throw new Error('请先选择 DeepSeek 工作区');
  if (!isTauriRuntime()) throw new Error('网页版没有本地 DeepSeek 执行面，请使用 RocketX 桌面端');
  if (controller && connectedWorkspace === workspaceRoot && useDshWorkspace.getState().status === 'ready') {
    await useDshWorkspace.getState().refresh();
    return;
  }

  const operation = (async () => {
    const generation = ++connectionGeneration;
    const previous = controller;
    controller = null;
    connectedWorkspace = null;
    if (previous) await previous.stop();
    if (generation !== connectionGeneration) throw new Error('DSH 连接已被新的工作区取代');
    useDshWorkspace.setState({
      status: 'connecting',
      error: null,
      credentialConfigured: null,
      credentialWritable: false,
      configurationStatus: 'connecting',
      configurationError: null,
    });
    const next = new DshController(workspaceRoot, {
      onMux: (request) => handleMux(request, generation),
      onHost: (request) => handleHost(request, generation),
      onError: (error) => {
        if (generation === connectionGeneration) {
          resetDshConversationAfterDisconnect(error.message);
        }
      },
      onExit: () => {
        if (generation === connectionGeneration) {
          controller = null;
          connectedWorkspace = null;
          resetDshConversationAfterDisconnect('DSH 进程已退出');
        }
      },
    });
    controller = next;
    try {
      await next.start();
      if (generation !== connectionGeneration) return;
      const host = await next.call<DshHostDescriptionWire>('host.describe');
      const [sessions, credential, configuration] = await Promise.all([
        listSessions(next, workspaceRoot),
        describeCredential(next),
        readConfiguration(next, host).catch((reason) => ({
          configurationStatus: 'error' as const,
          configurationError: errorMessage(reason),
        })),
      ]);
      if (generation !== connectionGeneration) return;
      connectedWorkspace = workspaceRoot;
      const currentId = useDshWorkspace.getState().activeSessionId;
      const activeSessionId = sessions.some((session) => session.id === currentId)
        ? currentId
        : sessions.find((session) => !session.blank)?.id ?? null;
      const active = sessions.find((session) => session.id === activeSessionId);
      useDshWorkspace.setState({
        status: 'ready',
        error: null,
        sessions,
        activeSessionId,
        isRunning: active?.status === 'running',
        ...credential,
        ...configuration,
        ...(activeSessionId ? { modelSelection: null } : {}),
        ...activeConversationState(activeSessionId),
        ...(activeSessionId ? {} : { messages: [], activities: [] }),
      });
      if (activeSessionId) {
        await Promise.all([
          loadHistory(next, activeSessionId),
          loadSessionModel(next, activeSessionId).catch((reason) => {
            if (controller === next) useDshWorkspace.setState({ configurationError: errorMessage(reason) });
          }),
        ]);
      }
    } catch (reason) {
      if (generation === connectionGeneration) {
        resetDshConversationAfterDisconnect(errorMessage(reason));
        controller = null;
        connectedWorkspace = null;
      }
      await next.stop().catch(() => undefined);
      throw reason;
    }
  })();
  const tracked = operation.finally(() => {
    if (connectPromise === tracked) connectPromise = null;
  });
  connectPromise = tracked;
  return tracked;
}

export const useDshWorkspace = create<DshWorkspaceState>((set, get) => ({
  status: 'idle',
  error: null,
  workspaceRoot: savedWorkspaceRoot(),
  sessions: [],
  activeSessionId: null,
  messages: [],
  activities: [],
  pendingApproval: null,
  pendingQuestion: null,
  queuedMessages: [],
  isRunning: false,
  credentialConfigured: null,
  credentialWritable: false,
  configurationStatus: 'idle',
  configurationError: null,
  configurationWritable: false,
  modelSelection: null,
  modelGroups: [],
  modelFailures: [],
  agentPresets: [],
  defaultAgentPreset: null,
  permissionPresets: [],
  defaultPermissionPreset: null,
  activePermission: null,

  setWorkspaceRoot: async (path) => {
    const next = path.trim();
    if (!next || sameWorkspace(next, get().workspaceRoot)) return;
    const pendingConnect = connectPromise;
    await disconnect();
    if (pendingConnect) await pendingConnect.catch(() => undefined);
    for (const timer of transcriptRenderTimers.values()) clearTimeout(timer);
    transcriptRenderTimers.clear();
    eventsBySession.clear();
    approvalsBySession.clear();
    questionsBySession.clear();
    queueBySession.clear();
    titleBySession.clear();
    permissionBySession.clear();
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, next);
    } catch {
      // A private browsing policy may reject persistence; the in-memory workspace still works.
    }
    set({
      status: 'idle',
      error: null,
      workspaceRoot: next,
      sessions: [],
      activeSessionId: null,
      messages: [],
      activities: [],
      pendingApproval: null,
      pendingQuestion: null,
      queuedMessages: [],
      isRunning: false,
      credentialConfigured: null,
      credentialWritable: false,
      configurationStatus: 'idle',
      configurationError: null,
      configurationWritable: false,
      modelSelection: null,
      modelGroups: [],
      modelFailures: [],
      agentPresets: [],
      defaultAgentPreset: null,
      permissionPresets: [],
      defaultPermissionPreset: null,
      activePermission: null,
    });
  },

  connect: connectWorkspace,

  refresh: async () => {
    if (!controller || get().status !== 'ready') {
      await get().connect();
      return;
    }
    const active = controller;
    const workspaceRoot = get().workspaceRoot;
    set({ configurationStatus: 'connecting', configurationError: null });
    const host = await active.call<DshHostDescriptionWire>('host.describe');
    const [sessions, credential, configuration] = await Promise.all([
      listSessions(active, workspaceRoot),
      describeCredential(active),
      readConfiguration(active, host).catch((reason) => ({
        configurationStatus: 'error' as const,
        configurationError: errorMessage(reason),
      })),
    ]);
    if (controller !== active || !sameWorkspace(workspaceRoot, get().workspaceRoot)) return;
    const activeSessionId = sessions.some((session) => session.id === get().activeSessionId)
      ? get().activeSessionId
      : sessions.find((session) => !session.blank)?.id ?? null;
    const selected = sessions.find((session) => session.id === activeSessionId);
    set({
      sessions,
      activeSessionId,
      isRunning: selected?.status === 'running',
      ...credential,
      ...configuration,
      ...(activeSessionId ? { modelSelection: null } : {}),
      ...activeConversationState(activeSessionId),
      ...(activeSessionId ? {} : { messages: [], activities: [] }),
    });
    if (activeSessionId) {
      await Promise.all([
        loadHistory(active, activeSessionId),
        loadSessionModel(active, activeSessionId).catch((reason) => {
          if (controller === active) set({ configurationError: errorMessage(reason) });
        }),
      ]);
    }
  },

  startSession: async () => {
    const active = requireController();
    const existing = get().sessions.find((session) => session.blank);
    if (existing) {
      await get().openSession(existing.id);
      return;
    }
    const value = await active.call<{ sessionId: string; agentPreset?: string }>('session.create', {
      cwd: get().workspaceRoot,
    });
    const session: DshSession = {
      id: value.sessionId,
      updatedAt: Date.now(),
      status: 'idle',
      blank: true,
      ...(value.agentPreset ? { agentPreset: value.agentPreset } : {}),
    };
    if (get().defaultPermissionPreset) {
      permissionBySession.set(session.id, {
        currentValue: get().defaultPermissionPreset as string,
        options: get().permissionPresets,
      });
    }
    upsertSession(session);
    eventsBySession.set(session.id, new Map());
    set({
      activeSessionId: session.id,
      modelSelection: null,
      messages: [],
      activities: [],
      isRunning: false,
      ...activeConversationState(session.id),
    });
    void loadSessionModel(active, session.id, true).catch((reason) => {
      if (controller === active) set({ configurationError: errorMessage(reason) });
    });
  },

  openSession: async (id) => {
    const active = requireController();
    const session = get().sessions.find((entry) => entry.id === id);
    if (!session) throw new Error('DeepSeek 会话不存在');
    set({
      activeSessionId: id,
      modelSelection: null,
      messages: [],
      activities: [],
      isRunning: session.status === 'running',
      error: null,
      ...activeConversationState(id),
    });
    await Promise.all([
      loadHistory(active, id),
      loadSessionModel(active, id).catch((reason) => {
        if (controller === active) set({ configurationError: errorMessage(reason) });
      }),
    ]);
  },

  send: async (text) => {
    const value = text.trim();
    if (!value) return;
    if (get().credentialConfigured !== true) throw new Error('请先配置 DeepSeek API Key');
    if (!get().activeSessionId) await get().startSession();
    const sessionId = get().activeSessionId;
    if (!sessionId) throw new Error('无法创建 DeepSeek 会话');
    const active = requireController();
    set((state) => ({ error: state.activeSessionId === sessionId ? null : state.error }));
    await active.call('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: value }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    set((state) => ({
      isRunning: state.activeSessionId === sessionId ? true : state.isRunning,
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, status: 'running', blank: false, updatedAt: Date.now() }
        : session),
    }));
  },

  cancel: async () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await requireController().call('session.cancel', { sessionId });
  },

  respondApproval: async (approved) => {
    const approval = get().pendingApproval;
    if (!approval) return;
    await requireController().respond(approvalResponse(approval, approved));
    const remaining = (approvalsBySession.get(approval.sessionId) ?? [])
      .filter((entry) => entry.rpcId !== approval.rpcId);
    if (remaining.length > 0) approvalsBySession.set(approval.sessionId, remaining);
    else approvalsBySession.delete(approval.sessionId);
    if (get().activeSessionId === approval.sessionId) set({ pendingApproval: remaining[0] ?? null });
  },

  respondQuestion: async (answers) => {
    const question = get().pendingQuestion;
    if (!question) return;
    await requireController().respond(questionResponse(question, answers));
    const remaining = (questionsBySession.get(question.sessionId) ?? [])
      .filter((entry) => entry.rpcId !== question.rpcId);
    if (remaining.length > 0) questionsBySession.set(question.sessionId, remaining);
    else questionsBySession.delete(question.sessionId);
    if (get().activeSessionId === question.sessionId) set({ pendingQuestion: remaining[0] ?? null });
  },

  setDeepSeekApiKey: async (apiKey) => {
    const value = apiKey.trim();
    if (!value) throw new Error('DeepSeek API Key 不能为空');
    const active = requireController();
    await active.call('credentials.set', { ref: DEEPSEEK_API_KEY_REF, value });
    const credential = await describeCredential(active);
    if (controller === active) set(credential);
  },

  clearDeepSeekApiKey: async () => {
    const active = requireController();
    await active.call('credentials.unset', { ref: DEEPSEEK_API_KEY_REF });
    const credential = await describeCredential(active);
    if (controller === active) set(credential);
  },

  refreshConfiguration: async () => {
    const active = requireController();
    set({ configurationStatus: 'connecting', configurationError: null });
    try {
      const host = await active.call<DshHostDescriptionWire>('host.describe');
      const configuration = await readConfiguration(active, host);
      if (controller !== active) return;
      const sessionId = get().activeSessionId;
      set({
        ...configuration,
        ...(sessionId ? { modelSelection: null } : {}),
      });
      if (sessionId) await loadSessionModel(active, sessionId);
    } catch (reason) {
      if (controller === active) set({ configurationStatus: 'error', configurationError: errorMessage(reason) });
      throw reason;
    }
  },

  selectModel: async (selection) => {
    if (!selection.provider.trim() || !selection.model.trim()) throw new Error('请选择 DeepSeek 模型');
    if (!get().activeSessionId) await get().startSession();
    const sessionId = get().activeSessionId;
    if (!sessionId) throw new Error('无法创建用于选择模型的 DeepSeek 会话');
    const active = requireController();
    const value = await active.call<{ selected: DshModelSelection }>('session.selectModel', {
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    });
    if (controller === active && get().activeSessionId === sessionId) {
      set({ modelSelection: value.selected, configurationError: null });
    }
  },

  selectAgentPreset: async (agentPreset) => {
    const preset = get().agentPresets.find((entry) => entry.id === agentPreset && !entry.broken);
    if (!preset) throw new Error('所选 Agent preset 当前不可用');
    if (!get().configurationWritable) throw new Error('当前 DSH 设置不可写');
    const active = requireController();
    await active.call('settings.update', { ns: 'agent-presets', patch: { default: agentPreset } });
    const sessionId = get().activeSessionId;
    const session = get().sessions.find((entry) => entry.id === sessionId);
    if (sessionId && session?.blank) {
      const value = await active.call<{ agentPreset: string }>('agentPreset.select', { sessionId, agentPreset });
      if (controller === active) {
        set((state) => ({
          sessions: state.sessions.map((entry) => entry.id === sessionId
            ? { ...entry, agentPreset: value.agentPreset }
            : entry),
        }));
      }
    }
    if (controller === active) {
      set((state) => ({
        defaultAgentPreset: agentPreset,
        agentPresets: state.agentPresets.map((entry) => ({
          ...entry,
          isDefault: entry.id === agentPreset,
        })),
        configurationError: null,
      }));
    }
  },

  selectPermissionPreset: async (permissionPreset) => {
    const active = requireController();
    const described = await active.call<DshSettingsDescription>('settings.describe');
    const settings = permissionSettings(described);
    if (!settings?.writable) throw new Error('当前 DSH 权限设置不可写');
    if (!settings.options.some((option) => option.id === permissionPreset)) {
      throw new Error('所选权限 preset 当前不可用');
    }
    await active.call('settings.mutate', {
      ns: 'permission',
      ops: [{ op: 'set', path: ['defaultPreset'], value: permissionPreset }],
      expectedRevision: settings.revision,
    });
    if (controller === active) {
      set({
        defaultPermissionPreset: permissionPreset,
        permissionPresets: settings.options,
        configurationError: null,
      });
    }
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    try {
      const execution = await active.call<DshCommandExecutionWire | undefined>('commands/execute', {
        args: { agentId: sessionId, line: `/permission ${permissionPreset}` },
      });
      if (!execution) throw new Error('当前 DSH Agent 未提供 /permission 命令');
      if (execution.result.kind === 'error') {
        throw new Error(execution.result.text || 'DSH 拒绝切换当前会话权限');
      }
    } catch (reason) {
      throw new Error(`新会话默认已保存，但当前会话切换失败：${errorMessage(reason)}`);
    }
    const previous = permissionBySession.get(sessionId);
    const selected: DshPermissionSelection = {
      currentValue: permissionPreset,
      options: previous?.options.length ? previous.options : settings.options,
    };
    permissionBySession.set(sessionId, selected);
    if (controller === active && get().activeSessionId === sessionId) set({ activePermission: selected });
  },
}));
