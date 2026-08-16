import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import {
  AppServerController,
  permissionSettings,
  type AppServerControllerOptions,
  type CodexCatalog,
  type CodexPermissionPreset,
  type CodexRuntimeSelection,
} from '../agent/AppServerController';
import type { AppInfo } from '../agent/protocol/generated/v2/AppInfo';
import type { Model } from '../agent/protocol/generated/v2/Model';
import type { PermissionProfileSummary } from '../agent/protocol/generated/v2/PermissionProfileSummary';
import type { PluginDetail } from '../agent/protocol/generated/v2/PluginDetail';
import type { PluginListResponse } from '../agent/protocol/generated/v2/PluginListResponse';
import type { SkillMetadata } from '../agent/protocol/generated/v2/SkillMetadata';
import type { Thread } from '../agent/protocol/generated/v2/Thread';
import type { ThreadItem } from '../agent/protocol/generated/v2/ThreadItem';
import type { Turn } from '../agent/protocol/generated/v2/Turn';
import type { UserInput } from '../agent/protocol/generated/v2/UserInput';
import { materializeCodexImages } from '../agent/attachments';
import { openCodexThread } from '../agent/codexTransfer';
import {
  commandRequestMentionsSensitivePath,
  validateApprovalPaths,
  validatePermissionRequest,
} from '../agent/safety';
import {
  codexImageAttachments,
  type CodexGeneratedImage,
  type CodexImageAttachment,
  type CodexImageInput,
} from '../lib/codexImages';
import {
  extractButlerSources,
  mergeButlerSources,
  type ButlerSource,
} from '../lib/butlerContext';
import { isTauriRuntime } from '../lib/client';
import { useAgentEnvironments } from './agentEnvironments';

const STORAGE_PREFIX = 'rcx-codex-workspace-v1';
const MAX_EVENT_DETAIL = 64 * 1024;

export type CodexWorkspaceStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'running'
  | 'waiting-input'
  | 'interrupted'
  | 'external'
  | 'unavailable';
export type CodexFollowUpMode = 'queue' | 'steer';

export interface CodexWorkspaceMessage {
  id: string;
  role: 'user' | 'assistant';
  speaker?: string;
  text: string;
  attachments?: CodexImageAttachment[];
  generatedImages?: CodexGeneratedImage[];
  sources?: ButlerSource[];
  pending?: boolean;
}

export interface CodexWorkspaceEvent {
  id: string;
  type: ThreadItem['type'] | 'reasoning' | 'warning' | 'autoReview' | 'turnDiff' | 'terminal';
  title: string;
  summary?: string;
  detail?: string;
  status: 'running' | 'completed' | 'failed';
}

export interface CodexPendingRequest {
  id: string;
  kind: 'approval' | 'user-input' | 'mcp-input';
  method: string;
  threadId: string;
  turnId?: string;
  params: Record<string, unknown>;
}

export interface CodexRequestResolution {
  action: 'accept' | 'accept-session' | 'decline' | 'cancel';
  values?: Record<string, unknown>;
}

export interface CodexThreadState {
  workspaceRoot: string;
  runtimeSelection?: CodexRuntimeSelection;
  status: CodexWorkspaceStatus;
  error: string | null;
  activeTurnId?: string;
  turns: Turn[];
  messages: CodexWorkspaceMessage[];
  events: CodexWorkspaceEvent[];
  streamingText: string;
  pendingRequests: CodexPendingRequest[];
  queuedMessages: Array<{ id: string; text: string; images: CodexImageInput[] }>;
}

interface PersistedWorkspace {
  workspaceRoot?: string;
  workspaceRoots?: string[];
  selectedModel?: string;
  selectedEffort?: string | null;
  permissionPreset?: CodexPermissionPreset;
  followUpMode?: CodexFollowUpMode;
}

interface CodexWorkspaceState {
  scope: string;
  defaultWorkspaceRoot: string;
  butlerWorkspaceRoot: string;
  workspaceRoot: string;
  workspaceRoots: string[];
  status: CodexWorkspaceStatus;
  error: string | null;
  threads: Thread[];
  threadStates: Record<string, CodexThreadState>;
  activeThreadId?: string;
  activeTurnId?: string;
  turns: Turn[];
  messages: CodexWorkspaceMessage[];
  events: CodexWorkspaceEvent[];
  streamingText: string;
  composerDraft: string;
  pendingRequests: CodexPendingRequest[];
  queuedMessages: Array<{ id: string; text: string; images: CodexImageInput[] }>;
  models: Model[];
  permissionProfiles: PermissionProfileSummary[];
  skills: SkillMetadata[];
  apps: AppInfo[];
  plugins: PluginListResponse | null;
  catalogErrors: { apps?: string; plugins?: string };
  selectedModel: string;
  selectedEffort: string | null;
  permissionPreset: CodexPermissionPreset;
  followUpMode: CodexFollowUpMode;
  hydrate: (scope: string) => void;
  ensureDefaultWorkspace: () => Promise<string>;
  setWorkspaceRoot: (
    workspaceRoot: string,
    options?: { reuseRuntime?: boolean },
  ) => Promise<void>;
  removeWorkspaceRoot: (workspaceRoot: string) => Promise<void>;
  connect: (options?: { refreshThreads?: boolean }) => Promise<void>;
  refreshCatalog: () => Promise<void>;
  refreshThreads: () => Promise<void>;
  startThread: (name?: string) => Promise<string>;
  startTask: (text: string, name?: string) => Promise<string>;
  resumeThread: (threadId: string) => Promise<void>;
  refreshFromCodex: () => Promise<number>;
  handoffToCodex: () => Promise<'opened-existing' | 'unavailable'>;
  renameThread: (threadId: string, name: string) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  send: (
    text: string,
    images?: readonly CodexImageInput[],
    modeOverride?: CodexFollowUpMode,
  ) => Promise<void>;
  setComposerDraft: (text: string) => void;
  clearComposerDraft: () => void;
  interrupt: () => Promise<void>;
  resolveRequest: (requestId: string, resolution: CodexRequestResolution) => void;
  setModel: (model: string) => Promise<void>;
  setEffort: (effort: string | null) => Promise<void>;
  setPermissionPreset: (preset: CodexPermissionPreset) => Promise<void>;
  setFollowUpMode: (mode: CodexFollowUpMode) => void;
  installPlugin: (marketplace: string, pluginName: string) => Promise<void>;
  uninstallPlugin: (pluginId: string) => Promise<void>;
  readPlugin: (marketplace: string, pluginName: string) => Promise<PluginDetail>;
  readFile: (path: string) => Promise<string>;
  openArtifact: (path: string) => Promise<void>;
  revealArtifact: (path: string) => Promise<void>;
  setSkillEnabled: (path: string, enabled: boolean) => Promise<void>;
  shutdown: () => Promise<void>;
}

type ControllerFactory = (options: AppServerControllerOptions) => AppServerController;

let controller: AppServerController | undefined;
let controllerFactory: ControllerFactory = (options) => new AppServerController(options);
let resumeThreadRequestId = 0;
let connectRequest: Promise<void> | undefined;
let handoffInProgress = false;
const controllerOperations = new Set<symbol>();
let defaultWorkspaceRequest: Promise<string> | undefined;
let butlerWorkspaceRequest: Promise<string> | undefined;
const requestWaiters = new Map<string, {
  threadId: string;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();
const backgroundAutomationPermissions = new Map<string, Map<symbol, CodexPermissionPreset>>();

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function withControllerOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (handoffInProgress) throw new Error('会话正在交接给 Codex App，请稍后重试');
  const token = Symbol('controller-operation');
  controllerOperations.add(token);
  try {
    return await operation();
  } finally {
    controllerOperations.delete(token);
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isActiveWriterError(value: unknown): boolean {
  return /already has an active writer/i.test(message(value));
}

function isRuntimeDisconnectedError(value: unknown): boolean {
  return /Codex Runtime 尚未连接|Codex app-server process is not active/i.test(message(value));
}

function continuationName(thread: Thread): string {
  const base = thread.name?.trim() || thread.preview.trim() || 'Codex 任务';
  return base.endsWith('· RocketX 继续') ? base : `${base} · RocketX 继续`;
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}:${scope}`;
}

function persist(state: CodexWorkspaceState): void {
  if (!state.scope || typeof localStorage === 'undefined') return;
  const value: PersistedWorkspace = {
    workspaceRoot: state.workspaceRoot || undefined,
    workspaceRoots: state.workspaceRoots.length > 0 ? state.workspaceRoots : undefined,
    selectedModel: state.selectedModel || undefined,
    selectedEffort: state.selectedEffort,
    permissionPreset: state.permissionPreset,
    followUpMode: state.followUpMode,
  };
  localStorage.setItem(storageKey(state.scope), JSON.stringify(value));
}

function selection(state = useCodexWorkspace.getState()): CodexRuntimeSelection {
  if (!state.selectedModel) throw new Error('Codex 尚未返回可用模型');
  return {
    model: state.selectedModel,
    effort: state.selectedEffort,
    permissionPreset: state.permissionPreset,
  };
}

function defaultSelection(catalog: CodexCatalog, saved: CodexWorkspaceState): {
  selectedModel: string;
  selectedEffort: string | null;
} {
  const model = catalog.models.find((item) => (
    item.model === saved.selectedModel || item.id === saved.selectedModel
  )) ?? catalog.models.find((item) => item.isDefault) ?? catalog.models[0];
  if (!model) throw new Error('当前 Codex Runtime 没有可用模型，请升级或检查模型配置。');
  const effort = saved.selectedEffort
    && model.supportedReasoningEfforts.some((item) => item.reasoningEffort === saved.selectedEffort)
    ? saved.selectedEffort
    : model.defaultReasoningEffort;
  return { selectedModel: model.model, selectedEffort: effort };
}

function workspacePathKey(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function isSystemCodexWorkspace(
  path: string,
  defaultWorkspaceRoot: string,
  butlerWorkspaceRoot: string,
): boolean {
  const key = workspacePathKey(path);
  return Boolean(key) && (
    key === workspacePathKey(defaultWorkspaceRoot)
    || key === workspacePathKey(butlerWorkspaceRoot)
  );
}

function threadWorkspaceRoots(state: CodexWorkspaceState): string[] {
  const roots = [
    state.defaultWorkspaceRoot,
    state.butlerWorkspaceRoot,
    ...useAgentEnvironments.getState().environments.map((environment) => environment.path),
    ...state.workspaceRoots,
    state.workspaceRoot,
  ];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = workspacePathKey(root);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function textFromUserInput(input: unknown): string {
  const value = record(input);
  return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
}

function attachmentFromUserInput(input: unknown): CodexImageAttachment | null {
  const value = record(input);
  if (value.type !== 'localImage' && value.type !== 'image') return null;
  const source = typeof value.path === 'string'
    ? value.path
    : typeof value.url === 'string'
      ? value.url
      : '';
  const name = source.split(/[\\/]/).filter(Boolean).at(-1) ?? '图片';
  return { name, type: 'image' };
}

function generatedImageFromItem(
  item: Extract<ThreadItem, { type: 'imageGeneration' }>,
): CodexGeneratedImage | null {
  if (!item.result) return null;
  const name = item.savedPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? `${item.id}.png`;
  return {
    id: item.id,
    name,
    dataUrl: item.result.startsWith('data:') ? item.result : `data:image/png;base64,${item.result}`,
    savedPath: item.savedPath,
    alt: item.revisedPrompt?.trim() || 'Codex 生成的图片',
  };
}

function boundedDetail(value: string): string {
  return value.length <= MAX_EVENT_DETAIL
    ? value
    : `${value.slice(value.length - MAX_EVENT_DETAIL)}\n… 输出过长，仅显示最后 64 KiB`;
}

function jsonDetail(value: unknown): string {
  try {
    return boundedDetail(JSON.stringify(value, null, 2));
  } catch {
    return String(value);
  }
}

function durationSummary(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function completedStatus(
  itemStatus: string | undefined,
  fallback: CodexWorkspaceEvent['status'],
): CodexWorkspaceEvent['status'] {
  return itemStatus === 'failed' || itemStatus === 'declined' ? 'failed' : fallback;
}

function sourceText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const text = record(value).text;
  if (typeof text === 'string') return text;
  try {
    return value === null ? null : JSON.stringify(value);
  } catch {
    return null;
  }
}

function sourcesFromToolItem(item: ThreadItem): ButlerSource[] {
  if (item.type !== 'dynamicToolCall' && item.type !== 'mcpToolCall') return [];
  const contents = item.type === 'dynamicToolCall'
    ? (item.contentItems ?? []).flatMap((content) => (
      content.type === 'inputText' ? [content.text] : []
    ))
    : item.result
      ? [item.result.structuredContent, ...item.result.content]
        .map(sourceText)
        .filter((content): content is string => content !== null)
      : [];
  const suffix = item.tool.split(/__|[./:]/).filter(Boolean).at(-1);
  const toolNames = suffix && suffix !== item.tool ? [item.tool, suffix] : [item.tool];
  return mergeButlerSources(...toolNames.flatMap((toolName) => (
    contents.map((content) => extractButlerSources(toolName, content))
  )));
}

export function messagesFromTurns(turns: readonly Turn[]): CodexWorkspaceMessage[] {
  return turns.flatMap((turn) => {
    const messages: CodexWorkspaceMessage[] = [];
    const generatedImages: CodexGeneratedImage[] = [];
    let pendingSources: ButlerSource[] = [];
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        const text = item.content.map(textFromUserInput).filter(Boolean).join('\n');
        const attachments = item.content.map(attachmentFromUserInput).filter((entry) => entry !== null);
        if (text || attachments.length > 0) messages.push({ id: item.id, role: 'user', text, attachments });
      } else if (item.type === 'agentMessage' && item.text.trim()) {
        const sources = item.phase === 'commentary' ? [] : pendingSources;
        messages.push({
          id: item.id,
          role: 'assistant',
          text: item.text,
          ...(sources.length > 0 ? { sources } : {}),
        });
        if (item.phase !== 'commentary') pendingSources = [];
      } else if (item.type === 'dynamicToolCall' || item.type === 'mcpToolCall') {
        pendingSources = mergeButlerSources(pendingSources, sourcesFromToolItem(item));
      } else if (item.type === 'imageGeneration') {
        const image = generatedImageFromItem(item);
        if (image) generatedImages.push(image);
      }
    }
    if (generatedImages.length > 0) {
      let assistantIndex = messages.length - 1;
      while (assistantIndex >= 0 && messages[assistantIndex].role !== 'assistant') assistantIndex -= 1;
      if (assistantIndex >= 0) {
        messages[assistantIndex] = { ...messages[assistantIndex], generatedImages };
      } else {
        messages.push({
          id: `generated-images-${turn.id}`,
          role: 'assistant',
          text: '',
          generatedImages,
        });
      }
    }
    return messages;
  });
}

function eventFromItem(item: ThreadItem, status: CodexWorkspaceEvent['status']): CodexWorkspaceEvent | null {
  if (item.type === 'commandExecution') {
    const metadata = [
      item.exitCode === null ? null : `退出码 ${item.exitCode}`,
      durationSummary(item.durationMs),
    ].filter(Boolean).join(' · ');
    return {
      id: item.id,
      type: item.type,
      title: '运行命令',
      summary: item.command,
      detail: boundedDetail([item.aggregatedOutput, metadata].filter(Boolean).join('\n\n')) || undefined,
      status: completedStatus(item.status, status),
    };
  }
  if (item.type === 'fileChange') {
    return {
      id: item.id,
      type: item.type,
      title: '修改文件',
      summary: item.changes.map((change) => change.path).join('、'),
      status: completedStatus(item.status, status),
    };
  }
  if (item.type === 'mcpToolCall') {
    return {
      id: item.id,
      type: item.type,
      title: item.tool,
      summary: item.server,
      detail: item.error?.message ?? (item.result ? jsonDetail(item.result) : undefined),
      status: completedStatus(item.status, status),
    };
  }
  if (item.type === 'dynamicToolCall') {
    return {
      id: item.id,
      type: item.type,
      title: item.tool,
      summary: item.namespace ?? undefined,
      detail: item.contentItems ? jsonDetail(item.contentItems) : undefined,
      status: completedStatus(item.status, status),
    };
  }
  if (item.type === 'plan') {
    return { id: item.id, type: item.type, title: '更新计划', detail: item.text, status };
  }
  if (item.type === 'reasoning') {
    return {
      id: item.id,
      type: item.type,
      title: '思考',
      detail: boundedDetail([...item.summary, ...item.content].join('\n')) || undefined,
      status,
    };
  }
  if (item.type === 'collabAgentToolCall') {
    return {
      id: item.id,
      type: item.type,
      title: '协作代理',
      summary: item.tool,
      detail: item.prompt ?? (item.receiverThreadIds.join('、') || undefined),
      status: completedStatus(item.status, status),
    };
  }
  if (item.type === 'subAgentActivity') {
    return { id: item.id, type: item.type, title: '协作代理', summary: item.agentPath, detail: item.kind, status };
  }
  if (item.type === 'webSearch') {
    const value = record(item);
    return { id: item.id, type: item.type, title: '搜索网络', summary: typeof value.query === 'string' ? value.query : undefined, status };
  }
  if (item.type === 'imageView') {
    return { id: item.id, type: item.type, title: '查看图片', summary: item.path, status };
  }
  if (item.type === 'imageGeneration') {
    return { id: item.id, type: item.type, title: '生成图片', status };
  }
  if (item.type === 'sleep') {
    return { id: item.id, type: item.type, title: '等待', summary: durationSummary(item.durationMs) ?? undefined, status };
  }
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    return { id: item.id, type: item.type, title: item.type === 'enteredReviewMode' ? '进入审查' : '完成审查', detail: item.review, status };
  }
  if (item.type === 'contextCompaction') {
    return { id: item.id, type: item.type, title: '压缩上下文', status };
  }
  return null;
}

function emptyThreadState(status: CodexWorkspaceStatus = 'ready'): CodexThreadState {
  return {
    workspaceRoot: '',
    runtimeSelection: undefined,
    status,
    error: null,
    activeTurnId: undefined,
    turns: [],
    messages: [],
    events: [],
    streamingText: '',
    pendingRequests: [],
    queuedMessages: [],
  };
}

function threadSelection(thread: CodexThreadState, state = useCodexWorkspace.getState()): CodexRuntimeSelection {
  return thread.runtimeSelection ?? selection(state);
}

async function ensureControllerWorkspace(workspaceRoot: string): Promise<void> {
  if (!workspaceRoot.trim()) return;
  if (handoffInProgress) throw new Error('会话正在交接给 Codex App，请稍后重试');
  if (connectRequest) await connectRequest;
  if (!controller) await useCodexWorkspace.getState().connect();
  const activeController = controller;
  if (!activeController) return;
  if (
    activeController.currentWorkspaceRoot !== workspaceRoot
    && typeof (activeController as Partial<AppServerController>).switchWorkspaceRoot === 'function'
  ) {
    activeController.switchWorkspaceRoot(workspaceRoot);
  }
}

async function unsubscribeThreadIfSupported(target: unknown, threadId: string): Promise<void> {
  const candidate = target as { unsubscribeThread?: (value: string) => Promise<void> } | undefined;
  if (typeof candidate?.unsubscribeThread !== 'function') return;
  await candidate.unsubscribeThread(threadId);
}

function currentThreadState(
  state: Pick<CodexWorkspaceState, 'threadStates'>,
  threadId: string | undefined,
  fallbackStatus: CodexWorkspaceStatus = 'ready',
): CodexThreadState {
  if (!threadId) return emptyThreadState(fallbackStatus);
  return state.threadStates[threadId] ?? emptyThreadState(fallbackStatus);
}

function projectedThreadState(thread: CodexThreadState): Pick<
  CodexWorkspaceState,
  'status' | 'error' | 'activeTurnId' | 'turns' | 'messages' | 'events' | 'streamingText' | 'pendingRequests' | 'queuedMessages'
> {
  return {
    status: thread.status,
    error: thread.error,
    activeTurnId: thread.activeTurnId,
    turns: thread.turns,
    messages: thread.messages,
    events: thread.events,
    streamingText: thread.streamingText,
    pendingRequests: thread.pendingRequests,
    queuedMessages: thread.queuedMessages,
  };
}

function setThreadState(
  threadId: string,
  updater: (thread: CodexThreadState) => CodexThreadState,
): void {
  useCodexWorkspace.setState((state) => {
    const nextThread = updater(currentThreadState(state, threadId, state.activeThreadId ? state.status : 'ready'));
    return {
      threadStates: { ...state.threadStates, [threadId]: nextThread },
      ...(state.activeThreadId === threadId ? projectedThreadState(nextThread) : {}),
    };
  });
}

function setActiveThread(threadId: string | undefined, fallbackStatus: CodexWorkspaceStatus = 'ready'): void {
  useCodexWorkspace.setState((state) => ({
    activeThreadId: threadId,
    ...(threadId
      ? projectedThreadState(currentThreadState(state, threadId, fallbackStatus))
      : {
          status: fallbackStatus,
          error: null,
          activeTurnId: undefined,
          turns: [],
          messages: [],
          events: [],
          streamingText: '',
          pendingRequests: [],
          queuedMessages: [],
        }),
  }));
}

function rejectPendingRequests(reason: string, threadId?: string): void {
  for (const [requestId, waiter] of requestWaiters.entries()) {
    if (threadId && waiter.threadId !== threadId) continue;
    waiter.reject(new Error(reason));
    requestWaiters.delete(requestId);
  }
  if (threadId) {
    setThreadState(threadId, (thread) => ({ ...thread, pendingRequests: [] }));
    return;
  }
  useCodexWorkspace.setState((state) => ({
    threadStates: Object.fromEntries(Object.entries(state.threadStates).map(([id, thread]) => [
      id,
      { ...thread, pendingRequests: [] },
    ])),
    pendingRequests: [],
  }));
}

function upsertEvent(threadId: string, event: CodexWorkspaceEvent): void {
  setThreadState(threadId, (thread) => ({
    ...thread,
    events: thread.events.some((item) => item.id === event.id)
      ? thread.events.map((item) => item.id === event.id ? event : item)
      : [...thread.events, event],
  }));
}

function appendEventDetail(
  threadId: string,
  eventId: string,
  delta: string,
  fallback: Omit<CodexWorkspaceEvent, 'id' | 'detail'>,
): void {
  if (!delta) return;
  setThreadState(threadId, (thread) => {
    const existing = thread.events.find((event) => event.id === eventId);
    const next: CodexWorkspaceEvent = existing
      ? { ...existing, detail: boundedDetail(`${existing.detail ?? ''}${delta}`) }
      : { id: eventId, ...fallback, detail: boundedDetail(delta) };
    return {
      ...thread,
      events: existing
        ? thread.events.map((event) => event.id === eventId ? next : event)
        : [...thread.events, next],
    };
  });
}

async function reloadThread(threadId: string): Promise<void> {
  if (!controller) return;
  const loaded = await controller.readThread(threadId);
  setThreadState(threadId, (thread) => ({
    ...thread,
    turns: loaded.turns,
    messages: messagesFromTurns(loaded.turns),
  }));
}

async function drainQueue(threadId: string): Promise<void> {
  const state = useCodexWorkspace.getState();
  const thread = currentThreadState(state, threadId);
  if (thread.status !== 'ready' || thread.queuedMessages.length === 0) return;
  const [next, ...rest] = thread.queuedMessages;
  setThreadState(threadId, (current) => ({ ...current, queuedMessages: rest }));
  await sendThreadMessage(threadId, next.text, next.images);
}

function onNotification(method: string, value: unknown): void {
  const params = record(value);
  const threadId = typeof params.threadId === 'string'
    ? params.threadId
    : useCodexWorkspace.getState().activeThreadId;
  if (!threadId) return;
  if (method === 'turn/started') {
    const turn = record(params.turn);
    setThreadState(threadId, (thread) => ({
      ...thread,
      status: 'running',
      activeTurnId: typeof turn.id === 'string' ? turn.id : thread.activeTurnId,
    }));
    return;
  }
  if (method === 'item/agentMessage/delta') {
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (delta) setThreadState(threadId, (thread) => ({ ...thread, streamingText: thread.streamingText + delta }));
    return;
  }
  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    const delta = typeof params.delta === 'string' ? params.delta : '';
    const itemId = typeof params.itemId === 'string' ? params.itemId : 'active-reasoning';
    appendEventDetail(threadId, itemId, delta, { type: 'reasoning', title: '思考', status: 'running' });
    return;
  }
  if (method === 'item/plan/delta') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : 'active-plan';
    appendEventDetail(threadId, itemId, typeof params.delta === 'string' ? params.delta : '', {
      type: 'plan',
      title: '更新计划',
      status: 'running',
    });
    return;
  }
  if (method === 'item/commandExecution/outputDelta') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : 'active-command';
    appendEventDetail(threadId, itemId, typeof params.delta === 'string' ? params.delta : '', {
      type: 'commandExecution',
      title: '运行命令',
      status: 'running',
    });
    return;
  }
  if (method === 'turn/diff/updated') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : 'active';
    const diff = typeof params.diff === 'string' ? boundedDetail(params.diff) : '';
    if (diff) {
      setThreadState(threadId, (thread) => ({
        ...thread,
        events: thread.events.some((event) => event.id === `turn-diff-${turnId}`)
          ? thread.events.map((event) => event.id === `turn-diff-${turnId}`
            ? { ...event, detail: diff, status: 'running' as const }
            : event)
          : [...thread.events, {
              id: `turn-diff-${turnId}`,
              type: 'turnDiff',
              title: '代码改动',
              detail: diff,
              status: 'running',
            }],
      }));
    }
    return;
  }
  if (method === 'item/commandExecution/terminalInteraction') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : 'active-terminal';
    upsertEvent(threadId, {
      id: `terminal-${itemId}`,
      type: 'terminal',
      title: '终端交互',
      summary: typeof params.processId === 'string' ? params.processId : undefined,
      detail: '已向运行中的命令发送输入',
      status: 'completed',
    });
    return;
  }
  if (method === 'item/mcpToolCall/progress') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : 'active-mcp';
    appendEventDetail(threadId, itemId, typeof params.message === 'string' ? `${params.message}\n` : '', {
      type: 'mcpToolCall',
      title: '调用工具',
      status: 'running',
    });
    return;
  }
  if (method === 'item/fileChange/patchUpdated') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : 'active-file-change';
    const changes = Array.isArray(params.changes) ? params.changes : [];
    const paths = changes.map((change) => record(change).path).filter((path): path is string => typeof path === 'string');
    upsertEvent(threadId, {
      id: itemId,
      type: 'fileChange',
      title: '修改文件',
      summary: paths.join('、'),
      status: 'running',
    });
    return;
  }
  if (method === 'turn/plan/updated') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : 'active';
    const plan = Array.isArray(params.plan) ? params.plan : [];
    const lines = plan.map((step) => {
      const value = record(step);
      const label = typeof value.step === 'string' ? value.step : typeof value.description === 'string' ? value.description : '';
      return label ? `${value.status === 'completed' ? '✓' : value.status === 'in_progress' ? '→' : '·'} ${label}` : '';
    }).filter(Boolean);
    upsertEvent(threadId, {
      id: `turn-plan-${turnId}`,
      type: 'plan',
      title: '计划',
      summary: typeof params.explanation === 'string' ? params.explanation : undefined,
      detail: lines.join('\n') || undefined,
      status: 'running',
    });
    return;
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item as ThreadItem | undefined;
    if (item && typeof item === 'object' && 'type' in item) {
      const event = eventFromItem(item, method === 'item/started' ? 'running' : 'completed');
      if (event) upsertEvent(threadId, event);
    }
    return;
  }
  if (method === 'item/autoApprovalReview/started' || method === 'item/autoApprovalReview/completed') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : 'active';
    upsertEvent(threadId, {
      id: `auto-review-${itemId}`,
      type: 'autoReview',
      title: '替我审批',
      status: method.endsWith('/started') ? 'running' : 'completed',
    });
    return;
  }
  if (method === 'warning' || method === 'error') {
    upsertEvent(threadId, {
      id: id(method),
      type: 'warning',
      title: method === 'error' ? '运行错误' : '运行提示',
      detail: JSON.stringify(params).slice(0, 1_000),
      status: method === 'error' ? 'failed' : 'completed',
    });
    return;
  }
  if (method !== 'turn/completed') return;
  const turn = record(params.turn);
  const failed = turn.status === 'failed';
  const interrupted = turn.status === 'interrupted';
  const unsuccessful = failed || interrupted;
  const streamed = currentThreadState(useCodexWorkspace.getState(), threadId).streamingText.trim();
  setThreadState(threadId, (thread) => ({
    ...thread,
    status: 'ready',
    activeTurnId: undefined,
    streamingText: '',
    error: interrupted ? 'Codex 本轮已中断' : failed ? 'Codex 本轮未完成' : null,
    events: thread.events.map((event) => event.status === 'running'
      ? { ...event, status: unsuccessful ? 'failed' as const : 'completed' as const }
      : event),
    messages: streamed
      ? [...thread.messages, { id: id('assistant'), role: 'assistant', text: streamed }]
      : thread.messages,
  }));
  void reloadThread(threadId)
    .catch(() => undefined)
    .finally(() => void useCodexWorkspace.getState().refreshThreads().catch(() => undefined))
    .finally(() => void drainQueue(threadId));
}

async function onServerRequest(request: {
  method: string;
  params: unknown;
  policy: 'host-approval' | 'host-input' | 'dynamic-tool' | 'local-safe' | 'safe-reject' | 'unknown';
}): Promise<unknown> {
  const params = record(request.params);
  const threadId = typeof params.threadId === 'string' ? params.threadId : '';
  const backgroundPermission = [...(backgroundAutomationPermissions.get(threadId)?.values() ?? [])].at(-1);
  if (backgroundPermission) {
    if (request.policy === 'host-input') {
      throw new Error('该已安排任务需要用户输入，请手动运行后回答');
    }
    if (request.method === 'item/permissions/requestApproval') {
      if (backgroundPermission === 'ask') {
        throw new Error('该已安排任务需要审批，请打开对话后手动运行');
      }
      return { permissions: {}, scope: 'turn', strictAutoReview: true };
    }
    if (request.policy === 'host-approval') {
      if (backgroundPermission === 'ask') {
        throw new Error('该已安排任务需要审批，请打开对话后手动运行');
      }
      return { decision: 'decline' };
    }
    throw new Error(`无人值守任务不能处理 ${request.method}`);
  }
  if (!threadId || !useCodexWorkspace.getState().threadStates[threadId]) {
    throw new Error('请求不属于当前 Codex 任务');
  }
  if (request.policy !== 'host-approval' && request.policy !== 'host-input') {
    throw new Error(`当前 Codex 工作区不接受 ${request.method}`);
  }
  const requestId = id('request');
  const kind = request.method === 'item/tool/requestUserInput'
    ? 'user-input'
    : request.method === 'mcpServer/elicitation/request'
      ? 'mcp-input'
      : 'approval';
  const pending: CodexPendingRequest = {
    id: requestId,
    kind,
    method: request.method,
    threadId,
    turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
    params,
  };
  setThreadState(threadId, (thread) => ({
    ...thread,
    pendingRequests: [...thread.pendingRequests, pending],
    status: 'waiting-input',
  }));
  return new Promise((resolve, reject) => {
    requestWaiters.set(requestId, { threadId, method: request.method, resolve, reject });
  });
}

function makeController(): AppServerController {
  let managedController: AppServerController;
  managedController = controllerFactory({
    onNotification,
    onServerRequest,
    onInterrupted: (error) => {
      if (controller !== managedController) return;
      const current = useCodexWorkspace.getState();
      rejectPendingRequests(error.message);
      const nextThreadStates = Object.fromEntries(
        Object.entries(current.threadStates).map(([threadId, thread]) => {
          const interrupted = Boolean(thread.activeTurnId);
          const queuedMessages = threadId === current.activeThreadId && current.queuedMessages.length > 0
            ? current.queuedMessages
            : thread.queuedMessages;
          const streamed = (threadId === current.activeThreadId && current.streamingText
            ? current.streamingText
            : thread.streamingText).trim();
          const interruptionError = interrupted && queuedMessages.length > 0
            ? `${error.message}；${queuedMessages.length} 条排队消息未执行`
            : error.message;
          return [threadId, {
            ...thread,
            status: interrupted ? 'interrupted' : thread.status === 'external' ? 'external' : 'unavailable',
            activeTurnId: undefined,
            streamingText: '',
            queuedMessages: [],
            error: interruptionError,
            events: interrupted
              ? thread.events.map((event) => event.status === 'running'
                ? { ...event, status: 'failed' as const }
                : event)
              : thread.events,
            messages: interrupted && streamed
              ? [...thread.messages, { id: id('assistant'), role: 'assistant', text: streamed }]
              : thread.messages,
          } satisfies CodexThreadState];
        }),
      ) as Record<string, CodexThreadState>;
      controller = undefined;
      connectRequest = undefined;
      useCodexWorkspace.setState((state) => {
        const activeThread = state.activeThreadId
          ? nextThreadStates[state.activeThreadId] ?? emptyThreadState('unavailable')
          : emptyThreadState('unavailable');
        return {
          threadStates: nextThreadStates,
          ...projectedThreadState(activeThread),
        };
      });
    },
  });
  return managedController;
}

async function sendThreadMessageUnsafe(
  threadId: string,
  value: string,
  images: readonly CodexImageInput[] = [],
  modeOverride?: CodexFollowUpMode,
): Promise<void> {
  const text = value.trim();
  const imageList = [...images];
  if (!text && imageList.length === 0) return;
  if (!controller) await useCodexWorkspace.getState().connect();
  const state = useCodexWorkspace.getState();
  const thread = currentThreadState(state, threadId);
  const runtimeSelection = threadSelection(thread, state);
  await ensureControllerWorkspace(thread.workspaceRoot || state.workspaceRoot);
  if (thread.activeTurnId || thread.status === 'running' || thread.status === 'waiting-input') {
    const followUp = modeOverride ?? state.followUpMode;
    if (followUp === 'queue' || imageList.length > 0) {
      setThreadState(threadId, (current) => ({
        ...current,
        queuedMessages: [...current.queuedMessages, { id: id('queued'), text, images: imageList }],
      }));
      return;
    }
    if (!thread.activeTurnId) throw new Error('Codex Turn 尚未就绪，暂时无法 Steer');
    const input: UserInput[] = [{ type: 'text', text, text_elements: [] }];
    await controller!.steerTurn(threadId, thread.activeTurnId, input);
    setThreadState(threadId, (current) => ({
      ...current,
      messages: [...current.messages, { id: id('user'), role: 'user', text }],
    }));
    return;
  }
  let materialized = { paths: [] as string[], roots: [] as string[] };
  if (imageList.length > 0) {
    const sessionId = controller!.currentSessionId;
    if (!sessionId) throw new Error('Codex Runtime 尚未准备好附件目录');
    materialized = await materializeCodexImages(sessionId, imageList);
  }
  const input: UserInput[] = [
    ...(text ? [{ type: 'text' as const, text, text_elements: [] }] : []),
    ...materialized.paths.map((path) => ({ type: 'localImage' as const, path })),
  ];
  setThreadState(threadId, (current) => ({
    ...current,
    status: 'running',
    error: null,
    streamingText: '',
    events: [],
    messages: [...current.messages, {
      id: id('user'),
      role: 'user',
      text,
      attachments: codexImageAttachments(imageList),
      pending: true,
    }],
  }));
  try {
    const turnId = await controller!.startTurn(threadId, input, runtimeSelection, {
      runtimeWorkspaceRoots: materialized.roots,
    });
    setThreadState(threadId, (current) => ({
      ...current,
      activeTurnId: turnId,
      status: 'running',
      workspaceRoot: current.workspaceRoot || state.workspaceRoot,
      runtimeSelection,
    }));
  } catch (error) {
    setThreadState(threadId, (current) => ({ ...current, status: 'ready', error: message(error) }));
    throw error;
  }
}

async function sendThreadMessage(
  threadId: string,
  value: string,
  images: readonly CodexImageInput[] = [],
  modeOverride?: CodexFollowUpMode,
): Promise<void> {
  return withControllerOperation(() => sendThreadMessageUnsafe(threadId, value, images, modeOverride));
}

export const useCodexWorkspace = create<CodexWorkspaceState>((set, get) => ({
  scope: '',
  defaultWorkspaceRoot: '',
  butlerWorkspaceRoot: '',
  workspaceRoot: '',
  workspaceRoots: [],
  status: 'idle',
  error: null,
  threads: [],
  threadStates: {},
  turns: [],
  messages: [],
  events: [],
  streamingText: '',
  composerDraft: '',
  pendingRequests: [],
  queuedMessages: [],
  models: [],
  permissionProfiles: [],
  skills: [],
  apps: [],
  plugins: null,
  catalogErrors: {},
  selectedModel: '',
  selectedEffort: null,
  permissionPreset: 'auto',
  followUpMode: 'steer',

  hydrate: (scope) => {
    if (!scope || scope === get().scope) return;
    void controller?.stop();
    controller = undefined;
    rejectPendingRequests('账号已切换');
    let saved: PersistedWorkspace = {};
    try {
      saved = typeof localStorage === 'undefined'
        ? {}
        : JSON.parse(localStorage.getItem(storageKey(scope)) ?? '{}') as PersistedWorkspace;
    } catch {
      saved = {};
    }
    const workspaceRoot = typeof saved.workspaceRoot === 'string' ? saved.workspaceRoot : '';
    const workspaceRoots = Array.isArray(saved.workspaceRoots)
      ? saved.workspaceRoots.filter((root): root is string => typeof root === 'string' && Boolean(root.trim()))
      : [];
    if (workspaceRoot && !workspaceRoots.includes(workspaceRoot)) workspaceRoots.unshift(workspaceRoot);
    set({
      scope,
      defaultWorkspaceRoot: '',
      butlerWorkspaceRoot: '',
      workspaceRoot,
      workspaceRoots,
      selectedModel: saved.selectedModel ?? '',
      selectedEffort: saved.selectedEffort ?? null,
      permissionPreset: ['ask', 'auto', 'full'].includes(saved.permissionPreset ?? '')
        ? saved.permissionPreset as CodexPermissionPreset
        : 'auto',
      followUpMode: saved.followUpMode === 'queue' ? 'queue' : 'steer',
      status: 'idle',
      error: null,
      threads: [],
      threadStates: {},
      activeThreadId: undefined,
      activeTurnId: undefined,
      turns: [],
      messages: [],
      events: [],
      streamingText: '',
      composerDraft: '',
      pendingRequests: [],
      queuedMessages: [],
      models: [],
      permissionProfiles: [],
      skills: [],
      apps: [],
      plugins: null,
      catalogErrors: {},
    });
    void get().ensureDefaultWorkspace().catch(() => undefined);
  },

  ensureDefaultWorkspace: async () => {
    const current = get();
    if (current.defaultWorkspaceRoot && current.butlerWorkspaceRoot) return current.defaultWorkspaceRoot;
    if (!current.scope || !isTauriRuntime()) return '';
    const scope = current.scope;
    defaultWorkspaceRequest ??= invoke<string>('codex_default_workspace')
      .then((value) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error('默认工作区路径不可用');
        return value;
      })
      .catch((error) => {
        defaultWorkspaceRequest = undefined;
        throw error;
      });
    butlerWorkspaceRequest ??= invoke<string>('codex_butler_workspace')
      .then((value) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error('管家工作区路径不可用');
        return value;
      })
      .catch((error) => {
        butlerWorkspaceRequest = undefined;
        throw error;
      });
    const [defaultValue, butlerValue] = await Promise.all([
      current.defaultWorkspaceRoot || defaultWorkspaceRequest,
      current.butlerWorkspaceRoot || butlerWorkspaceRequest,
    ]);
    const defaultWorkspaceRoot = defaultValue.trim();
    const butlerWorkspaceRoot = butlerValue.trim();
    if (!defaultWorkspaceRoot || !butlerWorkspaceRoot || get().scope !== scope) return '';
    const latest = get();
    const legacyWorkspaceRoots = latest.workspaceRoots.filter((root) => !isSystemCodexWorkspace(
      root,
      defaultWorkspaceRoot,
      butlerWorkspaceRoot,
    ));
    const migration = legacyWorkspaceRoots.length > 0
      ? useAgentEnvironments.getState().importLegacyWorkspaceRoots(legacyWorkspaceRoots)
      : { environments: [], persisted: true };
    const currentWorkspaceRoot = latest.workspaceRoot.trim();
    const retainedLegacyRoots = migration.persisted
      ? []
      : legacyWorkspaceRoots;
    const workspaceRoots = [
      defaultWorkspaceRoot,
      butlerWorkspaceRoot,
      ...retainedLegacyRoots,
    ];
    set({
      defaultWorkspaceRoot,
      butlerWorkspaceRoot,
      workspaceRoot: !currentWorkspaceRoot || workspacePathKey(currentWorkspaceRoot) === workspacePathKey(defaultWorkspaceRoot)
        ? butlerWorkspaceRoot
        : currentWorkspaceRoot,
      workspaceRoots: [...new Set(workspaceRoots)],
    });
    persist(get());
    return defaultWorkspaceRoot;
  },

  setWorkspaceRoot: async (workspaceRoot) => {
    if (handoffInProgress) throw new Error('会话正在交接给 Codex App，请稍后重试');
    const normalized = workspaceRoot.trim();
    const current = get();
    const systemRootsReady = Boolean(current.defaultWorkspaceRoot && current.butlerWorkspaceRoot);
    if (
      normalized
      && systemRootsReady
      && !isSystemCodexWorkspace(normalized, current.defaultWorkspaceRoot, current.butlerWorkspaceRoot)
    ) {
      useAgentEnvironments.getState().ensureEnvironment({ path: normalized });
    }
    if (normalized === current.workspaceRoot) {
      if (!systemRootsReady && normalized && !current.workspaceRoots.includes(normalized)) {
        set({ workspaceRoots: [...current.workspaceRoots, normalized] });
        persist(get());
      }
      return;
    }
    const reusedRuntime = controller?.switchWorkspaceRoot(normalized) === true;
    if (!reusedRuntime && !Object.keys(current.threadStates).length) {
      await controller?.stop();
      controller = undefined;
    }
    set({
      workspaceRoot: normalized,
      workspaceRoots: !systemRootsReady && normalized && !current.workspaceRoots.includes(normalized)
        ? [...current.workspaceRoots, normalized]
        : current.workspaceRoots,
      status: reusedRuntime ? 'ready' : 'idle',
      error: null,
      activeThreadId: undefined,
      activeTurnId: undefined,
      turns: [],
      messages: [],
      events: [],
      pendingRequests: [],
      queuedMessages: [],
      ...(!reusedRuntime ? {
        models: [],
        permissionProfiles: [],
        skills: [],
        apps: [],
        plugins: null,
        catalogErrors: {},
      } : {}),
    });
    persist(get());
  },

  removeWorkspaceRoot: async (workspaceRoot) => {
    const normalized = workspaceRoot.trim();
    const current = get();
    if (isSystemCodexWorkspace(normalized, current.defaultWorkspaceRoot, current.butlerWorkspaceRoot)) return;
    if (!normalized || (!current.workspaceRoots.includes(normalized) && normalized !== current.workspaceRoot)) return;

    const remaining = current.workspaceRoots.filter((root) => root !== normalized);
    if (normalized === current.workspaceRoot) {
      await get().setWorkspaceRoot(
        remaining.includes(current.butlerWorkspaceRoot) ? current.butlerWorkspaceRoot : remaining[0] ?? '',
      );
    }
    set({ workspaceRoots: remaining });
    persist(get());
  },

  connect: async (options) => {
    if (!get().workspaceRoot) throw new Error('请先选择工作区');
    if (handoffInProgress) throw new Error('会话正在交接给 Codex App，请稍后重试');
    if (connectRequest) return connectRequest;
    set((state) => state.activeThreadId
      ? { error: null }
      : { status: 'connecting', error: null });
    connectRequest = (async () => {
      const activeController = controller ??= makeController();
      try {
        const catalog = await activeController.connect(id('workspace'), get().workspaceRoot);
        const defaults = defaultSelection(catalog, get());
        set((state) => ({
          ...catalog,
          ...defaults,
          ...(state.activeThreadId ? {} : { status: 'ready' as const, error: null }),
        }));
        persist(get());
        if (options?.refreshThreads !== false) await get().refreshThreads();
      } catch (error) {
        await activeController.stop().catch(() => undefined);
        if (controller === activeController) controller = undefined;
        set((state) => ({
          ...(state.activeThreadId ? {} : { status: 'unavailable' as const }),
          error: message(error),
        }));
        throw error;
      } finally {
        connectRequest = undefined;
      }
    })();
    return connectRequest;
  },

  refreshCatalog: async () => {
    if (!controller) await get().connect();
    const catalog = await controller!.refreshCatalog(get().activeThreadId);
    set(catalog);
  },

  refreshThreads: async () => {
    if (!controller) return;
    set({ threads: await controller.listThreads(threadWorkspaceRoots(get())) });
  },

  startThread: async (name) => {
    return withControllerOperation(async () => {
      const workspaceRoot = get().workspaceRoot;
      await ensureControllerWorkspace(workspaceRoot);
      const runtimeSelection = selection();
      const thread = await controller!.startThread(runtimeSelection, name);
      set((state) => ({
        threadStates: {
          ...state.threadStates,
          [thread.id]: {
            ...emptyThreadState('ready'),
            workspaceRoot,
            runtimeSelection,
          },
        },
        composerDraft: '',
      }));
      setActiveThread(thread.id, 'ready');
      await get().refreshThreads();
      return thread.id;
    });
  },

  startTask: async (text, name) => {
    return withControllerOperation(async () => {
      const prompt = text.trim();
      if (!prompt) throw new Error('任务内容不能为空');
      const workspaceRoot = get().workspaceRoot;
      await ensureControllerWorkspace(workspaceRoot);
      const runtimeSelection = selection();
      const thread = await controller!.startThread(runtimeSelection, name);
      set((state) => ({
        threadStates: {
          ...state.threadStates,
          [thread.id]: {
            ...emptyThreadState('ready'),
            workspaceRoot,
            runtimeSelection,
          },
        },
        composerDraft: '',
      }));
      setActiveThread(thread.id, 'ready');
      await get().refreshThreads();
      await sendThreadMessage(thread.id, prompt);
      return thread.id;
    });
  },

  resumeThread: async (threadId) => {
    const requestId = ++resumeThreadRequestId;
    if (!controller) await get().connect();
    let activeController = controller!;
    const existing = get().threadStates[threadId];
    if (existing) {
      setActiveThread(threadId, existing.status);
      await ensureControllerWorkspace(existing.workspaceRoot || get().workspaceRoot);
      try {
        const loaded = await activeController.readThread(threadId);
        setThreadState(threadId, (thread) => ({
          ...thread,
          turns: loaded.turns,
          messages: messagesFromTurns(loaded.turns),
        }));
      } catch {
        // 已有本地状态时，切回优先保持运行态；只在显式刷新时再尝试恢复。
      }
      return;
    }
    const runtimeSelection = selection();
    const workspaceRoot = get().workspaceRoot;
    await ensureControllerWorkspace(workspaceRoot);
    set((state) => ({
      threadStates: {
        ...state.threadStates,
        [threadId]: {
          ...currentThreadState(state, threadId),
          workspaceRoot,
          runtimeSelection,
          status: 'connecting',
          error: null,
          activeTurnId: undefined,
        },
      },
    }));
    setActiveThread(threadId, 'connecting');
    try {
      const loadThread = async () => {
        await ensureControllerWorkspace(workspaceRoot);
        const thread = await activeController.resumeThread(threadId, runtimeSelection);
        const loaded = await activeController.readThread(thread.id);
        return { thread, loaded };
      };
      let result;
      try {
        result = await loadThread();
      } catch (error) {
        if (!isRuntimeDisconnectedError(error)) throw error;
        await activeController.stop().catch(() => undefined);
        if (controller === activeController) controller = undefined;
        connectRequest = undefined;
        await get().connect({ refreshThreads: false });
        if (!controller) throw new Error('Codex Runtime 重新连接失败');
        activeController = controller;
        result = await loadThread();
      }
      const { thread, loaded } = result;
      const loadedState = currentThreadState(get(), thread.id);
      set((state) => ({
        threadStates: {
          ...state.threadStates,
          [thread.id]: {
            ...loadedState,
            workspaceRoot,
            runtimeSelection,
            turns: loaded.turns,
            messages: messagesFromTurns(loaded.turns),
            status: loadedState.status === 'running' || loadedState.status === 'waiting-input'
              ? loadedState.status
              : 'ready',
            error: loadedState.status === 'running' || loadedState.status === 'waiting-input'
              ? loadedState.error
              : null,
            activeTurnId: loadedState.status === 'running' || loadedState.status === 'waiting-input'
              ? loadedState.activeTurnId
              : undefined,
            events: loadedState.status === 'running' || loadedState.status === 'waiting-input' ? loadedState.events : [],
            streamingText: loadedState.status === 'running' || loadedState.status === 'waiting-input'
              ? loadedState.streamingText
              : '',
            pendingRequests: loadedState.status === 'waiting-input' ? loadedState.pendingRequests : [],
          },
        },
      }));
      if (requestId === resumeThreadRequestId && get().activeThreadId === threadId) setActiveThread(thread.id, 'ready');
    } catch (error) {
      if (!isActiveWriterError(error)) {
        setThreadState(threadId, (thread) => ({
          ...thread,
          status: controller ? 'ready' : 'unavailable',
          error: message(error),
        }));
        throw error;
      }
      const loaded = await activeController.readThread(threadId);
      await unsubscribeThreadIfSupported(activeController, threadId).catch(() => undefined);
      set((state) => ({
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...currentThreadState(state, threadId),
            workspaceRoot,
            runtimeSelection,
            activeTurnId: undefined,
            turns: loaded.turns,
            messages: messagesFromTurns(loaded.turns),
            events: [],
            streamingText: '',
            pendingRequests: [],
            queuedMessages: [],
            status: 'external',
            error: null,
          },
        },
      }));
      if (requestId === resumeThreadRequestId && get().activeThreadId === threadId) setActiveThread(threadId, 'external');
    }
  },

  refreshFromCodex: async () => {
    if (handoffInProgress) throw new Error('会话正在交接给 Codex App，请稍后重试');
    const current = get();
    if (!current.workspaceRoot) throw new Error('请先选择工作区');
    if (!current.activeThreadId) throw new Error('请先打开一个 Codex 任务');
    const activeThread = currentThreadState(current, current.activeThreadId, current.status);
    if (activeThread.activeTurnId || activeThread.status === 'running' || activeThread.status === 'waiting-input') {
      throw new Error('任务运行中，完成后再从 Codex 刷新');
    }
    if (current.status === 'connecting') throw new Error('Codex 正在连接，请稍后刷新');

    const threadId = current.activeThreadId;
    const knownTurnIds = new Set(activeThread.turns.map((turn) => turn.id));
    rejectPendingRequests('正在从 Codex 刷新', threadId);
    setThreadState(threadId, (thread) => ({
      ...thread,
      status: 'connecting',
      error: null,
      activeTurnId: undefined,
      streamingText: '',
      events: [],
      pendingRequests: [],
    }));
    setActiveThread(threadId, 'connecting');
    await unsubscribeThreadIfSupported(controller, threadId).catch(() => undefined);

    let externalLoaded: Awaited<ReturnType<AppServerController['readThread']>> | undefined;
    try {
      await ensureControllerWorkspace(activeThread.workspaceRoot || current.workspaceRoot);
      await get().connect();
      const activeController = controller!;
      try {
        const runtimeSelection = threadSelection(activeThread, current);
        const resumed = await activeController.resumeThread(threadId, runtimeSelection);
        const loaded = await activeController.readThread(resumed.id);
        setThreadState(resumed.id, (thread) => ({
          ...thread,
          workspaceRoot: activeThread.workspaceRoot || current.workspaceRoot,
          runtimeSelection,
          turns: loaded.turns,
          messages: messagesFromTurns(loaded.turns),
          events: [],
          streamingText: '',
          pendingRequests: [],
          queuedMessages: [],
          activeTurnId: undefined,
          status: 'ready',
          error: null,
        }));
        setActiveThread(resumed.id, 'ready');
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        externalLoaded = await activeController.readThread(threadId);
        const name = continuationName(externalLoaded.thread);
        const forked = await activeController.forkThread(
          threadId,
          threadSelection(activeThread, current),
          name,
        );
        const loaded = await activeController.readThread(forked.id);
        set((state) => ({
          threads: [
            { ...loaded.thread, name },
            ...state.threads.filter((thread) => thread.id !== forked.id),
          ],
          threadStates: {
            ...state.threadStates,
            [forked.id]: {
              ...emptyThreadState('ready'),
              workspaceRoot: activeThread.workspaceRoot || current.workspaceRoot,
              runtimeSelection: threadSelection(activeThread, current),
              turns: loaded.turns,
              messages: messagesFromTurns(loaded.turns),
            },
          },
        }));
        setActiveThread(forked.id, 'ready');
      }
      return currentThreadState(get(), get().activeThreadId).turns.filter((turn) => !knownTurnIds.has(turn.id)).length;
    } catch (error) {
      if (externalLoaded) {
        const loaded = externalLoaded;
        setThreadState(threadId, (thread) => ({
          ...thread,
          status: 'external',
          activeTurnId: undefined,
          turns: loaded.turns,
          messages: messagesFromTurns(loaded.turns),
          error: message(error),
        }));
        setActiveThread(threadId, 'external');
      } else {
        setThreadState(threadId, (thread) => ({
          ...thread,
          status: 'unavailable',
          activeTurnId: undefined,
          error: message(error),
        }));
        setActiveThread(threadId, 'unavailable');
      }
      throw error;
    }
  },

  handoffToCodex: async () => {
    const current = get();
    if (!current.activeThreadId) throw new Error('请先打开一个 Codex 任务');
    if (handoffInProgress) throw new Error('会话正在交接给 Codex App，请稍后重试');
    const activeThread = currentThreadState(current, current.activeThreadId, current.status);
    if (connectRequest || activeThread.status === 'connecting') {
      throw new Error('Codex 正在连接，请稍后再切换到 Codex App');
    }
    if (activeThread.activeTurnId || activeThread.status === 'running' || activeThread.status === 'waiting-input') {
      throw new Error('任务运行中，完成或停止后再切换到 Codex App');
    }
    if (backgroundAutomationPermissions.size > 0) {
      throw new Error('已安排任务正在运行，完成后再切换到 Codex App');
    }
    if (controllerOperations.size > 0) {
      throw new Error('RocketX 正在处理其他 Codex 操作，完成后再切换到 Codex App');
    }
    const otherTaskRunning = Object.entries(current.threadStates).some(([threadId, thread]) =>
      threadId !== current.activeThreadId
      && (
        Boolean(thread.activeTurnId)
        || thread.queuedMessages.length > 0
        || thread.status === 'running'
        || thread.status === 'waiting-input'
        || thread.status === 'connecting'
      )
    );
    if (otherTaskRunning) {
      throw new Error('还有其他 RocketX 任务正在运行，完成或停止后再切换到 Codex App');
    }
    handoffInProgress = true;
    try {
      rejectPendingRequests('会话已交给 Codex App', current.activeThreadId);
      const activeController = controller;
      await unsubscribeThreadIfSupported(activeController, current.activeThreadId).catch(() => undefined);
      if (activeController) {
        if (controller === activeController) {
          controller = undefined;
          connectRequest = undefined;
        }
        await activeController.stop();
      }
      setThreadState(current.activeThreadId, (thread) => ({
        ...thread,
        status: 'external',
        activeTurnId: undefined,
        streamingText: '',
        events: [],
        pendingRequests: [],
        queuedMessages: [],
        error: null,
      }));
      setActiveThread(current.activeThreadId, 'external');
      return await openCodexThread(current.activeThreadId);
    } finally {
      handoffInProgress = false;
    }
  },

  renameThread: async (threadId, name) => {
    await withControllerOperation(async () => {
      if (!controller) await get().connect();
      await controller!.renameThread(threadId, name);
      set((state) => ({
        threads: state.threads.map((thread) => thread.id === threadId
          ? { ...thread, name: name.trim() }
          : thread),
      }));
    });
  },

  archiveThread: async (threadId) => {
    await withControllerOperation(async () => {
      if (!controller) await get().connect();
      const state = get();
      const thread = currentThreadState(state, threadId);
      if (state.activeThreadId === threadId && thread.activeTurnId) {
        await controller!.interruptTurn(threadId, thread.activeTurnId).catch(() => undefined);
      }
      await controller!.archiveThread(threadId);
      rejectPendingRequests('任务已归档', threadId);
      set((current) => ({
        threads: current.threads.filter((thread) => thread.id !== threadId),
        threadStates: Object.fromEntries(
          Object.entries(current.threadStates).filter(([id]) => id !== threadId),
        ) as Record<string, CodexThreadState>,
        ...(current.activeThreadId === threadId ? {
          activeThreadId: undefined,
          activeTurnId: undefined,
          turns: [],
          messages: [],
          events: [],
          streamingText: '',
          queuedMessages: [],
          status: 'ready' as const,
        } : {}),
      }));
    });
  },

  send: async (value, images = [], modeOverride) => {
    const text = value.trim();
    const imageList = [...images];
    if (!text && imageList.length === 0) return;
    if (!controller) await get().connect();
    if (!get().activeThreadId) await get().startThread(text.slice(0, 48) || '图片任务');
    await sendThreadMessage(get().activeThreadId!, text, imageList, modeOverride);
  },

  setComposerDraft: (composerDraft) => set({ composerDraft }),

  clearComposerDraft: () => set({ composerDraft: '' }),

  interrupt: async () => {
    const state = get();
    if (!state.activeThreadId) return;
    const thread = currentThreadState(state, state.activeThreadId, state.status);
    if (controller && thread.activeTurnId) {
      await controller.interruptTurn(state.activeThreadId, thread.activeTurnId).catch(() => undefined);
    }
    rejectPendingRequests('用户已停止当前任务', state.activeThreadId);
    setThreadState(state.activeThreadId, (current) => ({
      ...current,
      status: 'ready',
      activeTurnId: undefined,
      streamingText: '',
      queuedMessages: [],
    }));
  },

  resolveRequest: (requestId, resolution) => {
    const state = get();
    const pending = state.pendingRequests.find((item) => item.id === requestId)
      ?? Object.values(state.threadStates)
        .flatMap((thread) => thread.pendingRequests)
        .find((item) => item.id === requestId);
    const waiter = requestWaiters.get(requestId);
    if (!pending || !waiter) return;
    const thread = currentThreadState(state, pending.threadId, state.status);
    const roots = thread.workspaceRoot ? [thread.workspaceRoot] : [state.workspaceRoot].filter(Boolean);
    const accepted = resolution.action === 'accept' || resolution.action === 'accept-session';
    let result: unknown;
    if (pending.kind === 'user-input') {
      result = {
        answers: Object.fromEntries(Object.entries(resolution.values ?? {}).map(([key, value]) => [
          key,
          { answers: Array.isArray(value) ? value : [value] },
        ])),
      };
    } else if (pending.kind === 'mcp-input') {
      result = {
        action: accepted ? 'accept' : resolution.action === 'cancel' ? 'cancel' : 'decline',
        content: accepted ? resolution.values ?? {} : null,
        _meta: null,
      };
    } else if (pending.method === 'item/permissions/requestApproval') {
      let permissions = {};
      if (accepted) {
        const requested = pending.params.permissions ?? pending.params.additionalPermissions;
        permissions = validatePermissionRequest(
          requested as Parameters<typeof validatePermissionRequest>[0],
          roots,
        );
      }
      result = {
        permissions: accepted ? permissions : {},
        scope: resolution.action === 'accept-session' ? 'session' : 'turn',
        strictAutoReview: true,
      };
    } else if (pending.method.startsWith('item/')) {
      if (accepted) {
        validateApprovalPaths(pending.params, roots);
        if (commandRequestMentionsSensitivePath(pending.params.command)) {
          throw new Error('命令涉及敏感路径，不能批准');
        }
      }
      result = {
        decision: accepted
          ? resolution.action === 'accept-session' ? 'acceptForSession' : 'accept'
          : resolution.action === 'cancel' ? 'cancel' : 'decline',
      };
    } else {
      result = { decision: accepted ? 'approved' : 'denied' };
    }
    requestWaiters.delete(requestId);
    setThreadState(pending.threadId, (current) => {
      const pendingRequests = current.pendingRequests.filter((item) => item.id !== requestId);
      return {
        ...current,
        pendingRequests,
        status: pendingRequests.length > 0 ? 'waiting-input' : current.activeTurnId ? 'running' : 'ready',
      };
    });
    waiter.resolve(result);
  },

  setModel: async (selectedModel) => {
    const model = get().models.find((item) => item.model === selectedModel || item.id === selectedModel);
    if (!model) throw new Error(`未知模型：${selectedModel}`);
    const selectedEffort = model.supportedReasoningEfforts.some(
      (item) => item.reasoningEffort === get().selectedEffort,
    ) ? get().selectedEffort : model.defaultReasoningEffort;
    set({ selectedModel: model.model, selectedEffort });
    persist(get());
    if (controller && get().activeThreadId) {
      setThreadState(get().activeThreadId!, (thread) => ({
        ...thread,
        runtimeSelection: {
          model: model.model,
          effort: selectedEffort,
          permissionPreset: get().permissionPreset,
        },
      }));
      await ensureControllerWorkspace(currentThreadState(get(), get().activeThreadId!).workspaceRoot || get().workspaceRoot);
      await controller.updateSettings(get().activeThreadId!, selection());
    }
  },

  setEffort: async (selectedEffort) => {
    set({ selectedEffort });
    persist(get());
    if (controller && get().activeThreadId) {
      setThreadState(get().activeThreadId!, (thread) => ({
        ...thread,
        runtimeSelection: {
          model: get().selectedModel,
          effort: selectedEffort,
          permissionPreset: get().permissionPreset,
        },
      }));
      await ensureControllerWorkspace(currentThreadState(get(), get().activeThreadId!).workspaceRoot || get().workspaceRoot);
      await controller.updateSettings(get().activeThreadId!, selection());
    }
  },

  setPermissionPreset: async (permissionPreset) => {
    const profile = permissionSettings(permissionPreset).permissions;
    if (!get().permissionProfiles.some((item) => item.id === profile && item.allowed)) {
      throw new Error(`当前 Codex Runtime 不允许权限档 ${profile}`);
    }
    set({ permissionPreset });
    persist(get());
    if (controller && get().activeThreadId) {
      setThreadState(get().activeThreadId!, (thread) => ({
        ...thread,
        runtimeSelection: {
          model: get().selectedModel,
          effort: get().selectedEffort,
          permissionPreset,
        },
      }));
      await ensureControllerWorkspace(currentThreadState(get(), get().activeThreadId!).workspaceRoot || get().workspaceRoot);
      await controller.updateSettings(get().activeThreadId!, selection());
    }
  },

  setFollowUpMode: (followUpMode) => {
    set({ followUpMode });
    persist(get());
  },

  installPlugin: async (marketplace, pluginName) => {
    if (!controller) await get().connect();
    await controller!.installPlugin(marketplace, pluginName);
    await get().refreshCatalog();
  },

  uninstallPlugin: async (pluginId) => {
    if (!controller) await get().connect();
    await controller!.uninstallPlugin(pluginId);
    await get().refreshCatalog();
  },

  readPlugin: async (marketplace, pluginName) => {
    if (!controller) await get().connect();
    return (await controller!.readPlugin(marketplace, pluginName)).plugin;
  },

  readFile: async (path) => {
    const workspaceRoot = get().workspaceRoot;
    if (!workspaceRoot) throw new Error('请先选择工作区');
    return invoke<string>('codex_artifact_read', { workspaceRoot, path });
  },

  openArtifact: async (path) => {
    const workspaceRoot = get().workspaceRoot;
    if (!workspaceRoot) throw new Error('请先选择工作区');
    return invoke<void>('codex_artifact_open', { workspaceRoot, path });
  },

  revealArtifact: async (path) => {
    const workspaceRoot = get().workspaceRoot;
    if (!workspaceRoot) throw new Error('请先选择工作区');
    return invoke<void>('codex_artifact_reveal', { workspaceRoot, path });
  },

  setSkillEnabled: async (path, enabled) => {
    if (!controller) await get().connect();
    const effective = await controller!.setSkillEnabled(path, enabled);
    set((state) => ({
      skills: state.skills.map((skill) => skill.path === path ? { ...skill, enabled: effective } : skill),
    }));
  },

  shutdown: async () => {
    rejectPendingRequests('Codex 工作区已关闭');
    await controller?.stop();
    controller = undefined;
    set({ status: 'idle', activeThreadId: undefined, activeTurnId: undefined });
  },
}));

export interface ExistingThreadAutomationOptions {
  threadId: string;
  workspaceRoot: string;
  text: string;
  model?: string;
  effort?: string | null;
  permissionPreset?: CodexPermissionPreset;
  signal?: AbortSignal;
}

/** 复用 RocketX 当前 app-server writer，让 heartbeat 真正回到既有会话。 */
export async function runExistingThreadAutomation(
  options: ExistingThreadAutomationOptions,
): Promise<{ text: string; threadId: string }> {
  if (handoffInProgress) throw new Error('会话正在交接给 Codex App，请稍后重试');
  const state = useCodexWorkspace.getState();
  if (state.activeThreadId === options.threadId && state.activeTurnId) {
    throw new Error('目标会话正在运行，请等待当前任务完成');
  }
  if (!controller) await state.connect();
  if (!controller || controller.currentWorkspaceRoot !== options.workspaceRoot) {
    throw new Error('目标会话不属于当前 Codex 工作区');
  }
  const catalog = controller.currentCatalog;
  const model = catalog?.models.find((item) => item.model === options.model || item.id === options.model)
    ?? catalog?.models.find((item) => item.isDefault)
    ?? catalog?.models[0];
  if (!model) throw new Error('当前 Codex Runtime 没有可用模型');
  const effort = options.effort
    && model.supportedReasoningEfforts.some((item) => item.reasoningEffort === options.effort)
    ? options.effort
    : model.defaultReasoningEffort;
  const runtimeSelection: CodexRuntimeSelection = {
    model: model.model,
    effort,
    permissionPreset: options.permissionPreset ?? state.permissionPreset,
  };
  const activeController = controller;
  const automationToken = Symbol(options.threadId);
  let turnId = '';
  const interrupt = (): void => {
    if (turnId) void activeController.interruptTurn(options.threadId, turnId).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', interrupt, { once: true });
  const threadPermissions = backgroundAutomationPermissions.get(options.threadId) ?? new Map();
  threadPermissions.set(automationToken, runtimeSelection.permissionPreset);
  backgroundAutomationPermissions.set(options.threadId, threadPermissions);
  try {
    await activeController.resumeThread(options.threadId, runtimeSelection);
    turnId = await activeController.startTurn(
      options.threadId,
      [{ type: 'text', text: options.text, text_elements: [] }],
      runtimeSelection,
    );
    const deadline = Date.now() + 60 * 60_000;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error ? options.signal.reason : new Error('任务已取消');
      }
      const loaded = await activeController.readThread(options.threadId);
      const turn = loaded.turns.find((item) => item.id === turnId);
      if (turn?.status === 'failed') throw new Error(turn.error?.message ?? 'Codex 未完成该已安排任务');
      if (turn?.status === 'interrupted') throw new Error('Codex 已中断该已安排任务');
      if (turn?.status === 'completed') {
        const output = [...messagesFromTurns([turn])]
          .reverse()
          .find((item) => item.role === 'assistant')
          ?.text.trim();
        if (!output) throw new Error('Codex 已完成，但没有返回可展示的结果');
        return { text: output, threadId: options.threadId };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('已安排任务运行超时');
  } finally {
    const activePermissions = backgroundAutomationPermissions.get(options.threadId);
    activePermissions?.delete(automationToken);
    if (activePermissions?.size === 0) backgroundAutomationPermissions.delete(options.threadId);
    options.signal?.removeEventListener('abort', interrupt);
  }
}

export function setCodexWorkspaceControllerFactory(factory: ControllerFactory): () => void {
  const previous = controllerFactory;
  controllerFactory = factory;
  return () => {
    controllerFactory = previous;
  };
}

export async function resetCodexWorkspaceForTests(): Promise<void> {
  rejectPendingRequests('测试重置');
  await controller?.stop();
  controller = undefined;
  handoffInProgress = false;
  controllerOperations.clear();
  defaultWorkspaceRequest = undefined;
  butlerWorkspaceRequest = undefined;
  useCodexWorkspace.setState({
    scope: '',
    defaultWorkspaceRoot: '',
    butlerWorkspaceRoot: '',
    workspaceRoot: '',
    workspaceRoots: [],
    status: 'idle',
    error: null,
    threads: [],
    threadStates: {},
    activeThreadId: undefined,
    activeTurnId: undefined,
    turns: [],
    messages: [],
    events: [],
    streamingText: '',
    composerDraft: '',
    pendingRequests: [],
    queuedMessages: [],
    models: [],
    permissionProfiles: [],
    skills: [],
    apps: [],
    plugins: null,
    catalogErrors: {},
    selectedModel: '',
    selectedEffort: null,
    permissionPreset: 'auto',
    followUpMode: 'steer',
  });
}
