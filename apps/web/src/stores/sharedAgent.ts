import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { getServerBase, isTauri, rest } from '../lib/client';
import { useAuth } from './auth';
import { useChat } from './chat';
import { AppServerClient, TauriCodexTransport, type ServerRequestPolicy } from '../agent/protocol';
import { agentDeviceId } from '../agent/device';
import {
  agentSessionCardMatchesMessage,
  parseAgentSessionCard,
  renderAgentSessionCard,
  stripAgentSessionMarker,
  type AgentSessionCard,
} from '../agent/card';
import {
  agentMessageInstruction,
  buildAgentDeveloperInstructions,
  buildAgentContext,
  collectLinkedWorkItems,
  quoteMessageIds,
  selectAgentContextMessages,
} from '../agent/context';
import { materializeAgentAttachments } from '../agent/attachments';
import {
  cleanupCodexTransferSession,
  dispatchCodexImportCompleted,
  importSessionFileToCodex,
  writeCodexTransferSession,
} from '../agent/codexImport';
import { agentConversationLines, claudeSessionJsonl } from '../agent/codexTransfer';
import { rocketxThreadName } from '../agent/threadName';
import { adoWebBase } from '../lib/ado';
import {
  SerialCommandQueue,
  approveMember,
  assertHost,
  commandAccess,
  interruptSession,
  resumeSession as enterResumeState,
  restoreSession,
  takeHostLease,
  type AgentCommand,
  type AgentSession,
} from '../agent/session';
import { listAgentSessions, saveAgentSession } from '../agent/sessionStore';
import { useWorkbench } from './workbench';
import { useLocalCodex } from './localCodex';
import { agentRoomSessionKey, useAgentEnvironments } from './agentEnvironments';
import { getButlerCodexSettings } from '../lib/butlerBrain';
import {
  assertAllowedWorkspacePath,
  commandRequestMentionsSensitivePath,
  redactAgentOutput,
  validateApprovalPaths,
  validatePermissionRequest,
} from '../agent/safety';

const LEASE_MS = 90_000;
const ORPHAN_SESSION_MS = 30 * 60_000;
const TRACE_LIMIT = 200;
const APPROVAL_POLICY = {
  granular: {
    sandbox_approval: true,
    rules: false,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: false,
  },
} as const;

function sandboxPolicy(mode: AgentSession['sandboxMode'], writableRoots: string[]) {
  return mode === 'workspace-write'
    ? {
        type: 'workspaceWrite' as const,
        writableRoots,
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    : { type: 'readOnly' as const, networkAccess: false };
}

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

export interface AgentMemberRequest {
  id: string;
  tmid: string;
  command: AgentCommand;
}

export interface AgentSessionStartOptions {
  workspaceRoot?: string;
  replyTmid?: string;
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
  memberRequests: AgentMemberRequest[];
  error: string | null;
  restore: () => Promise<void>;
  ingestCard: (message: RcMessage) => void;
  startSession: (rid: string, sessionKey: string, options?: AgentSessionStartOptions) => Promise<AgentSession>;
  handleMessage: (message: RcMessage) => Promise<void>;
  approveMemberRequest: (id: string, allowed: boolean) => Promise<void>;
  resolveApproval: (id: string, approved: boolean) => Promise<void>;
  setSandboxMode: (tmid: string, mode: AgentSession['sandboxMode']) => Promise<void>;
  setAccess: (tmid: string, access: AgentSession['access']) => Promise<void>;
  resumeSession: (tmid: string) => Promise<void>;
  endSession: (tmid: string) => Promise<void>;
  /** 把托管对话转移进 Codex（导入成 App 认可来源的线程快照副本） */
  transferToCodexApp: (tmid: string) => Promise<void>;
}

const queues = new Map<string, SerialCommandQueue>();
const turnBuffers = new Map<string, string>();
const fileChangePaths = new Map<string, { threadId: string; paths: string[] }>();
const turnWaiters = new Map<
  string,
  { tmid: string; resolve: () => void; reject: (error: Error) => void }
>();
const approvalWaiters = new Map<
  string,
  { tmid: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const processedMessages = new Set<string>();
const startingSessions = new Map<string, Promise<AgentSession>>();
const clients = new Map<string, AppServerClient>();
const clientStarts = new Map<string, Promise<AppServerClient>>();
let restoredScope = '';

function id(prefix: string): string {
  const value = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `${prefix}-${value}`;
}

function actor() {
  const user = useAuth.getState().user;
  if (!user) throw new Error('需要先登录 Rocket.Chat');
  return { userId: user._id, deviceId: agentDeviceId() };
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
    tmid: session.tmid,
    hostUserId: session.host.userId,
    hostUsername: user?.username ?? session.host.userId,
    hostDeviceId: session.host.deviceId,
    leaseExpiresAt: session.host.expiresAt,
    environmentName: session.environmentName,
    workItem: session.workItem,
    proposedBranch: session.proposedBranch,
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

async function sendAgentReply(session: AgentSession, text: string): Promise<void> {
  try {
    const sent = await invoke<unknown | null>('agent_bot_send', {
      serverUrl: getServerBase(),
      rid: session.rid,
      tmid: replyTmid(session) ?? null,
      text,
    });
    if (sent !== null) return;
  } catch (error) {
    trace(session.tmid, 'warning', `Bot 发送失败，已由宿主代发：${error instanceof Error ? error.message : String(error)}`);
  }
  await useChat.getState().send(text, { rid: session.rid, tmid: replyTmid(session) });
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
function nameCodexThread(appServer: AppServerClient, session: AgentSession): void {
  if (!session.codexThreadId) return;
  const chat = useChat.getState();
  const room = chat.subscriptions[session.rid] ?? chat.rooms[session.rid];
  const detail = session.workItem
    ? `#${session.workItem.id} ${session.workItem.title}`
    : room?.fname || room?.name || session.environmentName;
  void appServer
    .request('thread/name/set', {
      threadId: session.codexThreadId,
      name: rocketxThreadName('托管', detail),
    })
    .catch(() => undefined);
}

function sessionForThread(threadId: string): AgentSession | undefined {
  return Object.values(useSharedAgent.getState().sessions).find(
    (session) => session.codexThreadId === threadId,
  );
}

function recordParams(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function onServerRequest(request: {
  method: string;
  params: unknown;
  policy: ServerRequestPolicy | 'unknown';
}): Promise<unknown> {
  const params = recordParams(request.params);
  const threadId = typeof params.threadId === 'string' ? params.threadId : '';
  const session = sessionForThread(threadId);
  if (!session) throw new Error('请求不属于活跃的 RocketX Agent 会话');
  if (request.policy === 'unknown') throw new Error('未知服务端请求已被安全拒绝');
  if (request.policy === 'safe-reject' || request.policy === 'dynamic-tool') {
    throw new Error('该服务端请求在 RocketX 共享会话中默认禁用');
  }
  const actionable = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ]);
  if (!actionable.has(request.method)) throw new Error('该请求类型尚无安全的共享审批表单');
  const approvalId = id('approval');
  const trackedFileChanges =
    request.method === 'item/fileChange/requestApproval' && typeof params.itemId === 'string'
      ? fileChangePaths.get(params.itemId)?.paths
      : undefined;
  const fileChanges = trackedFileChanges?.length
    ? Object.fromEntries(trackedFileChanges.map((path) => [path, true]))
    : undefined;
  if (
    request.method === 'item/fileChange/requestApproval' &&
    !fileChanges &&
    typeof params.grantRoot !== 'string'
  ) {
    throw new Error('文件变更请求缺少可供宿主核验的路径');
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
  trace(session.tmid, 'tool', `等待宿主审批：${request.method}`);
  return new Promise((resolve, reject) =>
    approvalWaiters.set(approvalId, { tmid: session.tmid, resolve, reject }),
  );
}

function onNotification(method: string, paramsValue: unknown): void {
  if (method === 'externalAgentConfig/import/completed') {
    dispatchCodexImportCompleted(paramsValue);
    return;
  }
  const params = recordParams(paramsValue);
  const threadId = typeof params.threadId === 'string' ? params.threadId : '';
  const session = sessionForThread(threadId);
  if (!session) return;
  if (method === 'item/agentMessage/delta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : '';
    const delta = typeof params.delta === 'string' ? params.delta : '';
    turnBuffers.set(turnId, `${turnBuffers.get(turnId) ?? ''}${delta}`);
  } else if (method === 'turn/started') {
    const turn = recordParams(params.turn);
    const turnId = typeof turn.id === 'string' ? turn.id : undefined;
    updateSession({ ...session, status: 'running', activeTurnId: turnId, updatedAt: Date.now() });
    trace(session.tmid, 'status', 'Codex 正在处理指令');
  } else if (method === 'turn/completed') {
    const turn = recordParams(params.turn);
    const turnId = typeof turn.id === 'string' ? turn.id : '';
    void completeTurn(session, turnId, typeof turn.status === 'string' ? turn.status : 'completed');
  } else if (method === 'item/started' || method === 'item/completed') {
    const item = recordParams(params.item);
    const type = typeof item.type === 'string' ? item.type : 'tool';
    if (type === 'fileChange' && typeof item.id === 'string') {
      if (method === 'item/started' && Array.isArray(item.changes)) {
        fileChangePaths.set(item.id, {
          threadId,
          paths: item.changes
            .map((change) => recordParams(change).path)
            .filter((path): path is string => typeof path === 'string'),
        });
      } else {
        fileChangePaths.delete(item.id);
      }
    }
    trace(session.tmid, 'tool', `${method === 'item/started' ? '开始' : '完成'}：${type}`);
  } else if (method === 'warning' || method === 'error') {
    trace(session.tmid, method === 'error' ? 'error' : 'warning', JSON.stringify(params).slice(0, 1_000));
  }
}

async function completeTurn(session: AgentSession, turnId: string, status: string): Promise<void> {
  const text = turnBuffers.get(turnId)?.trim() ?? '';
  turnBuffers.delete(turnId);
  try {
    if (text) {
      const output = redactAgentOutput(text);
      const prefix = output.redacted > 0 ? `🤖 Codex（已脱敏 ${output.redacted} 处）\n` : '🤖 Codex\n';
      await sendAgentReply(session, `${prefix}${output.text}`);
    } else if (status !== 'completed') {
      await sendAgentReply(session, `🤖 Codex 本轮未完成（${status}）`);
    }
    const current = useSharedAgent.getState().sessions[session.tmid] ?? session;
    if (current.status !== 'ended') {
      updateSession({ ...current, status: 'ready', activeTurnId: undefined, updatedAt: Date.now() });
    }
    trace(session.tmid, 'status', `本轮结束：${status}`);
    turnWaiters.get(turnId)?.resolve();
  } catch (error) {
    turnWaiters.get(turnId)?.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    turnWaiters.delete(turnId);
  }
}

function onInterrupted(tmid: string, error: Error): void {
  clients.delete(tmid);
  clientStarts.delete(tmid);
  const session = useSharedAgent.getState().sessions[tmid];
  if (session && session.status !== 'ended') {
    const interrupted = interruptSession(session);
    updateSession(interrupted);
    void updateLeaseCard(interrupted).catch(() => undefined);
    trace(tmid, 'error', error.message);
  }
  for (const [itemId, tracked] of fileChangePaths) {
    if (tracked.threadId === session?.codexThreadId) fileChangePaths.delete(itemId);
  }
  for (const [turnId, waiter] of turnWaiters) {
    if (waiter.tmid !== tmid) continue;
    waiter.reject(error);
    turnWaiters.delete(turnId);
  }
  for (const [approvalId, waiter] of approvalWaiters) {
    if (waiter.tmid !== tmid) continue;
    waiter.reject(error);
    approvalWaiters.delete(approvalId);
  }
  useSharedAgent.setState((state) => ({
    approvals: state.approvals.filter((approval) => approval.tmid !== tmid),
  }));
}

async function ensureClient(session: AgentSession): Promise<AppServerClient> {
  if (!isTauri) throw new Error('共享 Agent 仅支持 RocketX 桌面端');
  const current = clients.get(session.tmid);
  if (current) return current;
  const pending = clientStarts.get(session.tmid);
  if (pending) return pending;
  const start = (async () => {
    const next = new AppServerClient(
      new TauriCodexTransport(session.sessionId, session.workspaceRoots[0]),
      {
        onNotification,
        onServerRequest,
        onInterrupted: (error) => onInterrupted(session.tmid, error),
      },
    );
    await next.start();
    clients.set(session.tmid, next);
    return next;
  })();
  clientStarts.set(session.tmid, start);
  try {
    return await start;
  } finally {
    clientStarts.delete(session.tmid);
  }
}

async function stopClient(tmid: string): Promise<void> {
  const pending = clientStarts.get(tmid);
  let current = clients.get(tmid);
  clients.delete(tmid);
  clientStarts.delete(tmid);
  if (!current && pending) current = await pending.catch(() => undefined);
  clients.delete(tmid);
  if (current) await current.stop();
}

async function loadContextMessages(session: AgentSession, command: RcMessage): Promise<RcMessage[]> {
  const cached = useChat.getState().messages[command.rid] ?? [];
  if (!replyTmid(session)) {
    const messages = new Map(cached.map((message) => [message._id, message]));
    const type = useChat.getState().subscriptions[command.rid]?.t ?? useChat.getState().rooms[command.rid]?.t ?? 'p';
    try {
      for (const message of await rest.getHistory(command.rid, type, 100)) messages.set(message._id, message);
    } catch (error) {
      trace(session.tmid, 'warning', `讨论上下文加载不完整：${error instanceof Error ? error.message : String(error)}`);
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
        `话题上下文加载不完整：${error instanceof Error ? error.message : String(error)}`,
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

async function executeCommand(session: AgentSession, message: RcMessage): Promise<void> {
  const current = useSharedAgent.getState().sessions[session.tmid] ?? session;
  const appServer = await ensureClient(current);
  const codexSettings = getButlerCodexSettings();
  const messages = await loadContextMessages(current, message);
  const selectedMessages = replyTmid(current)
    ? selectAgentContextMessages(message, messages)
    : messages.filter((item) => item.rid === message.rid).slice(-200);
  const attachments = await materializeAgentAttachments(current.sessionId, selectedMessages);
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
  updateSession({ ...current, status: 'running', updatedAt: Date.now() });
  const response = await appServer.request('turn/start', {
    ...(codexSettings.model ? { model: codexSettings.model } : {}),
    ...(codexSettings.effort === 'default' ? {} : { effort: codexSettings.effort }),
    threadId: current.codexThreadId!,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: 'user',
    cwd: current.workspaceRoots[0],
    runtimeWorkspaceRoots: [...current.workspaceRoots, ...attachments.roots],
    sandboxPolicy: sandboxPolicy(current.sandboxMode, current.workspaceRoots),
  });
  const turnId = response.turn.id;
  updateSession({ ...current, status: 'running', activeTurnId: turnId, updatedAt: Date.now() });
  await new Promise<void>((resolve, reject) =>
    turnWaiters.set(turnId, { tmid: current.tmid, resolve, reject }),
  );
}

async function queueCommand(session: AgentSession, message: RcMessage): Promise<void> {
  const queue = queues.get(session.tmid) ?? new SerialCommandQueue();
  queues.set(session.tmid, queue);
  await queue.enqueue(async () => {
    try {
      await executeCommand(useSharedAgent.getState().sessions[session.tmid] ?? session, message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      trace(session.tmid, 'error', detail);
      const current = useSharedAgent.getState().sessions[session.tmid] ?? session;
      updateSession({ ...current, status: 'ready', activeTurnId: undefined, updatedAt: Date.now() });
      await sendAgentReply(session, `🤖 Codex 执行失败：${redactAgentOutput(detail).text}`);
    }
  });
}

export const useSharedAgent = create<SharedAgentState>((set, get) => ({
  sessions: {},
  remoteCards: {},
  traces: {},
  approvals: [],
  memberRequests: [],
  error: null,

  ingestCard: (message) => {
    const card = parseAgentSessionCard(message.msg);
    if (!card || message.u._id !== card.hostUserId || !agentSessionCardMatchesMessage(card, message)) return;
    if (card.hostDeviceId === agentDeviceId()) return;
    set((state) => ({ remoteCards: { ...state.remoteCards, [card.tmid]: card } }));
  },

  restore: async () => {
    const user = useAuth.getState().user;
    if (!user) return;
    const serverId = getServerBase() || 'same-origin';
    const scope = `${serverId}:${user._id}`;
    if (restoredScope === scope) return;
    restoredScope = scope;
    const stored = await listAgentSessions(serverId, user._id);
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
    const pending = startingSessions.get(tmid);
    if (pending) return pending;
    const existing = get().sessions[tmid];
    if (existing && existing.status !== 'ended') return existing;
    const remote = get().remoteCards[tmid];
    if (remote?.status === 'active' && remote.leaseExpiresAt > Date.now()) {
      throw new Error(`该话题由 @${remote.hostUsername} 的另一台设备托管，请等待租约超时`);
    }
    const start = (async () => {
      set({ error: null });
      const host = actor();
      const now = Date.now();
      const sessionId = id('session');
      const root =
        options.workspaceRoot ||
        useLocalCodex.getState().workspaceRoot ||
        (await invoke<string>('codex_agent_workspace', { sessionId }));
      assertAllowedWorkspacePath(root, [root]);
      let session: AgentSession = {
        sessionId,
        serverId: getServerBase() || 'same-origin',
        ownerUserId: host.userId,
        rid,
        tmid,
        replyTmid: options.replyTmid,
        host: { ...host, heartbeatAt: now, expiresAt: now + LEASE_MS },
        access: 'room-members',
        approvedMemberIds: [],
        status: 'starting',
        workspaceRoots: [root],
        environmentId: options.environmentId,
        environmentName: options.environmentName,
        workItem: options.workItem,
        proposedBranch: options.proposedBranch,
        baseBranch: options.baseBranch,
        sandboxMode: 'read-only',
        updatedAt: now,
      };
      updateSession(session);
      const appServer = await ensureClient(session);
      const codexSettings = getButlerCodexSettings();
      const response = await appServer.request('thread/start', {
        ...(codexSettings.model ? { model: codexSettings.model } : {}),
        cwd: root,
        runtimeWorkspaceRoots: [root],
        approvalPolicy: APPROVAL_POLICY,
        approvalsReviewer: 'user',
        sandbox: session.sandboxMode,
        ephemeral: false,
        developerInstructions: buildAgentDeveloperInstructions(options),
      });
      session = {
        ...session,
        codexThreadId: response.thread.id,
        status: 'ready',
        updatedAt: Date.now(),
      };
      updateSession(session);
      nameCodexThread(appServer, session);
      trace(tmid, 'status', `Agent 会话已启动，Codex ${response.thread.cliVersion}`);
      const leaseMessage = await rest.sendMessage(rid, renderAgentSessionCard(cardFor(session)), replyTmid(session));
      session = { ...session, leaseMessageId: leaseMessage._id, updatedAt: Date.now() };
      updateSession(session);
      return session;
    })();
    startingSessions.set(tmid, start);
    try {
      return await start;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      await stopClient(tmid).catch(() => undefined);
      const failed = get().sessions[tmid];
      if (failed && failed.status !== 'ended') {
        updateSession(
          failed.codexThreadId
            ? interruptSession(failed)
            : { ...failed, status: 'ended', updatedAt: Date.now() },
        );
      }
      throw error;
    } finally {
      startingSessions.delete(tmid);
    }
  },

  handleMessage: async (message) => {
    get().ingestCard(message);
    const sessionKey = message.tmid ?? agentRoomSessionKey(message.rid);
    const allowLiteralAi = !message.tmid && !!get().sessions[sessionKey];
    if (message.pending || message.failed || agentMessageInstruction(message, 'ai', allowLiteralAi) === null) return;
    if (processedMessages.has(message._id)) return;
    processedMessages.add(message._id);
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
        if (!start) throw new Error('Agent 启动未完成，请重试');
        session = await start;
      }
      if (session.status === 'interrupted') {
        if (message.u._id !== me._id) return;
        await get().resumeSession(session.tmid);
        session = get().sessions[session.tmid];
      }
      const access = commandAccess(session, message.u._id);
      if (access === 'denied') {
        if (message.u._id !== me._id) {
          await useChat.getState().send(`🤖 @${message.u.username}，当前 Agent 会话仅宿主可指挥。`, {
            rid: message.rid,
            tmid: message.tmid,
          });
        }
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
        trace(session.tmid, 'status', `等待宿主放行 @${message.u.username}`);
        return;
      }
      await queueCommand(session, message);
    } catch (error) {
      processedMessages.delete(message._id);
      const detail = error instanceof Error ? error.message : String(error);
      set({ error: detail });
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
      await useChat.getState().send(`🤖 @${request.command.username}，宿主未放行本次指令。`, {
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

  resolveApproval: async (approvalId, approved) => {
    const approval = get().approvals.find((item) => item.id === approvalId);
    if (!approval) return;
    const session = get().sessions[approval.tmid];
    if (!session) return;
    assertHost(session, actor());
    const params = recordParams(approval.params);
    let safeApproval = approved;
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
      trace(session.tmid, 'warning', '命令涉及敏感路径，已强制拒绝');
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
    const decision =
      approval.method === 'item/permissions/requestApproval'
        ? { permissions: safeApproval ? permissions : {}, scope: 'turn', strictAutoReview: true }
        : approval.method.startsWith('item/')
          ? { decision: safeApproval ? 'accept' : 'decline' }
          : { decision: safeApproval ? 'approved' : 'denied' };
    approvalWaiters.get(approvalId)?.resolve(decision);
    approvalWaiters.delete(approvalId);
    set((state) => ({ approvals: state.approvals.filter((item) => item.id !== approvalId) }));
    updateSession({ ...session, status: 'running', updatedAt: Date.now() });
    trace(session.tmid, 'status', safeApproval ? '宿主已允许请求' : '宿主已拒绝请求');
  },

  setSandboxMode: async (tmid, mode) => {
    const session = get().sessions[tmid];
    if (!session) return;
    assertHost(session, actor());
    updateSession({ ...session, sandboxMode: mode, updatedAt: Date.now() });
    trace(tmid, 'warning', mode === 'workspace-write' ? '宿主已启用工作区写入模式' : '已恢复只读模式');
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
    trace(tmid, 'status', access === 'host-only' ? 'Agent 已切换为仅宿主可指挥' : 'Agent 已允许房间成员申请指挥');
  },

  resumeSession: async (tmid) => {
    const existing = get().sessions[tmid];
    if (!existing) return;
    const host = actor();
    const now = Date.now();
    const leased = takeHostLease(existing, host, now, LEASE_MS);
    const resuming = enterResumeState(leased, host, now);
    updateSession(resuming);
    const appServer = await ensureClient(resuming);
    const { model } = getButlerCodexSettings();
    const response = await appServer.request('thread/resume', {
      ...(model ? { model } : {}),
      threadId: resuming.codexThreadId!,
      cwd: resuming.workspaceRoots[0],
      runtimeWorkspaceRoots: resuming.workspaceRoots,
      approvalPolicy: APPROVAL_POLICY,
      approvalsReviewer: 'user',
      sandbox: resuming.sandboxMode,
      excludeTurns: true,
    });
    const resumed: AgentSession = {
      ...resuming,
      codexThreadId: response.thread.id,
      status: 'ready',
      updatedAt: Date.now(),
    };
    updateSession(resumed);
    nameCodexThread(appServer, resumed); // 旧线程也补上名字
    trace(tmid, 'status', '已恢复 Codex 会话');
    await updateLeaseCard(get().sessions[tmid]);
  },

  transferToCodexApp: async (tmid) => {
    const session = get().sessions[tmid];
    if (!session || session.status === 'ended') throw new Error('托管会话未在运行');
    const messages = await sessionConversationMessages(session);
    const lines = agentConversationLines(
      messages
        .filter((message) => !message.pending && !message.failed && !parseAgentSessionCard(message.msg))
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
    const chat = useChat.getState();
    const room = chat.subscriptions[session.rid] ?? chat.rooms[session.rid];
    const detail = session.workItem
      ? `#${session.workItem.id} ${session.workItem.title}`
      : room?.fname || room?.name || session.environmentName;
    const client = await ensureClient(session);
    // 文件名必须是会话 UUID 且落在 Claude Code 标准会话根下,否则导入器判 session_missing(issue #99)
    const sessionUuid = crypto.randomUUID();
    const jsonl = claudeSessionJsonl(lines, {
      sessionId: sessionUuid,
      cwd: session.workspaceRoots[0],
      now: Date.now(),
    });
    const path = await writeCodexTransferSession(sessionUuid, jsonl);
    try {
      await importSessionFileToCodex(client, {
        path,
        cwd: session.workspaceRoots[0],
        title: rocketxThreadName('托管对话', detail),
      });
    } finally {
      void cleanupCodexTransferSession(sessionUuid);
    }
    trace(tmid, 'status', '对话已转移到 Codex，可在 App / CLI 会话列表继续');
  },

  endSession: async (tmid) => {
    const session = get().sessions[tmid];
    if (!session) return;
    assertHost(session, actor());
    const appServer = clients.get(tmid);
    if (session.activeTurnId && appServer) {
      await appServer
        .request('turn/interrupt', {
          threadId: session.codexThreadId!,
          turnId: session.activeTurnId,
        })
        .catch(() => undefined);
    }
    await stopClient(tmid).catch(() => undefined);
    const ended = { ...session, status: 'ended' as const, activeTurnId: undefined, updatedAt: Date.now() };
    updateSession(ended);
    trace(tmid, 'status', 'Agent 会话已结束');
    await updateLeaseCard(ended).catch(() => undefined);
    if (!replyTmid(session)) useAgentEnvironments.getState().endBinding(session.rid);
    await useChat.getState().send('🤖 Codex 共享会话已结束。', { rid: session.rid, tmid: replyTmid(session) });
  },
}));

export function startSharedAgentBridge(): () => void {
  void useSharedAgent.getState().restore();
  const unsubscribeAuth = useAuth.subscribe((state, previous) => {
    if (state.user?._id !== previous.user?._id) void useSharedAgent.getState().restore();
  });
  const unsubscribeChat = useChat.subscribe((state, previous) => {
    for (const [rid, messages] of Object.entries(state.messages)) {
      const before = previous.messages[rid] ?? [];
      if (messages === before) continue;
      const previousById = new Map(before.map((message) => [message._id, message]));
      for (const message of messages) {
        const prior = previousById.get(message._id);
        if (!prior || prior.msg !== message.msg || (prior.pending && !message.pending)) {
          void useSharedAgent.getState().handleMessage(message);
        }
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
  return () => {
    unsubscribeAuth();
    unsubscribeChat();
    clearInterval(heartbeat);
  };
}
