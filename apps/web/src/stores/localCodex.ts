import { create } from 'zustand';
import { AppServerClient, TauriCodexTransport, type ServerRequestPolicy } from '../agent/protocol';
import {
  commandRequestMentionsSensitivePath,
  redactAgentOutput,
  validateApprovalPaths,
  validatePermissionRequest,
} from '../agent/safety';
import { isTauri } from '../lib/http';

const RUNNER_WORKSPACE = '/workspace';
const STORAGE_PREFIX = 'rcx-local-codex-v1';
const TRACE_LIMIT = 200;
const MESSAGE_LIMIT = 100;
const APPROVAL_POLICY = {
  granular: {
    sandbox_approval: true,
    rules: false,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: false,
  },
} as const;

export type LocalCodexStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'running'
  | 'waiting-approval'
  | 'interrupted';

export interface LocalCodexMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface LocalCodexTrace {
  id: string;
  kind: 'status' | 'tool' | 'warning' | 'error';
  text: string;
  at: number;
}

export interface LocalCodexApproval {
  id: string;
  method: string;
  policy: ServerRequestPolicy;
  params: unknown;
}

interface PersistedLocalCodex {
  workspaceRoot?: string;
  sessionId?: string;
  threadId?: string;
  sandboxMode?: 'read-only' | 'workspace-write';
}

interface LocalCodexState {
  scope: string;
  workspaceRoot: string;
  sessionId?: string;
  threadId?: string;
  activeTurnId?: string;
  sandboxMode: 'read-only' | 'workspace-write';
  status: LocalCodexStatus;
  messages: LocalCodexMessage[];
  traces: LocalCodexTrace[];
  approvals: LocalCodexApproval[];
  error: string | null;
  hydrate: (scope: string) => void;
  setWorkspaceRoot: (path: string) => void;
  setSandboxMode: (mode: 'read-only' | 'workspace-write') => void;
  startNew: () => Promise<void>;
  resume: () => Promise<void>;
  send: (text: string) => Promise<void>;
  resolveApproval: (id: string, approved: boolean) => void;
  stop: () => Promise<void>;
}

let client: AppServerClient | undefined;
let clientStart: Promise<AppServerClient> | undefined;
const turnBuffers = new Map<string, string>();
const fileChangePaths = new Map<string, string[]>();
const approvalWaiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeText(value: unknown): string {
  return redactAgentOutput(value instanceof Error ? value.message : String(value)).text;
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}:${scope}`;
}

function persist(state: LocalCodexState): void {
  if (!state.scope) return;
  const value: PersistedLocalCodex = {
    workspaceRoot: state.workspaceRoot || undefined,
    sessionId: state.sessionId,
    threadId: state.threadId,
    sandboxMode: state.sandboxMode,
  };
  try {
    localStorage.setItem(storageKey(state.scope), JSON.stringify(value));
  } catch {
    /* 本地存储已满时保留当前会话，不影响正在运行的 Codex 进程。 */
  }
}

function permissionProfile(mode: LocalCodexState['sandboxMode']): string {
  return mode === 'workspace-write' ? 'rocketx_write' : 'rocketx_read';
}

function trace(kind: LocalCodexTrace['kind'], text: string): void {
  useLocalCodex.setState((state) => ({
    traces: [...state.traces, { id: id('trace'), kind, text, at: Date.now() }].slice(-TRACE_LIMIT),
  }));
}

function appendMessage(role: LocalCodexMessage['role'], text: string): void {
  useLocalCodex.setState((state) => ({
    messages: [...state.messages, { id: id('message'), role, text, at: Date.now() }].slice(-MESSAGE_LIMIT),
  }));
}

function rejectWaiters(error: Error): void {
  for (const waiter of approvalWaiters.values()) waiter.reject(error);
  approvalWaiters.clear();
}

function onInterrupted(error: Error): void {
  const message = safeText(error);
  client = undefined;
  clientStart = undefined;
  rejectWaiters(new Error(message));
  useLocalCodex.setState({ status: 'interrupted', activeTurnId: undefined, approvals: [], error: message });
  trace('error', message);
}

async function onServerRequest(request: {
  method: string;
  params: unknown;
  policy: ServerRequestPolicy | 'unknown';
}): Promise<unknown> {
  const state = useLocalCodex.getState();
  const params = record(request.params);
  if (typeof params.threadId === 'string' && params.threadId !== state.threadId) {
    throw new Error('请求不属于当前 Codex 会话');
  }
  if (request.policy === 'unknown') throw new Error('未知服务端请求已被安全拒绝');
  if (request.policy === 'safe-reject' || request.policy === 'dynamic-tool' || request.policy === 'host-input') {
    throw new Error('该请求类型在 RocketX Codex 入口中默认禁用');
  }
  const actionable = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ]);
  if (!actionable.has(request.method)) throw new Error('该请求类型没有安全的审批表单');
  const tracked = typeof params.itemId === 'string' ? fileChangePaths.get(params.itemId) : undefined;
  const approvalParams = tracked?.length
    ? { ...params, fileChanges: Object.fromEntries(tracked.map((path) => [path, true])) }
    : request.params;
  if (request.method === 'item/fileChange/requestApproval' && !tracked?.length && typeof params.grantRoot !== 'string') {
    throw new Error('文件变更请求缺少可核验路径');
  }
  const approval: LocalCodexApproval = {
    id: id('approval'),
    method: request.method,
    policy: request.policy,
    params: approvalParams,
  };
  useLocalCodex.setState((current) => ({
    approvals: [...current.approvals, approval],
    status: 'waiting-approval',
  }));
  trace('tool', `等待审批：${request.method}`);
  return new Promise((resolve, reject) => approvalWaiters.set(approval.id, { resolve, reject }));
}

function onNotification(method: string, value: unknown): void {
  const params = record(value);
  const state = useLocalCodex.getState();
  if (typeof params.threadId === 'string' && params.threadId !== state.threadId) return;
  if (method === 'item/agentMessage/delta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : '';
    const delta = typeof params.delta === 'string' ? params.delta : '';
    turnBuffers.set(turnId, `${turnBuffers.get(turnId) ?? ''}${delta}`);
    return;
  }
  if (method === 'turn/started') {
    const turn = record(params.turn);
    useLocalCodex.setState({
      status: 'running',
      activeTurnId: typeof turn.id === 'string' ? turn.id : undefined,
    });
    trace('status', 'Codex 正在处理指令');
    return;
  }
  if (method === 'turn/completed') {
    const turn = record(params.turn);
    const turnId = typeof turn.id === 'string' ? turn.id : '';
    const status = typeof turn.status === 'string' ? turn.status : 'completed';
    const output = redactAgentOutput(turnBuffers.get(turnId)?.trim() ?? '');
    turnBuffers.delete(turnId);
    if (output.text) appendMessage('assistant', output.redacted ? `${output.text}\n\n（已脱敏 ${output.redacted} 处）` : output.text);
    else if (status !== 'completed') appendMessage('assistant', `本轮未完成（${status}）`);
    useLocalCodex.setState({ status: 'ready', activeTurnId: undefined, error: null });
    trace('status', `本轮结束：${status}`);
    return;
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = record(params.item);
    const type = typeof item.type === 'string' ? item.type : 'tool';
    if (type === 'fileChange' && typeof item.id === 'string') {
      if (method === 'item/started' && Array.isArray(item.changes)) {
        fileChangePaths.set(
          item.id,
          item.changes.map((change) => record(change).path).filter((path): path is string => typeof path === 'string'),
        );
      } else {
        fileChangePaths.delete(item.id);
      }
    }
    trace('tool', `${method === 'item/started' ? '开始' : '完成'}：${type}`);
    return;
  }
  if (method === 'warning' || method === 'error') {
    trace(method === 'error' ? 'error' : 'warning', safeText(JSON.stringify(params).slice(0, 1_000)));
  }
}

async function ensureClient(): Promise<AppServerClient> {
  if (!isTauri) throw new Error('Codex 本地工作区仅支持 RocketX 桌面端');
  if (client) return client;
  if (clientStart) return clientStart;
  const state = useLocalCodex.getState();
  if (!state.workspaceRoot) throw new Error('请先选择 Codex 本地工作目录');
  if (!state.sessionId) throw new Error('Codex 会话尚未创建');
  const pending = (async () => {
    const next = new AppServerClient(
      new TauriCodexTransport(state.sessionId!, state.workspaceRoot),
      { onNotification, onServerRequest, onInterrupted },
    );
    await next.start();
    client = next;
    return next;
  })();
  clientStart = pending;
  try {
    return await pending;
  } finally {
    clientStart = undefined;
  }
}

async function stopClient(): Promise<void> {
  const pending = clientStart;
  let current = client;
  client = undefined;
  clientStart = undefined;
  if (!current && pending) current = await pending.catch(() => undefined);
  if (current) await current.stop().catch(() => undefined);
}

export const useLocalCodex = create<LocalCodexState>((set, get) => ({
  scope: '',
  workspaceRoot: '',
  sandboxMode: 'read-only',
  status: 'idle',
  messages: [],
  traces: [],
  approvals: [],
  error: null,

  hydrate: (scope) => {
    if (!scope || get().scope === scope) return;
    if (get().scope) {
      void stopClient();
      rejectWaiters(new Error('账号已切换，原 Codex 会话已停止'));
    }
    let saved: PersistedLocalCodex = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey(scope)) ?? '{}') as PersistedLocalCodex;
    } catch {
      saved = {};
    }
    set({
      scope,
      workspaceRoot: saved.workspaceRoot ?? '',
      sessionId: saved.sessionId,
      threadId: saved.threadId,
      sandboxMode: saved.sandboxMode === 'workspace-write' ? 'workspace-write' : 'read-only',
      messages: [],
      status: 'idle',
      traces: [],
      approvals: [],
      error: null,
    });
  },

  setWorkspaceRoot: (workspaceRoot) => {
    const current = get();
    const changed = current.workspaceRoot !== workspaceRoot;
    const next = {
      ...current,
      workspaceRoot,
      ...(changed ? { sessionId: undefined, threadId: undefined, messages: [] } : {}),
    };
    set({
      workspaceRoot,
      ...(changed ? { sessionId: undefined, threadId: undefined, messages: [] } : {}),
    });
    persist(next);
  },

  setSandboxMode: (sandboxMode) => {
    const next = { ...get(), sandboxMode };
    set({ sandboxMode });
    persist(next);
    trace('warning', sandboxMode === 'workspace-write' ? '已启用工作区写入模式' : '已恢复只读模式');
  },

  startNew: async () => {
    if (!get().workspaceRoot) throw new Error('请先选择 Codex 本地工作目录');
    await stopClient();
    const sessionId = id('local');
    set({ sessionId, threadId: undefined, activeTurnId: undefined, status: 'starting', messages: [], traces: [], approvals: [], error: null });
    persist(get());
    try {
      const appServer = await ensureClient();
      const state = get();
      const response = await appServer.request('thread/start', {
        cwd: RUNNER_WORKSPACE,
        runtimeWorkspaceRoots: [RUNNER_WORKSPACE],
        approvalPolicy: APPROVAL_POLICY,
        approvalsReviewer: 'user',
        permissions: permissionProfile(state.sandboxMode),
      });
      set({ threadId: response.thread.id, status: 'ready', error: null });
      persist(get());
      trace('status', `已启动 Codex ${response.thread.cliVersion}`);
    } catch (error) {
      await stopClient();
      set({ status: 'idle', error: safeText(error) });
      throw error;
    }
  },

  resume: async () => {
    const state = get();
    if (!state.threadId || !state.sessionId) throw new Error('没有可恢复的 Codex 会话');
    set({ status: 'starting', error: null });
    try {
      const appServer = await ensureClient();
      const response = await appServer.request('thread/resume', {
        threadId: state.threadId,
        cwd: RUNNER_WORKSPACE,
        runtimeWorkspaceRoots: [RUNNER_WORKSPACE],
        approvalPolicy: APPROVAL_POLICY,
        approvalsReviewer: 'user',
        permissions: permissionProfile(state.sandboxMode),
        excludeTurns: true,
      });
      set({ threadId: response.thread.id, status: 'ready', error: null });
      persist(get());
      trace('status', '已恢复 Codex 会话');
    } catch (error) {
      await stopClient();
      set({ status: 'interrupted', error: safeText(error) });
      throw error;
    }
  },

  send: async (text) => {
    const input = text.trim();
    const state = get();
    if (!input) return;
    if (state.status !== 'ready' || !state.threadId) throw new Error('Codex 会话尚未就绪');
    appendMessage('user', input);
    set({ status: 'running', error: null });
    try {
      const appServer = await ensureClient();
      const response = await appServer.request('turn/start', {
        threadId: state.threadId,
        input: [{ type: 'text', text: input, text_elements: [] }],
        cwd: RUNNER_WORKSPACE,
        runtimeWorkspaceRoots: [RUNNER_WORKSPACE],
        approvalPolicy: APPROVAL_POLICY,
        approvalsReviewer: 'user',
        permissions: permissionProfile(get().sandboxMode),
      });
      set({ activeTurnId: response.turn.id, status: 'running' });
    } catch (error) {
      set({ status: 'ready', error: safeText(error) });
      throw error;
    }
  },

  resolveApproval: (approvalId, approved) => {
    const approval = get().approvals.find((item) => item.id === approvalId);
    const waiter = approvalWaiters.get(approvalId);
    if (!approval || !waiter) return;
    const params = record(approval.params);
    let accepted = approved;
    let permissions = {};
    if (accepted) {
      try {
        validateApprovalPaths(params, [RUNNER_WORKSPACE]);
        if (commandRequestMentionsSensitivePath(params.command)) throw new Error('命令涉及敏感路径');
        const requested = params.permissions ?? params.additionalPermissions;
        if (requested) {
          permissions = validatePermissionRequest(
            requested as Parameters<typeof validatePermissionRequest>[0],
            [RUNNER_WORKSPACE],
          );
        }
      } catch (error) {
        accepted = false;
        trace('warning', error instanceof Error ? error.message : String(error));
      }
    }
    const decision =
      approval.method === 'item/permissions/requestApproval'
        ? { permissions: accepted ? permissions : {}, scope: 'turn', strictAutoReview: true }
        : approval.method.startsWith('item/')
          ? { decision: accepted ? 'accept' : 'decline' }
          : { decision: accepted ? 'approved' : 'denied' };
    approvalWaiters.delete(approvalId);
    set((current) => ({
      approvals: current.approvals.filter((item) => item.id !== approvalId),
      status: current.approvals.length === 1 ? 'running' : current.status,
    }));
    waiter.resolve(decision);
    trace('status', accepted ? '已允许请求' : '已拒绝请求');
  },

  stop: async () => {
    const state = get();
    if (state.activeTurnId && state.threadId && client) {
      await client.request('turn/interrupt', { threadId: state.threadId, turnId: state.activeTurnId }).catch(() => undefined);
    }
    await stopClient();
    rejectWaiters(new Error('Codex 会话已停止'));
    set({ status: 'idle', activeTurnId: undefined, approvals: [], error: null });
    trace('status', 'Codex 进程已停止，可稍后恢复会话');
  },
}));
