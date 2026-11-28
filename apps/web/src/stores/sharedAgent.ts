import { create } from 'zustand';
import { t } from '../i18n';
import '../agent/codexHostTools';
import { registerUserRuntimeShutdownHook } from '../lib/runtimeLifecycle';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { getServerBase, isTauriRuntime, rest } from '../lib/client';
import { toSendableMessageChunks } from '../lib/messageChunks';
import { getAiRuntimeProvider } from '../lib/runtimeMode';
import { useAuth } from './auth';
import { useChat } from './chat';
import {
  AppServerController,
  type AppServerControllerOptions,
  type CodexCatalog,
  type CodexRuntimeSelection,
} from '../agent/AppServerController';
import type { ServerRequestPolicy } from '../agent/protocol';
import { agentDeviceId } from '../agent/device';
import {
  agentSessionCardAuthority,
  agentSessionLeaseCustomFields,
  agentSessionCardMatchesMessage,
  agentSessionCardSupersedesLocal,
  createAgentSessionLeaseMessageId,
  parseAgentSessionCard,
  renderAgentSessionCard,
  stripAgentSessionMarker,
  type AgentSessionCard,
} from '../agent/card';
import {
  agentMessageInstruction,
  agentTurnInput,
  buildAgentContext,
  collectLinkedWorkItems,
  quoteMessageIds,
  selectAgentContextMessages,
} from '../agent/context';
import {
  materializeAgentAttachments,
  type AgentAttachmentDestination,
} from '../agent/attachments';
import {
  agentConversationLines,
  openCodexNewThread,
  transferTranscript,
  type CodexHandoffResult,
} from '../agent/codexTransfer';
import { rocketxThreadName } from '../agent/threadName';
import { adoWebBase } from '../lib/ado';
import {
  SerialCommandQueue,
  agentBackend,
  approveMember,
  assertHost,
  commandAccess,
  interruptSession,
  resumeSession as enterResumeState,
  restoreSession,
  takeHostLease,
  type AgentCommand,
  type AgentBackend,
  type AgentSession,
} from '../agent/session';
import { listAgentSessions, saveAgentSession } from '../agent/sessionStore';
import { useWorkbench } from './workbench';
import {
  isSystemCodexWorkspace,
  messagesFromTurns,
  useCodexWorkspace,
  type CodexWorkspaceMessage,
} from './codexWorkspace';
import { resolveAgentSessionKey, useAgentEnvironments } from './agentEnvironments';
import {
  assertAllowedWorkspacePath,
  commandRequestMentionsSensitivePath,
  redactAgentOutput,
  validateApprovalPaths,
  validatePermissionRequest,
} from '../agent/safety';
import { agentMessageBridgeChanges } from '../agent/messageBridge';
import type { CodexHostInput } from '../agent/codexHostInput';
import {
  isButlerErrandInputMethod,
  validateButlerErrandInputResponse,
  type ButlerErrandInputResponse,
} from '../lib/butlerHostInput';
import { sendAgentBotMessage } from '../platform/desktopCommands';

const LEASE_MS = 90_000;
const ORPHAN_SESSION_MS = 30 * 60_000;
const TRACE_LIMIT = 200;
const LEASE_CLOCK_SKEW_MS = 15_000;

export interface AgentTrace {
  id: string;
  at: number;
  kind: 'status' | 'tool' | 'warning' | 'error';
  text: string;
}

export interface AgentApproval {
  id: string;
  tmid: string;
  method: string;
  policy: ServerRequestPolicy;
  params: unknown;
}

export interface AgentInput extends CodexHostInput {
  tmid: string;
}

export interface AgentMemberRequest {
  id: string;
  tmid: string;
  command: AgentCommand;
}

export interface AgentSessionStartOptions {
  backend?: AgentBackend;
  workspaceRoot?: string;
  replyTmid?: string;
  runtimeModel?: AgentSession['runtimeModel'];
  runtimeEffort?: AgentSession['runtimeEffort'];
  runtimePermissionPreset?: AgentSession['runtimePermissionPreset'];
  environmentId?: string;
  environmentName?: string;
  workItem?: AgentSession['workItem'];
  proposedBranch?: string;
  baseBranch?: string;
}

interface SharedAgentState {
  sessions: Record<string, AgentSession>;
  remoteCards: Record<string, AgentSessionCard>;
  traces: Record<string, AgentTrace[]>;
  approvals: AgentApproval[];
  inputs: AgentInput[];
  memberRequests: AgentMemberRequest[];
  error: string | null;
  restore: () => Promise<void>;
  ingestCard: (message: RcMessage) => Promise<void>;
  readTranscript: (tmid: string) => Promise<CodexWorkspaceMessage[]>;
  startSession: (rid: string, sessionKey: string, options?: AgentSessionStartOptions) => Promise<AgentSession>;
  handleMessage: (message: RcMessage) => Promise<void>;
  approveMemberRequest: (id: string, allowed: boolean) => Promise<void>;
  resolveApproval: (id: string, resolution: AgentApprovalResolution) => Promise<void>;
  resolveInput: (id: string, response: ButlerErrandInputResponse) => Promise<void>;
  setAccess: (tmid: string, access: AgentSession['access']) => Promise<void>;
  resumeSession: (tmid: string) => Promise<void>;
  endSession: (tmid: string) => Promise<void>;
  /** 把托管对话作为新对话草稿交给 Codex App */
  transferToCodexApp: (tmid: string) => Promise<CodexHandoffResult>;
}

const queues = new Map<string, SerialCommandQueue>();
const turnBuffers = new Map<string, string>();
const fileChangePaths = new Map<string, { tmid: string; paths: string[] }>();
const turnWaiters = new Map<
  string,
  { tmid: string; resolve: () => void; reject: (error: Error) => void }
>();
const approvalWaiters = new Map<
  string,
  { tmid: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const inputWaiters = new Map<
  string,
  { tmid: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const processedMessages = new Set<string>();
const startingSessions = new Map<string, Promise<AgentSession>>();
const ingestSequences = new Map<string, Promise<void>>();
const controllers = new Map<string, SharedAgentController>();
const controllerStarts = new Map<string, Promise<{ controller: SharedAgentController; catalog: CodexCatalog }>>();
const controllerIdentities = new Map<string, string>();
const controllerStartIdentities = new Map<string, string>();
let sharedAgentBridgeCleanup: (() => void) | null = null;
let restoredScope = '';
let restoreGeneration = 0;

function scopedRuntimeKey(tmid: string, id: string): string {
  return `${tmid}\u0000${id}`;
}

function controllerIdentity(session: AgentSession): string {
  return `${session.sessionId}\u0000${session.workspaceRoots[0]}`;
}

function hostedUserTurn(text: string): { text: string; speaker?: string } {
  const request = text.match(/<rocket_chat_user_request>\s*([\s\S]*?)\s*<\/rocket_chat_user_request>/u)?.[1]?.trim();
  const speaker = text.match(/^(?:触发者|Triggered by):\s*(.+?)\s+\([^)]+\)\s*$/mu)?.[1]?.trim();
  return { text: request || text, ...(speaker ? { speaker } : {}) };
}

function naturalTranscript(messages: readonly CodexWorkspaceMessage[]): CodexWorkspaceMessage[] {
  return messages.map((message) => (
    message.role === 'user' ? { ...message, ...hostedUserTurn(message.text) } : message
  ));
}

function remoteSessionControls(tmid: string, now = Date.now()): AgentSessionCard | undefined {
  const state = useSharedAgent.getState();
  const remote = state.remoteCards[tmid];
  return agentSessionCardSupersedesLocal(state.sessions[tmid], remote, now) ? remote : undefined;
}

function scopedTurnKey(tmid: string, turnId: string): string {
  return scopedRuntimeKey(tmid, turnId);
}

function scopedApprovalKey(tmid: string, approvalId: string): string {
  return scopedRuntimeKey(tmid, approvalId);
}

function scopedInputKey(tmid: string, inputId: string): string {
  return scopedRuntimeKey(tmid, inputId);
}

function scopedFileChangeKey(tmid: string, itemId: string): string {
  return scopedRuntimeKey(tmid, itemId);
}

type SharedAgentController = {
  currentCatalog?: CodexCatalog;
  processInfo?: {
    version: string;
    runtimeSource: AgentSession['createdWithRuntimeSource'];
  };
  connect: (sessionId: string, workspaceRoot: string) => Promise<CodexCatalog>;
  startThread: (
    selection: CodexRuntimeSelection,
    name?: string,
  ) => Promise<{ id: string }>;
  resumeThread: (threadId: string, selection: CodexRuntimeSelection) => Promise<{ id: string }>;
  readThread: AppServerController['readThread'];
  startTurn: (
    threadId: string,
    input: Parameters<AppServerController['startTurn']>[1],
    selection: CodexRuntimeSelection,
    options?: Parameters<AppServerController['startTurn']>[3],
  ) => Promise<string>;
  interruptTurn: (threadId: string, turnId: string) => Promise<void>;
  renameThread: (threadId: string, name: string) => Promise<void>;
  stop: () => Promise<void>;
};

type SharedAgentControllerFactory = (options: AppServerControllerOptions) => SharedAgentController;

let sharedAgentControllerFactory: SharedAgentControllerFactory = (options) => new AppServerController(options);
let sharedAgentMessageSizeProvider = async (): Promise<unknown> => {
  const clientModule = await import('../lib/client');
  return clientModule.getPublicSetting('Message_MaxAllowedSize');
};

function emptySharedAgentScope() {
  return {
    sessions: {},
    remoteCards: {},
    traces: {},
    approvals: [],
    inputs: [],
    memberRequests: [],
    error: null,
  };
}

function id(prefix: string): string {
  const value = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `${prefix}-${value}`;
}

function actor() {
  const user = useAuth.getState().user;
  if (!user) throw new Error(t('agent.shared.loginRequired'));
  return { userId: user._id, deviceId: agentDeviceId() };
}

export type AgentApprovalResolution = 'accept' | 'accept-session' | 'decline';

export function sharedAgentApprovalResult(
  method: string,
  resolution: AgentApprovalResolution,
  permissions: Record<string, unknown> = {},
): unknown {
  const accepted = resolution !== 'decline';
  if (method === 'item/permissions/requestApproval') {
    return {
      permissions: accepted ? permissions : {},
      scope: resolution === 'accept-session' ? 'session' : 'turn',
      strictAutoReview: true,
    };
  }
  if (method.startsWith('item/')) {
    return {
      decision: accepted
        ? resolution === 'accept-session' ? 'acceptForSession' : 'accept'
        : 'decline',
    };
  }
  return { decision: accepted ? 'approved' : 'denied' };
}

function sessionRuntimeSnapshot(
  session: AgentSession,
): Pick<AgentSession, 'runtimeModel' | 'runtimeEffort' | 'runtimePermissionPreset'> {
  if (
    session.runtimeModel !== undefined
    || session.runtimeEffort !== undefined
    || session.runtimePermissionPreset !== undefined
  ) {
    return {
      runtimeModel: session.runtimeModel,
      runtimeEffort: session.runtimeEffort,
      runtimePermissionPreset: session.runtimePermissionPreset,
    };
  }
  const workspace = useCodexWorkspace.getState();
  return {
    runtimeModel: workspace.selectedModel || undefined,
    runtimeEffort: workspace.selectedEffort,
    runtimePermissionPreset: workspace.permissionPreset,
  };
}

function withSessionRuntimeSnapshot(session: AgentSession): AgentSession {
  return {
    ...session,
    ...sessionRuntimeSnapshot(session),
  };
}

function runtimeSelection(
  catalog: CodexCatalog,
  session?: Pick<AgentSession, 'runtimeModel' | 'runtimeEffort' | 'runtimePermissionPreset'>,
): CodexRuntimeSelection {
  const workspace = useCodexWorkspace.getState();
  const requestedModel = session?.runtimeModel;
  const model = catalog.models.find(
    (item) => item.model === requestedModel || item.id === requestedModel,
  )
    ?? catalog.models.find((item) => item.isDefault)
    ?? catalog.models[0];
  if (!model) throw new Error(t('agent.codexAutomation.noModels'));
  const requestedEffort = session?.runtimeEffort;
  const effort = requestedEffort
    && model.supportedReasoningEfforts.some((item) => item.reasoningEffort === requestedEffort)
    ? requestedEffort
    : model.defaultReasoningEffort;
  return {
    model: model.model,
    effort,
    permissionPreset: session?.runtimePermissionPreset ?? workspace.permissionPreset,
  };
}

function resolveSessionRuntime(
  session: AgentSession,
  catalog: CodexCatalog,
): { session: AgentSession; selection: CodexRuntimeSelection } {
  const selection = runtimeSelection(catalog, session);
  return {
    session: {
      ...session,
      runtimeModel: selection.model,
      runtimeEffort: selection.effort,
      runtimePermissionPreset: selection.permissionPreset,
    },
    selection,
  };
}

function replyTmid(session: AgentSession): string | undefined {
  if (session.replyTmid) return session.replyTmid;
  return session.tmid.startsWith('room:') ? undefined : session.tmid;
}

function updateSession(session: AgentSession): void {
  useSharedAgent.setState((state) => ({ sessions: { ...state.sessions, [session.tmid]: session } }));
  void saveAgentSession(session, session.ownerUserId);
}

function cardFor(session: AgentSession): AgentSessionCard {
  const user = useAuth.getState().user;
  return {
    version: 1,
    sessionId: session.sessionId,
    rid: session.rid,
    tmid: session.tmid,
    roomNameSnapshot: session.roomNameSnapshot,
    hostUserId: session.host.userId,
    hostUsername: user?.username ?? session.host.userId,
    hostDeviceId: session.host.deviceId,
    leaseExpiresAt: session.host.expiresAt,
    backend: agentBackend(session),
    environmentName: session.environmentName,
    workItem: session.workItem,
    proposedBranch: session.proposedBranch,
    currentTaskLabel: session.currentTaskLabel,
    status:
      session.status === 'ended'
        ? 'ended'
        : session.status === 'interrupted'
          ? 'interrupted'
          : 'active',
  };
}

async function updateLeaseCard(session: AgentSession): Promise<void> {
  if (!session.leaseMessageId) return;
  await rest.updateMessage(session.rid, session.leaseMessageId, renderAgentSessionCard(cardFor(session)));
}

async function sendLeaseCard(session: AgentSession): Promise<RcMessage> {
  const card = cardFor(session);
  const leaseMessageId = createAgentSessionLeaseMessageId();
  const body = {
    _id: leaseMessageId,
    rid: session.rid,
    msg: renderAgentSessionCard(card),
    ...(replyTmid(session) ? { tmid: replyTmid(session) } : {}),
  };
  try {
    return await rest.sendMessageRaw({
      ...body,
      customFields: agentSessionLeaseCustomFields(card),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/custom fields/i.test(detail)) throw error;
    return await rest.sendMessageRaw(body);
  }
}

function updatePublishedSession(session: AgentSession): void {
  updateSession(session);
  void updateLeaseCard(session).catch(() => undefined);
}

async function sendAgentReply(session: AgentSession, text: string): Promise<void> {
  const maxAllowedSize = await sharedAgentMessageSizeProvider().catch(() => undefined);
  const chunks = toSendableMessageChunks(text, maxAllowedSize);
  let useHostFallback = false;
  let botDelivered = false;
  for (const chunk of chunks) {
    if (!useHostFallback) {
      try {
        const sent = await sendAgentBotMessage({
          serverUrl: getServerBase(),
          rid: session.rid,
          tmid: replyTmid(session) ?? null,
          text: chunk,
        });
        if (sent !== null) {
          botDelivered = true;
          continue;
        }
        if (botDelivered) throw new Error(t('agent.shared.botChunkFailed'));
        useHostFallback = true;
      } catch (error) {
        if (botDelivered) throw error;
        useHostFallback = true;
        trace(session.tmid, 'warning', t('agent.shared.botFallbackSent', { error: error instanceof Error ? error.message : String(error) }));
      }
    }
    const sent = await useChat.getState().send(chunk, {
      rid: session.rid,
      tmid: replyTmid(session),
      preserveWhitespace: true,
    });
    if (
      !sent ||
      typeof sent !== 'object' ||
      !('delivery' in sent) ||
      (sent.delivery !== 'server' && sent.delivery !== 'lan')
    ) {
      const detail = (
        sent &&
        typeof sent === 'object' &&
        'reason' in sent &&
        typeof sent.reason === 'string'
      ) ? sent.reason : t('agent.shared.sendFailed');
      throw new Error(detail);
    }
  }
}

function trace(tmid: string, kind: AgentTrace['kind'], text: string): void {
  useSharedAgent.setState((state) => ({
    traces: {
      ...state.traces,
      [tmid]: [...(state.traces[tmid] ?? []), { id: id('trace'), at: Date.now(), kind, text }].slice(
        -TRACE_LIMIT,
      ),
    },
  }));
}

/**
 * 托管线程是原生 Codex 线程（落盘于 CODEX_HOME 会话库，可在 codex resume /
 * Codex App 里继续），起名让它在列表里可辨认。失败不影响托管本身。
 */
function nameCodexThread(appServer: SharedAgentController, session: AgentSession): void {
  if (!session.codexThreadId) return;
  const chat = useChat.getState();
  const room = chat.subscriptions[session.rid] ?? chat.rooms[session.rid];
  const detail = session.workItem
    ? `#${session.workItem.id} ${session.workItem.title}`
    : room?.fname || room?.name || session.environmentName;
  void appServer
    .renameThread(session.codexThreadId, rocketxThreadName(t('agent.shared.threadScopeHosted'), detail))
    .catch(() => undefined);
}

function agentName(session: Pick<AgentSession, 'backend'>): 'Codex' | 'DeepSeek' {
  return agentBackend(session) === 'deepseek' ? 'DeepSeek' : 'Codex';
}

function roomNameSnapshot(rid: string): string | undefined {
  const room = useChat.getState().subscriptions[rid] ?? useChat.getState().rooms[rid];
  const value = room?.fname || room?.name;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function taskLabelSnapshot(text: string | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function sharedAgentScope(): string {
  const userId = useAuth.getState().user?._id ?? '';
  return `${getServerBase() || 'same-origin'}:${userId}`;
}

function messageAuthorityTimestamp(
  message: Pick<RcMessage, 'ts' | '_updatedAt' | 'editedAt'>,
): number {
  return Math.max(tsMs(message._updatedAt), tsMs(message.editedAt), tsMs(message.ts));
}

function cardLeaseMatchesAuthorityWindow(
  card: AgentSessionCard,
  message: Pick<RcMessage, 'ts' | '_updatedAt' | 'editedAt'>,
): boolean {
  const referenceAt = messageAuthorityTimestamp(message);
  if (!Number.isFinite(referenceAt) || referenceAt <= 0) return false;
  const minLease = referenceAt - LEASE_CLOCK_SKEW_MS;
  const maxLease = referenceAt + LEASE_MS + LEASE_CLOCK_SKEW_MS;
  return card.leaseExpiresAt >= minLease && card.leaseExpiresAt <= maxLease;
}

const LEGACY_SHARED_AGENT_ROOM_ROLES = new Set(['owner', 'moderator', 'leader']);
const LEGACY_SHARED_AGENT_GLOBAL_ROLES = new Set(['admin', 'bot']);

async function hasLegacyLeaseAuthority(message: RcMessage): Promise<boolean> {
  const roomRoles = await useChat.getState().loadRoomRoles(message.rid).catch(() => []);
  const scopedRoles = roomRoles.find((entry) => entry.u._id === message.u._id)?.roles ?? [];
  if (scopedRoles.some((role) => LEGACY_SHARED_AGENT_ROOM_ROLES.has(role))) return true;
  try {
    const user = await rest.getUserInfoById(message.u._id);
    return (user.roles ?? []).some((role) => LEGACY_SHARED_AGENT_GLOBAL_ROLES.has(role));
  } catch {
    return false;
  }
}

async function ingestLeaseCard(
  message: RcMessage,
  parsedCard: AgentSessionCard,
  scope: string,
): Promise<void> {
  if (sharedAgentScope() !== scope) return;
  const authority = agentSessionCardAuthority(message.msg, message, parsedCard);
  if (authority === 'none') return;
  const card = { ...parsedCard, claimId: message._id };
  if (message.u._id !== card.hostUserId || !agentSessionCardMatchesMessage(card, message)) return;
  if (!cardLeaseMatchesAuthorityWindow(card, message)) return;
  if (sharedAgentScope() !== scope) return;
  if (useSharedAgent.getState().sessions[card.tmid]?.leaseMessageId === message._id || card.hostDeviceId === agentDeviceId()) return;
  if (
    authority !== 'custom-fields'
    && authority !== 'lease-message-id'
    && !await hasLegacyLeaseAuthority(message)
  ) return;
  const chat = useChat.getState();
  const room = chat.subscriptions[message.rid] ?? chat.rooms[message.rid];
  const enriched = {
    ...card,
    rid: message.rid,
    roomNameSnapshot: card.roomNameSnapshot || room?.fname || room?.name,
  };
  useSharedAgent.setState((state) => ({ remoteCards: { ...state.remoteCards, [card.tmid]: enriched } }));
}

function recordParams(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function onServerRequest(tmid: string, request: {
  method: string;
  params: unknown;
  policy: ServerRequestPolicy | 'unknown';
}): Promise<unknown> {
  const session = useSharedAgent.getState().sessions[tmid];
  if (!session) throw new Error(t('agent.shared.notActiveSession'));
  const params = recordParams(request.params);
  if (request.policy === 'unknown') throw new Error(t('agent.shared.unknownRequestRejected'));
  if (request.policy === 'safe-reject' || request.policy === 'dynamic-tool') {
    throw new Error(t('agent.shared.requestDisabledInShared'));
  }
  if (request.policy === 'host-input' && isButlerErrandInputMethod(request.method)) {
    const inputId = id('input');
    const input: AgentInput = {
      id: inputId,
      tmid: session.tmid,
      method: request.method,
      policy: 'host-input',
      params: request.params,
      at: Date.now(),
    };
    useSharedAgent.setState((state) => ({ inputs: [...state.inputs, input] }));
    updateSession({ ...session, status: 'waiting-approval', updatedAt: Date.now() });
    trace(session.tmid, 'tool', t('agent.shared.waitingHostInput', { method: request.method }));
    return new Promise((resolve, reject) => {
      inputWaiters.set(scopedInputKey(session.tmid, inputId), { tmid: session.tmid, resolve, reject });
    });
  }
  const actionable = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ]);
  if (!actionable.has(request.method)) throw new Error(t('agent.shared.noApprovalForm'));
  const approvalId = id('approval');
  const trackedFileChanges =
    request.method === 'item/fileChange/requestApproval' && typeof params.itemId === 'string'
      ? fileChangePaths.get(scopedFileChangeKey(tmid, params.itemId))?.paths
      : undefined;
  const fileChanges = trackedFileChanges?.length
    ? Object.fromEntries(trackedFileChanges.map((path) => [path, true]))
    : undefined;
  if (
    request.method === 'item/fileChange/requestApproval' &&
    !fileChanges &&
    typeof params.grantRoot !== 'string'
  ) {
    throw new Error(t('agent.shared.missingFilePaths'));
  }
  const approval: AgentApproval = {
    id: approvalId,
    tmid: session.tmid,
    method: request.method,
    policy: request.policy,
    params: fileChanges ? { ...params, fileChanges } : request.params,
  };
  useSharedAgent.setState((state) => ({ approvals: [...state.approvals, approval] }));
  updateSession({ ...session, status: 'waiting-approval', updatedAt: Date.now() });
  trace(session.tmid, 'tool', t('agent.shared.waitingHostApproval', { method: request.method }));
  return new Promise((resolve, reject) =>
    approvalWaiters.set(scopedApprovalKey(session.tmid, approvalId), { tmid: session.tmid, resolve, reject }),
  );
}

function onNotification(tmid: string, method: string, paramsValue: unknown): void {
  const session = useSharedAgent.getState().sessions[tmid];
  if (!session) return;
  const params = recordParams(paramsValue);
  if (method === 'item/agentMessage/delta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : '';
    const delta = typeof params.delta === 'string' ? params.delta : '';
    const turnKey = scopedTurnKey(tmid, turnId);
    turnBuffers.set(turnKey, `${turnBuffers.get(turnKey) ?? ''}${delta}`);
  } else if (method === 'turn/started') {
    const turn = recordParams(params.turn);
    const turnId = typeof turn.id === 'string' ? turn.id : undefined;
    updateSession({ ...session, status: 'running', activeTurnId: turnId, updatedAt: Date.now() });
    trace(session.tmid, 'status', t('agent.shared.codexProcessing'));
  } else if (method === 'turn/completed') {
    const turn = recordParams(params.turn);
    const turnId = typeof turn.id === 'string' ? turn.id : '';
    void completeTurn(session, turnId, typeof turn.status === 'string' ? turn.status : 'completed');
  } else if (method === 'item/started' || method === 'item/completed') {
    const item = recordParams(params.item);
    const type = typeof item.type === 'string' ? item.type : 'tool';
    if (type === 'fileChange' && typeof item.id === 'string') {
      if (method === 'item/started' && Array.isArray(item.changes)) {
        fileChangePaths.set(scopedFileChangeKey(tmid, item.id), {
          tmid,
          paths: item.changes
            .map((change) => recordParams(change).path)
            .filter((path): path is string => typeof path === 'string'),
        });
      } else {
        fileChangePaths.delete(scopedFileChangeKey(tmid, item.id));
      }
    }
    trace(session.tmid, 'tool', t('agent.shared.stepTrace', { verb: method === 'item/started' ? t('agent.shared.stepStarted') : t('agent.shared.stepCompleted'), type }));
  } else if (method === 'warning' || method === 'error') {
    trace(session.tmid, method === 'error' ? 'error' : 'warning', JSON.stringify(params).slice(0, 1_000));
  }
}

async function completeTurn(session: AgentSession, turnId: string, status: string): Promise<void> {
  const turnKey = scopedTurnKey(session.tmid, turnId);
  const buffered = turnBuffers.get(turnKey) ?? '';
  const text = buffered.trim() ? buffered.replace(/\s+$/u, '') : '';
  turnBuffers.delete(turnKey);
  try {
    if (text) {
      const output = redactAgentOutput(text);
      const prefix = output.redacted > 0 ? t('agent.shared.codexRedactedPrefix', { count: output.redacted }) : '🤖 Codex\n';
      await sendAgentReply(session, `${prefix}${output.text}`);
    } else if (status !== 'completed') {
      await sendAgentReply(session, t('agent.shared.codexIncomplete', { status }));
    }
    const current = useSharedAgent.getState().sessions[session.tmid] ?? session;
    if (current.status !== 'ended') {
      updatePublishedSession({
        ...current,
        status: 'ready',
        activeTurnId: undefined,
        currentTaskLabel: undefined,
        updatedAt: Date.now(),
      });
    }
    trace(session.tmid, 'status', t('agent.shared.turnEnded', { status }));
    turnWaiters.get(turnKey)?.resolve();
  } catch (error) {
    turnWaiters.get(turnKey)?.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    turnWaiters.delete(turnKey);
  }
}

function clearTrackedFileChanges(tmid: string): void {
  for (const [itemId, tracked] of fileChangePaths) {
    if (tracked.tmid === tmid) fileChangePaths.delete(itemId);
  }
}

function clearSessionTransientState(tmid: string): void {
  const keyPrefix = scopedRuntimeKey(tmid, '');
  for (const turnKey of turnBuffers.keys()) {
    if (turnKey.startsWith(keyPrefix)) turnBuffers.delete(turnKey);
  }
  clearTrackedFileChanges(tmid);
}

function rejectSessionWaiters<T extends { tmid: string; reject: (error: Error) => void }>(
  tmid: string,
  waiters: Map<string, T>,
  error: Error,
): void {
  for (const [id, waiter] of waiters) {
    if (waiter.tmid !== tmid) continue;
    waiter.reject(error);
    waiters.delete(id);
  }
}

function clearPendingSessionRequests(tmid: string): void {
  useSharedAgent.setState((state) => ({
    approvals: state.approvals.filter((approval) => approval.tmid !== tmid),
    inputs: state.inputs.filter((input) => input.tmid !== tmid),
  }));
}

function onInterrupted(tmid: string, error: Error): void {
  controllers.delete(tmid);
  controllerStarts.delete(tmid);
  controllerIdentities.delete(tmid);
  controllerStartIdentities.delete(tmid);
  const session = useSharedAgent.getState().sessions[tmid];
  if (session && session.status !== 'ended') {
    const detail = redactAgentOutput(error.message).text;
    const interrupted = { ...interruptSession(session), lastError: detail };
    updateSession(interrupted);
    void updateLeaseCard(interrupted).catch(() => undefined);
    trace(tmid, 'error', detail);
  }
  clearSessionTransientState(tmid);
  rejectSessionWaiters(tmid, turnWaiters, error);
  rejectSessionWaiters(tmid, approvalWaiters, error);
  rejectSessionWaiters(tmid, inputWaiters, error);
  clearPendingSessionRequests(tmid);
}

async function ensureController(
  session: AgentSession,
): Promise<{ controller: SharedAgentController; catalog: CodexCatalog }> {
  if (!isTauriRuntime()) throw new Error(t('agent.shared.desktopOnly'));
  const identity = controllerIdentity(session);
  const current = controllers.get(session.tmid);
  if (current && controllerIdentities.get(session.tmid) === identity) {
    const catalog = current.currentCatalog ?? await current.connect(session.sessionId, session.workspaceRoots[0]);
    return { controller: current, catalog };
  }
  if (current) await stopController(session.tmid);
  const pending = controllerStarts.get(session.tmid);
  if (pending && controllerStartIdentities.get(session.tmid) === identity) return pending;
  if (pending) await stopController(session.tmid);
  const start = (async () => {
    const next = sharedAgentControllerFactory({
      onNotification: (method, params) => onNotification(session.tmid, method, params),
      onServerRequest: (request) => onServerRequest(session.tmid, request),
      onInterrupted: (error) => {
        if (useSharedAgent.getState().sessions[session.tmid]?.sessionId === session.sessionId) {
          onInterrupted(session.tmid, error);
        }
      },
    });
    try {
      const catalog = await next.connect(session.sessionId, session.workspaceRoots[0]);
      controllers.set(session.tmid, next);
      controllerIdentities.set(session.tmid, identity);
      return { controller: next, catalog };
    } catch (error) {
      await next.stop().catch(() => undefined);
      throw error;
    }
  })();
  controllerStarts.set(session.tmid, start);
  controllerStartIdentities.set(session.tmid, identity);
  try {
    return await start;
  } finally {
    controllerStarts.delete(session.tmid);
    controllerStartIdentities.delete(session.tmid);
  }
}

export async function shutdownSharedAgentRuntime(): Promise<void> {
  sharedAgentBridgeCleanup?.();
  const tmids = new Set([
    ...controllers.keys(),
    ...controllerStarts.keys(),
  ]);
  await Promise.all([...tmids].map((tmid) => stopController(tmid).catch(() => undefined)));
}

async function stopController(tmid: string): Promise<void> {
  const pending = controllerStarts.get(tmid);
  let current = controllers.get(tmid);
  controllers.delete(tmid);
  controllerStarts.delete(tmid);
  controllerIdentities.delete(tmid);
  controllerStartIdentities.delete(tmid);
  if (!current && pending) current = (await pending.catch(() => undefined))?.controller;
  controllers.delete(tmid);
  controllerIdentities.delete(tmid);
  if (current) await current.stop();
}

async function releaseTranscriptController(session: AgentSession): Promise<void> {
  const identity = controllerIdentity(session);
  if (agentBackend(session) === 'deepseek') return;
  if (controllerIdentities.get(session.tmid) !== identity) return;
  const controller = controllers.get(session.tmid);
  controllers.delete(session.tmid);
  controllerIdentities.delete(session.tmid);
  await controller?.stop();
}

async function loadContextMessages(session: AgentSession, command: RcMessage): Promise<RcMessage[]> {
  const cached = useChat.getState().messages[command.rid] ?? [];
  if (!replyTmid(session)) {
    const messages = new Map(cached.map((message) => [message._id, message]));
    const type = useChat.getState().subscriptions[command.rid]?.t ?? useChat.getState().rooms[command.rid]?.t ?? 'p';
    try {
      for (const message of await rest.getHistory(command.rid, type, 100)) messages.set(message._id, message);
    } catch (error) {
      trace(session.tmid, 'warning', t('agent.shared.discussionContextIncomplete', { error: error instanceof Error ? error.message : String(error) }));
    }
    return [...messages.values()].sort((left, right) => tsMs(left.ts) - tsMs(right.ts));
  }
  const roots = new Set<string>();
  if (command.tmid) roots.add(command.tmid);
  for (const quotedId of quoteMessageIds(command).slice(0, 3)) {
    const quoted = cached.find((message) => message._id === quotedId);
    roots.add(quoted?.tmid ?? quotedId);
  }
  const messages = new Map(cached.map((message) => [message._id, message]));
  for (const root of roots) {
    try {
      for (const message of await rest.getThreadMessages(root, 100)) messages.set(message._id, message);
    } catch (error) {
      trace(
        command.tmid ?? command._id,
        'warning',
        t('agent.shared.threadContextIncomplete', { error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }
  return [...messages.values()];
}

/** 托管会话的完整对话：房间托管取房间近 100 条，话题托管取话题消息（缓存兜底） */
async function sessionConversationMessages(session: AgentSession): Promise<RcMessage[]> {
  const cached = useChat.getState().messages[session.rid] ?? [];
  const root = replyTmid(session);
  if (!root) {
    const messages = new Map(cached.map((message) => [message._id, message]));
    const type = useChat.getState().subscriptions[session.rid]?.t ?? useChat.getState().rooms[session.rid]?.t ?? 'p';
    try {
      for (const message of await rest.getHistory(session.rid, type, 100)) messages.set(message._id, message);
    } catch {
      /* 拉取失败时用本机缓存兜底 */
    }
    return [...messages.values()]
      .filter((message) => message.rid === session.rid)
      .sort((left, right) => tsMs(left.ts) - tsMs(right.ts));
  }
  const messages = new Map(
    cached
      .filter((message) => message._id === root || message.tmid === root)
      .map((message) => [message._id, message]),
  );
  try {
    for (const message of await rest.getThreadMessages(root, 100)) messages.set(message._id, message);
  } catch {
    /* 拉取失败时用本机缓存兜底 */
  }
  return [...messages.values()].sort((left, right) => tsMs(left.ts) - tsMs(right.ts));
}

/** 读取一条托管会话的 Rocket.Chat 真源消息，供只读历史视图使用。 */
export async function loadSharedAgentConversationMessages(tmid: string): Promise<RcMessage[]> {
  const session = useSharedAgent.getState().sessions[tmid];
  return session ? sessionConversationMessages(session) : [];
}

async function executeCommand(session: AgentSession, message: RcMessage): Promise<void> {
  if (remoteSessionControls(session.tmid)) return;
  let current = useSharedAgent.getState().sessions[session.tmid] ?? session;
  const selectedProvider = getAiRuntimeProvider();
  if (selectedProvider === 'none' || agentBackend(current) !== 'codex') {
    throw new Error(t('agent.shared.runtimeMismatch'));
  }
  current = withSessionRuntimeSnapshot(current);
  updateSession(current);
  const { controller, catalog } = await ensureController(current);
  const resolvedRuntime = resolveSessionRuntime(current, catalog);
  current = resolvedRuntime.session;
  const codex = { controller, selection: resolvedRuntime.selection };
  updateSession(current);
  const messages = await loadContextMessages(current, message);
  const selectedMessages = replyTmid(current)
    ? selectAgentContextMessages(message, messages)
    : messages.filter((item) => item.rid === message.rid).slice(-200);
  const attachmentDestination: AgentAttachmentDestination = { kind: 'pi', sessionId: current.sessionId };
  const attachments = await materializeAgentAttachments(attachmentDestination, selectedMessages);
  for (const warning of attachments.warnings) trace(current.tmid, 'warning', warning);
  const prompt = buildAgentContext({
    command: message,
    messages,
    room: useChat.getState().rooms[message.rid],
    limit: 200,
    attachmentPaths: attachments.paths,
    linkedWorkItems: collectLinkedWorkItems(
      selectedMessages,
      adoWebBase(),
      useWorkbench.getState().workItems,
    ),
  });
  updateSession({ ...current, status: 'running', lastError: undefined, updatedAt: Date.now() });
  const turnId = await codex.controller.startTurn(
    current.codexThreadId!,
    agentTurnInput(prompt, attachments.imagePaths),
    codex.selection,
    { runtimeWorkspaceRoots: attachments.roots },
  );
  updateSession({ ...current, status: 'running', activeTurnId: turnId, updatedAt: Date.now() });
  await new Promise<void>((resolve, reject) =>
    turnWaiters.set(scopedTurnKey(current.tmid, turnId), { tmid: current.tmid, resolve, reject }),
  );
}

async function queueCommand(session: AgentSession, message: RcMessage): Promise<void> {
  const queue = queues.get(session.tmid) ?? new SerialCommandQueue();
  queues.set(session.tmid, queue);
  await queue.enqueue(async () => {
    if (remoteSessionControls(session.tmid)) return;
    const current = useSharedAgent.getState().sessions[session.tmid] ?? session;
    const currentTaskLabel = taskLabelSnapshot(
      agentMessageInstruction(message, 'ai', true) ?? message.msg,
    );
    if (current.currentTaskLabel !== currentTaskLabel) {
      updatePublishedSession({
        ...current,
        currentTaskLabel,
        updatedAt: Date.now(),
      });
    }
    try {
      const name = agentName(session);
      await sendAgentReply(session, t('agent.shared.receivedThinking', { name })).catch((error) => {
        trace(session.tmid, 'warning', t('agent.shared.thinkingFeedbackFailed', { error: error instanceof Error ? error.message : String(error) }));
      });
      await executeCommand(useSharedAgent.getState().sessions[session.tmid] ?? session, message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      trace(session.tmid, 'error', detail);
      const current = useSharedAgent.getState().sessions[session.tmid] ?? session;
      if (current.status === 'ended' || current.status === 'interrupted') return;
      updatePublishedSession({
        ...current,
        status: 'ready',
        activeTurnId: undefined,
        currentTaskLabel: undefined,
        lastError: detail,
        updatedAt: Date.now(),
      });
      await sendAgentReply(session, t('agent.shared.executionFailed', { name: agentName(session), error: redactAgentOutput(detail).text }));
    }
  });
}

export const useSharedAgent = create<SharedAgentState>((set, get) => ({
  sessions: {},
  remoteCards: {},
  traces: {},
  approvals: [],
  inputs: [],
  memberRequests: [],
  error: null,

  ingestCard: (message) => {
    const card = parseAgentSessionCard(message.msg, message);
    if (!card) return Promise.resolve();
    const scope = sharedAgentScope();
    const sequenceKey = `${scope}\u0000${card.tmid}`;
    const queued = (ingestSequences.get(sequenceKey) ?? Promise.resolve())
      .then(() => ingestLeaseCard(message, card, scope));
    const settled = queued.catch(() => undefined);
    ingestSequences.set(sequenceKey, settled);
    void settled.finally(() => {
      if (ingestSequences.get(sequenceKey) === settled) ingestSequences.delete(sequenceKey);
    });
    return queued;
  },

  readTranscript: async (tmid) => {
    const session = get().sessions[tmid];
    if (!session) throw new Error(t('agent.shared.sessionNotOnDevice'));
    const releaseAfterRead = session.status === 'ended';
    try {
      if (agentBackend(session) === 'deepseek') {
        throw new Error(t('agent.shared.legacyDshRetired'));
      }
      if (!session.codexThreadId) {
        if (session.status === 'starting') return [];
        throw new Error(t('agent.shared.missingThreadId'));
      }
      const { controller } = await ensureController(session);
      const loaded = await controller.readThread(session.codexThreadId);
      return naturalTranscript(messagesFromTurns(loaded.turns));
    } finally {
      if (releaseAfterRead) await releaseTranscriptController(session).catch(() => undefined);
    }
  },

  restore: async () => {
    const user = useAuth.getState().user;
    if (!user) {
      ingestSequences.clear();
      restoreGeneration += 1;
      restoredScope = '';
      set(emptySharedAgentScope());
      return;
    }
    const serverId = getServerBase() || 'same-origin';
    const scope = `${serverId}:${user._id}`;
    if (restoredScope === scope) return;
    const generation = ++restoreGeneration;
    restoredScope = scope;
    ingestSequences.clear();
    set(emptySharedAgentScope());
    let stored: AgentSession[];
    try {
      stored = await listAgentSessions(serverId, user._id);
    } catch (error) {
      if (generation === restoreGeneration && restoredScope === scope) {
        restoredScope = '';
        set({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const currentUser = useAuth.getState().user;
    const currentScope = currentUser ? `${getServerBase() || 'same-origin'}:${currentUser._id}` : '';
    if (generation !== restoreGeneration || restoredScope !== scope || currentScope !== scope) return;
    const sessions: Record<string, AgentSession> = {};
    const recovered: AgentSession[] = [];
    const now = Date.now();
    for (const session of stored) {
      let restored = restoreSession(session, now, ORPHAN_SESSION_MS);
      if (
        restored.status === 'interrupted' &&
        restored.host.userId === user._id &&
        restored.host.deviceId === agentDeviceId()
      ) {
        restored = takeHostLease(restored, restored.host, now, LEASE_MS);
      }
      sessions[session.tmid] = restored;
      if (restored.status === 'ended' && restored.tmid.startsWith('room:')) {
        useAgentEnvironments.getState().endBinding(restored.rid);
      }
      if (session.status !== restored.status || session.host.expiresAt !== restored.host.expiresAt) {
        recovered.push(restored);
      }
    }
    set({ sessions });
    for (const session of recovered) {
      void saveAgentSession(session, session.ownerUserId);
      void updateLeaseCard(session).catch(() => undefined);
    }
  },

  startSession: async (rid, tmid, options = {}) => {
    if (!isTauriRuntime()) throw new Error(t('agent.shared.desktopOnly'));
    const authoritativeRemote = remoteSessionControls(tmid);
    if (authoritativeRemote) {
      throw new Error(t('agent.shared.hostedOnOtherDevice', { username: authoritativeRemote.hostUsername }));
    }
    const pending = startingSessions.get(tmid);
    if (pending) return pending;
    const existing = get().sessions[tmid];
    if (existing && existing.status !== 'ended') return existing;
    const start = (async () => {
      set({ error: null });
      const host = actor();
      const now = Date.now();
      const sessionId = id('session');
      const workspaceScope = `${getServerBase() || 'same-origin'}:${host.userId}`;
      if (useCodexWorkspace.getState().scope !== workspaceScope) {
        useCodexWorkspace.getState().hydrate(workspaceScope);
      }
      const defaultWorkspaceRoot = useCodexWorkspace.getState().defaultWorkspaceRoot
        || await useCodexWorkspace.getState().ensureDefaultWorkspace();
      const butlerWorkspaceRoot = useCodexWorkspace.getState().butlerWorkspaceRoot;
      const root = options.workspaceRoot?.trim();
      if (!root || isSystemCodexWorkspace(root, defaultWorkspaceRoot, butlerWorkspaceRoot)) {
        throw new Error(t('agent.shared.needDedicatedProject'));
      }
      assertAllowedWorkspacePath(root, [root]);
      const selectedProvider = getAiRuntimeProvider();
      if (selectedProvider === 'none') throw new Error(t('agent.hosting.aiDisabled'));
      const effectiveBackend: AgentBackend = 'codex';
      if (options.backend && options.backend !== effectiveBackend) {
        throw new Error(t('agent.shared.mustUseActiveRuntime'));
      }
      const backend: AgentBackend = effectiveBackend;
      const initialSession: AgentSession = {
        sessionId,
        serverId: getServerBase() || 'same-origin',
        ownerUserId: host.userId,
        rid,
        tmid,
        replyTmid: options.replyTmid,
        roomNameSnapshot: roomNameSnapshot(rid),
        host: { ...host, heartbeatAt: now, expiresAt: now + LEASE_MS },
        access: 'room-members',
        approvedMemberIds: [],
        status: 'starting',
        backend,
        runtimeModel: options.runtimeModel,
        runtimeEffort: options.runtimeEffort,
        runtimePermissionPreset: options.runtimePermissionPreset,
        workspaceRoots: [root],
        environmentId: options.environmentId,
        environmentName: options.environmentName,
        workItem: options.workItem,
        proposedBranch: options.proposedBranch,
        baseBranch: options.baseBranch,
        updatedAt: now,
      };
      let session = withSessionRuntimeSnapshot(initialSession);
      updateSession(session);
      const { controller: appServer, catalog } = await ensureController(session);
      const resolvedRuntime = resolveSessionRuntime(session, catalog);
      session = resolvedRuntime.session;
      updateSession(session);
      const response = await appServer.startThread(resolvedRuntime.selection);
      session = {
        ...session,
        codexThreadId: response.id,
        ...(appServer.processInfo?.version
          ? { createdWithCodexVersion: appServer.processInfo.version }
          : {}),
        ...(appServer.processInfo?.runtimeSource
          ? { createdWithRuntimeSource: appServer.processInfo.runtimeSource }
          : {}),
        status: 'ready',
        lastError: undefined,
        updatedAt: Date.now(),
      };
      nameCodexThread(appServer, session);
      updateSession(session);
      trace(tmid, 'status', t('agent.shared.sessionStarted', { name: agentName(session) }));
      const leaseMessage = await sendLeaseCard(session);
      session = { ...session, leaseMessageId: leaseMessage._id, updatedAt: Date.now() };
      updateSession(session);
      return session;
    })();
    startingSessions.set(tmid, start);
    try {
      return await start;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      set({ error: detail });
      await stopController(tmid).catch(() => undefined);
      const failed = get().sessions[tmid];
      if (failed && failed.status !== 'ended') {
        updateSession(
          failed.codexThreadId
            ? { ...interruptSession(failed), lastError: detail }
            : { ...failed, status: 'ended', lastError: detail, updatedAt: Date.now() },
        );
      }
      throw error;
    } finally {
      startingSessions.delete(tmid);
    }
  },

  handleMessage: async (message) => {
    await get().ingestCard(message);
    const sessions = get().sessions;
    const remoteCards = get().remoteCards;
    const sessionKey = resolveAgentSessionKey(
      message.rid,
      message.tmid,
      new Set([...Object.keys(sessions), ...Object.keys(remoteCards)]),
    );
    const allowLiteralAi = !!sessions[sessionKey] || !!remoteCards[sessionKey];
    if (message.pending || message.failed || agentMessageInstruction(message, 'ai', allowLiteralAi) === null) return;
    if (processedMessages.has(message._id)) return;
    processedMessages.add(message._id);
    if (remoteSessionControls(sessionKey)) return;
    try {
      const me = useAuth.getState().user;
      if (!me) return;
      let session = get().sessions[sessionKey];
      if (!session) {
        if (!message.tmid) return;
        if (message.u._id !== me._id) return;
        session = await get().startSession(message.rid, message.tmid, { replyTmid: message.tmid });
      }
      if (session.status === 'starting') {
        const start = startingSessions.get(session.tmid);
        if (!start) throw new Error(t('agent.shared.startIncomplete'));
        session = await start;
      }
      if (session.status === 'interrupted') {
        if (message.u._id !== me._id) return;
        await get().resumeSession(session.tmid);
        session = get().sessions[session.tmid];
      }
      const access = commandAccess(session, message.u._id);
      if (access === 'denied') {
        return;
      }
      if (access === 'requires-host-approval') {
        const request: AgentMemberRequest = {
          id: id('member'),
          tmid: session.tmid,
          command: {
            messageId: message._id,
            userId: message.u._id,
            username: message.u.username,
            text: message.msg,
            createdAt: Date.now(),
          },
        };
        set((state) => ({ memberRequests: [...state.memberRequests, request] }));
        trace(session.tmid, 'status', t('agent.shared.waitingHostGrant', { username: message.u.username }));
        return;
      }
      await queueCommand(session, message);
    } catch (error) {
      processedMessages.delete(message._id);
      const detail = error instanceof Error ? error.message : String(error);
      const failed = get().sessions[sessionKey];
      if (failed) updateSession({ ...failed, lastError: detail, updatedAt: Date.now() });
      else set({ error: detail });
      trace(sessionKey, 'error', detail);
    }
  },

  approveMemberRequest: async (requestId, allowed) => {
    const request = get().memberRequests.find((item) => item.id === requestId);
    if (!request) return;
    const session = get().sessions[request.tmid];
    if (!session) return;
    assertHost(session, actor());
    set((state) => ({ memberRequests: state.memberRequests.filter((item) => item.id !== requestId) }));
    if (!allowed) {
      await useChat.getState().send(t('agent.shared.commandDeniedByHost', { username: request.command.username }), {
        rid: session.rid,
        tmid: replyTmid(session),
      });
      return;
    }
    const approved = approveMember(session, actor(), request.command.userId);
    updateSession(approved);
    const message = (useChat.getState().messages[session.rid] ?? []).find(
      (item) => item._id === request.command.messageId,
    );
    if (message) await queueCommand(approved, message);
  },

  resolveApproval: async (approvalId, resolution) => {
    const approval = get().approvals.find((item) => item.id === approvalId);
    if (!approval) return;
    const session = get().sessions[approval.tmid];
    if (!session) return;
    assertHost(session, actor());
    const params = recordParams(approval.params);
    let safeApproval = resolution !== 'decline';
    if (safeApproval) {
      try {
        validateApprovalPaths(params, session.workspaceRoots);
      } catch (error) {
        safeApproval = false;
        trace(session.tmid, 'warning', error instanceof Error ? error.message : String(error));
      }
    }
    if (safeApproval && commandRequestMentionsSensitivePath(params.command)) {
      safeApproval = false;
      trace(session.tmid, 'warning', t('agent.shared.sensitivePathRejected'));
    }
    let permissions = {};
    if (safeApproval && (params.permissions || params.additionalPermissions)) {
      try {
        permissions = validatePermissionRequest(
          (params.permissions ?? params.additionalPermissions) as Parameters<typeof validatePermissionRequest>[0],
          session.workspaceRoots,
        );
      } catch (error) {
        safeApproval = false;
        trace(session.tmid, 'warning', error instanceof Error ? error.message : String(error));
      }
    }
    const decision = sharedAgentApprovalResult(
      approval.method,
      safeApproval ? resolution : 'decline',
      permissions,
    );
    approvalWaiters.get(scopedApprovalKey(session.tmid, approvalId))?.resolve(decision);
    approvalWaiters.delete(scopedApprovalKey(session.tmid, approvalId));
    set((state) => ({ approvals: state.approvals.filter((item) => item.id !== approvalId) }));
    updateSession({ ...session, status: 'running', updatedAt: Date.now() });
    trace(session.tmid, 'status', safeApproval ? t('agent.shared.hostAllowed') : t('agent.shared.hostDeclined'));
  },

  resolveInput: async (inputId, response) => {
    const input = get().inputs.find((item) => item.id === inputId);
    if (!input) return;
    const session = get().sessions[input.tmid];
    if (!session) return;
    assertHost(session, actor());
    const validated = validateButlerErrandInputResponse(input.method, input.params, response);
    inputWaiters.get(scopedInputKey(session.tmid, inputId))?.resolve(validated);
    inputWaiters.delete(scopedInputKey(session.tmid, inputId));
    set((state) => ({ inputs: state.inputs.filter((item) => item.id !== inputId) }));
    updateSession({ ...session, status: 'running', updatedAt: Date.now() });
    trace(session.tmid, 'status', t('agent.shared.hostSubmittedInput'));
  },

  setAccess: async (tmid, access) => {
    const session = get().sessions[tmid];
    if (!session) return;
    assertHost(session, actor());
    updateSession({
      ...session,
      access,
      approvedMemberIds: access === 'host-only' ? [] : session.approvedMemberIds,
      updatedAt: Date.now(),
    });
    trace(tmid, 'status', access === 'host-only' ? t('agent.shared.accessHostOnly') : t('agent.shared.accessMemberRequest'));
  },

  resumeSession: async (tmid) => {
    const existing = get().sessions[tmid];
    if (!existing) return;
    const authoritativeRemote = remoteSessionControls(tmid);
    if (authoritativeRemote) {
      throw new Error(t('agent.shared.resumeOnOtherDevice', { username: authoritativeRemote.hostUsername }));
    }
    const selectedProvider = getAiRuntimeProvider();
    if (selectedProvider === 'none' || agentBackend(existing) !== 'codex') {
      throw new Error(t('agent.shared.runtimeMismatch'));
    }
    const host = actor();
    const now = Date.now();
    const leased = takeHostLease(existing, host, now, LEASE_MS);
    let resuming: AgentSession = withSessionRuntimeSnapshot({ ...enterResumeState(leased, host, now), lastError: undefined });
    updateSession(resuming);
    try {
      const { controller: appServer, catalog } = await ensureController(resuming);
      const resolvedRuntime = resolveSessionRuntime(resuming, catalog);
      resuming = resolvedRuntime.session;
      updateSession(resuming);
      const response = await appServer.resumeThread(resuming.codexThreadId!, resolvedRuntime.selection);
      const resumed: AgentSession = {
        ...resuming,
        codexThreadId: response.id,
        ...(appServer.processInfo?.version
          ? { lastResumedWithCodexVersion: appServer.processInfo.version }
          : {}),
        ...(appServer.processInfo?.runtimeSource
          ? { lastResumedWithRuntimeSource: appServer.processInfo.runtimeSource }
          : {}),
        status: 'ready',
        lastError: undefined,
        updatedAt: Date.now(),
      };
      nameCodexThread(appServer, resumed); // 旧线程也补上名字
      updateSession(resumed);
      trace(tmid, 'status', t('agent.shared.resumedSession', { name: agentName(resumed) }));
      try {
        await updateLeaseCard(get().sessions[tmid]);
      } catch (error) {
        const detail = redactAgentOutput(error instanceof Error ? error.message : String(error)).text;
        trace(tmid, 'warning', t('agent.shared.resumedCardSyncFailed', { name: agentName(resumed), error: detail }));
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await stopController(tmid).catch(() => undefined);
      onInterrupted(tmid, failure);
      throw failure;
    }
  },

  transferToCodexApp: async (tmid) => {
    const session = get().sessions[tmid];
    if (!session || session.status === 'ended') throw new Error(t('agent.shared.sessionNotRunning'));
    const messages = await sessionConversationMessages(session);
    const lines = agentConversationLines(
      messages
        .filter((message) => !message.pending && !message.failed && !parseAgentSessionCard(message.msg, message))
        .map((message) => {
          const raw = stripAgentSessionMarker(message.msg ?? '').trim();
          const assistant = raw.startsWith('🤖');
          return {
            // 「🤖 Codex」前缀行只是署名，去掉；单行的状态类消息保留原文
            text: assistant ? raw.replace(/^🤖[^\n]*\n?/u, '').trim() || raw : raw,
            author: message.u.name || message.u.username,
            assistant,
          };
        }),
    );
    const result = await openCodexNewThread(
      transferTranscript(t('agent.codexTransfer.kindHosted'), lines),
      session.workspaceRoots[0],
    );
    if (result === 'opened' || result === 'opened-with-copy') {
      trace(tmid, 'status', t('agent.shared.openedCodexApp'));
    } else if (result === 'copied') {
      trace(tmid, 'status', t('agent.shared.openFailedCopied'));
    } else {
      trace(tmid, 'error', t('agent.shared.openAndCopyFailed'));
    }
    return result;
  },

  endSession: async (tmid) => {
    const session = get().sessions[tmid];
    if (!session) return;
    assertHost(session, actor());
    const ended = { ...session, status: 'ended' as const, activeTurnId: undefined, updatedAt: Date.now() };
    updateSession(ended);
    const appServer = controllers.get(tmid);
    if (session.activeTurnId && session.codexThreadId && appServer) {
      await appServer.interruptTurn(session.codexThreadId, session.activeTurnId).catch(() => undefined);
    }
    await stopController(tmid).catch(() => undefined);
    const endedError = new Error(t('agent.shared.sessionEnded'));
    clearSessionTransientState(tmid);
    rejectSessionWaiters(tmid, turnWaiters, endedError);
    rejectSessionWaiters(tmid, approvalWaiters, endedError);
    rejectSessionWaiters(tmid, inputWaiters, endedError);
    clearPendingSessionRequests(tmid);
    trace(tmid, 'status', t('agent.shared.sessionEnded'));
    await updateLeaseCard(ended).catch(() => undefined);
    if (!replyTmid(session)) useAgentEnvironments.getState().endBinding(session.rid);
    await useChat.getState().send(t('agent.shared.sessionEndedNotice', { name: agentName(session) }), { rid: session.rid, tmid: replyTmid(session) });
  },
}));

export function setSharedAgentControllerFactory(factory: SharedAgentControllerFactory): () => void {
  const previous = sharedAgentControllerFactory;
  sharedAgentControllerFactory = factory;
  return () => {
    sharedAgentControllerFactory = previous;
  };
}

export function setSharedAgentMessageSizeProviderForTests(
  provider: typeof sharedAgentMessageSizeProvider,
): () => void {
  const previous = sharedAgentMessageSizeProvider;
  sharedAgentMessageSizeProvider = provider;
  return () => {
    sharedAgentMessageSizeProvider = previous;
  };
}

export async function startSharedAgentBridge(): Promise<() => void> {
  if (sharedAgentBridgeCleanup) return sharedAgentBridgeCleanup;
  const restore = useSharedAgent.getState().restore();
  const unsubscribeAuth = useAuth.subscribe((state, previous) => {
    if (state.user?._id !== previous.user?._id) void useSharedAgent.getState().restore();
  });
  const unsubscribeChat = useChat.subscribe((state, previous) => {
    for (const [rid, messages] of Object.entries(state.messages)) {
      const before = previous.messages[rid] ?? [];
      if (messages === before) continue;
      const changes = agentMessageBridgeChanges(
        messages,
        before,
        // 首次打开房间会整批写入历史消息；旧 @ai 只能用于展示，不能重新执行。
        !previous.historyLoaded[rid] && !!state.historyLoaded[rid],
      );
      for (const message of changes.ingestOnly) {
        void useSharedAgent.getState().ingestCard(message);
      }
      for (const message of changes.handle) {
        void useSharedAgent.getState().handleMessage(message);
      }
    }
  });
  const heartbeat = window.setInterval(() => {
    const now = Date.now();
    for (const session of Object.values(useSharedAgent.getState().sessions)) {
      if (session.status === 'ended' || session.host.deviceId !== agentDeviceId()) continue;
      updateSession({
        ...session,
        host: { ...session.host, heartbeatAt: now, expiresAt: now + LEASE_MS },
        updatedAt: now,
      });
      void updateLeaseCard(useSharedAgent.getState().sessions[session.tmid]).catch(() => undefined);
    }
  }, LEASE_MS / 3);
  const cleanup = () => {
    if (sharedAgentBridgeCleanup !== cleanup) return;
    sharedAgentBridgeCleanup = null;
    unsubscribeAuth();
    unsubscribeChat();
    clearInterval(heartbeat);
  };
  sharedAgentBridgeCleanup = cleanup;
  await restore;
  return cleanup;
}

export function stopSharedAgentBridge(): void {
  sharedAgentBridgeCleanup?.();
}

registerUserRuntimeShutdownHook('sharedAgent', () => shutdownSharedAgentRuntime());
