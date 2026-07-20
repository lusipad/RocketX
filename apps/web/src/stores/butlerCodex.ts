import {
  AppServerClient,
  TauriCodexTransport,
  type CodexTransport,
  type ServerRequestPolicy,
} from '../agent/protocol';
import type { JsonValue } from '../agent/protocol/generated/serde_json/JsonValue';
import {
  openCodexNewThread,
  transferTranscript,
  type CodexHandoffResult,
  type TransferLine,
} from '../agent/codexTransfer';
import { rocketxThreadName } from '../agent/threadName';
import type { AgentLoopEvent, ButlerTool } from '../kernel/ai/agent-loop';
import {
  codexBrainAvailability,
  getButlerCodexSettings,
  setCodexBrainUnavailableReason,
} from '../lib/butlerBrain';
import { butlerCurrentTimeLine, buildButlerSystemPrompt } from '../lib/butlerProfile';
import { butlerContextPrompt, type ButlerSurfaceContext } from '../lib/butlerContext';
import { createButlerTools } from '../lib/butlerTools';

export interface ButlerCodexRoomContext {
  rid: string;
  roomName: string;
}

export interface ButlerCodexAskOptions {
  text: string;
  context?: ButlerSurfaceContext | ButlerCodexRoomContext;
  now?: number;
  onEvent?: (event: AgentLoopEvent) => void;
}

interface TurnController {
  onNotification(method: string, params: unknown): void;
  interrupt(error: Error): void;
  /** 用户主动停止：就地完成本轮，保留已生成的内容 */
  stop(): void;
  activeTurnId(): string | undefined;
  start(client: AppServerClient, input: string): Promise<string>;
}

interface ActiveTurn {
  turnId?: string;
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

type ButlerCodexTransportFactory = (sessionId: string, workspaceRoot: string) => CodexTransport;
type ButlerCodexWorkspaceResolver = () => Promise<string>;

let transportFactory: ButlerCodexTransportFactory = (sessionId, workspaceRoot) =>
  new TauriCodexTransport(sessionId, workspaceRoot);
let workspaceResolver: ButlerCodexWorkspaceResolver = async () => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('butler_home_dir');
};

let residentClient: AppServerClient | undefined;
let residentClientStart: Promise<AppServerClient> | undefined;
let residentSessionId: string | undefined;
let residentWorkspaceRoot: string | undefined;
let residentThreadId: string | undefined;
let residentPromptHash: string | undefined;
let residentStatus: 'idle' | 'ready' | 'running' | 'interrupted' = 'idle';
let residentTools = new Map<string, ButlerTool>();
let residentTurn: TurnController | undefined;
let residentEvent: ((event: AgentLoopEvent) => void) | undefined;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16);
}

function instructions(now: number): string {
  return `${buildButlerSystemPrompt()}\n\n${butlerCurrentTimeLine(now)}`;
}

function dynamicTools(tools: readonly ButlerTool[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as unknown as JsonValue,
  }));
}

function codexTrace(text: string): void {
  console.warn(`[Butler Codex] ${text}`);
}

function unavailableReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/Codex CLI 不可用|找不到 PATH 中 Codex|ENOENT|not recognized as an internal/i.test(message)) {
    return 'Codex 大脑不可用：未检测到 Codex CLI，请先安装并登录。';
  }
  if (/未登录|login|auth/i.test(message)) return 'Codex 大脑不可用：请先登录 Codex。';
  return undefined;
}

export function friendlyButlerCodexError(error: unknown): string {
  const availability = codexBrainAvailability();
  if (!availability.available) return availability.reason ?? 'Codex 大脑暂不可用';
  const reason = unavailableReason(error);
  if (reason) return reason;
  return 'Codex 大脑暂时无法回答，请稍后重试。';
}

function roomPrefixedInput(text: string, context?: ButlerSurfaceContext | ButlerCodexRoomContext): string {
  if (!context) return text;
  if (!('kind' in context)) {
    return `（用户当前所在房间：${context.roomName}，查本房间消息优先用 search_messages 的 roomName 参数）\n\n${text}`;
  }
  return `（${butlerContextPrompt(context)}）\n\n${text}`;
}

function createTurnController(threadId: string, onEvent?: (event: AgentLoopEvent) => void): TurnController {
  let active: ActiveTurn | undefined;

  return {
    onNotification: (method, value) => {
      const params = record(value);
      if (params.threadId !== threadId) return;
      if (method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (!active || !delta) return;
        active.text += delta;
        onEvent?.({ type: 'content', content: delta });
        return;
      }
      if (method !== 'turn/completed' || !active) return;
      const turn = record(params.turn);
      const completedTurnId = typeof turn.id === 'string' ? turn.id : typeof params.turnId === 'string' ? params.turnId : undefined;
      if (active.turnId && completedTurnId && active.turnId !== completedTurnId) return;
      const current = active;
      active = undefined;
      current.resolve(current.text.trim());
    },

    interrupt: (error) => {
      if (!active) return;
      const current = active;
      active = undefined;
      current.reject(error);
    },

    stop: () => {
      if (!active) return;
      const current = active;
      active = undefined;
      current.resolve(current.text.trim());
    },

    activeTurnId: () => active?.turnId,

    start: async (client, input) => {
      if (active) throw new Error('AI 正在处理上一条消息');
      let resolveCompletion!: (text: string) => void;
      let rejectCompletion!: (error: Error) => void;
      const completed = new Promise<string>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const current: ActiveTurn = { text: '', resolve: resolveCompletion, reject: rejectCompletion };
      active = current;
      try {
        const { effort } = getButlerCodexSettings();
        const response = await client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: input, text_elements: [] }],
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          ...(effort === 'default' ? {} : { effort }),
        });
        current.turnId = response.turn.id;
        return await completed;
      } catch (error) {
        if (active === current) {
          active = undefined;
          current.reject(error instanceof Error ? error : new Error(String(error)));
        }
        throw error;
      }
    },
  };
}

async function respondDynamicToolCall(
  request: { method: string; params: unknown; policy: ServerRequestPolicy | 'unknown' },
  expectedThreadId: string | undefined,
  tools: ReadonlyMap<string, ButlerTool>,
  onEvent?: (event: AgentLoopEvent) => void,
): Promise<unknown> {
  if (request.policy !== 'dynamic-tool' || request.method !== 'item/tool/call') {
    if (request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval' ||
      request.method === 'item/permissions/requestApproval' ||
      request.method === 'execCommandApproval' ||
      request.method === 'applyPatchApproval') {
      codexTrace('AI 无执行权限');
      throw new Error('AI 无执行权限');
    }
    throw new Error('AI 已拒绝非工具请求');
  }
  const params = record(request.params);
  if (!expectedThreadId || params.threadId !== expectedThreadId) throw new Error('动态工具请求不属于当前 AI 会话');
  const name = typeof params.tool === 'string' ? params.tool : '';
  const tool = tools.get(name);
  if (!tool) throw new Error(`未注册的 AI 工具：${name || '未知'}`);
  // 无参工具允许缺省 arguments；出现时必须是对象。
  if (params.arguments != null && (Array.isArray(params.arguments) || typeof params.arguments !== 'object')) {
    throw new Error('AI 工具参数必须是对象');
  }
  const args = record(params.arguments);
  const callId = typeof params.callId === 'string' ? params.callId : crypto.randomUUID();
  onEvent?.({ type: 'tool-call', toolCall: { id: callId, name, arguments: JSON.stringify(args) } });
  try {
    const result = await tool.execute(args);
    onEvent?.({ type: 'tool-result', toolCallId: callId, content: result });
    // 工具已返回 JSON 字符串，直接透传，避免二次编码。
    return {
      contentItems: [{ type: 'inputText', text: result }],
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onEvent?.({ type: 'tool-result', toolCallId: callId, content: `工具调用失败：${message}` });
    throw error;
  }
}

function onResidentInterrupted(error: Error): void {
  residentClient = undefined;
  residentClientStart = undefined;
  residentStatus = 'interrupted';
  residentTurn?.interrupt(error);
  codexTrace(`AI Codex 会话已中断：${error.message}`);
}

async function ensureResidentClient(): Promise<AppServerClient> {
  if (residentClient) return residentClient;
  if (residentClientStart) return residentClientStart;
  const pending = (async () => {
    residentSessionId ??= `butler-${crypto.randomUUID()}`;
    residentWorkspaceRoot ??= await workspaceResolver();
    const next = new AppServerClient(
      transportFactory(residentSessionId, residentWorkspaceRoot),
      {
        onNotification: (method, params) => {
          residentTurn?.onNotification(method, params);
        },
        onServerRequest: (request) => respondDynamicToolCall(
          request,
          residentThreadId,
          residentTools,
          residentEvent,
        ),
        onInterrupted: onResidentInterrupted,
      },
    );
    await next.start();
    residentClient = next;
    return next;
  })();
  residentClientStart = pending;
  try {
    return await pending;
  } finally {
    residentClientStart = undefined;
  }
}

async function stopResident(clearThread = true): Promise<void> {
  const pending = residentClientStart;
  let client = residentClient;
  residentClient = undefined;
  residentClientStart = undefined;
  if (!client && pending) client = await pending.catch(() => undefined);
  if (client) await client.stop().catch(() => undefined);
  residentTurn = undefined;
  residentEvent = undefined;
  residentStatus = 'idle';
  if (clearThread) {
    residentThreadId = undefined;
    residentPromptHash = undefined;
    residentTools = new Map();
  }
}

async function startResidentThread(now: number, prompt: string, promptHash: string): Promise<void> {
  const client = await ensureResidentClient();
  const { model } = getButlerCodexSettings();
  const tools = createButlerTools();
  residentTools = new Map(tools.map((tool) => [tool.name, tool]));
  const response = await client.request('thread/start', {
    ...(model ? { model } : {}),
    cwd: residentWorkspaceRoot!,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    baseInstructions: `${prompt}\n\n${butlerCurrentTimeLine(now)}`,
    dynamicTools: dynamicTools(tools),
  });
  residentThreadId = response.thread.id;
  residentPromptHash = promptHash;
  residentStatus = 'ready';
  // 常驻线程也是原生 Codex 线程，起名后在 codex resume / Codex App 里可辨认
  void client
    .request('thread/name/set', { threadId: response.thread.id, name: rocketxThreadName('AI 大脑') })
    .catch(() => undefined);
}

async function resumeResidentThread(now: number, prompt: string, promptHash: string): Promise<void> {
  const client = await ensureResidentClient();
  const { model } = getButlerCodexSettings();
  const tools = createButlerTools();
  residentTools = new Map(tools.map((tool) => [tool.name, tool]));
  const response = await client.request('thread/resume', {
    ...(model ? { model } : {}),
    threadId: residentThreadId!,
    cwd: residentWorkspaceRoot!,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    baseInstructions: `${prompt}\n\n${butlerCurrentTimeLine(now)}`,
    excludeTurns: true,
  });
  residentThreadId = response.thread.id;
  residentPromptHash = promptHash;
  residentStatus = 'ready';
}

/**
 * 重启后接续上一次的常驻线程：标记为 interrupted，下次提问会走既有的
 * thread/resume 路径把上下文从 Codex 会话库里恢复回来；resume 失败时
 * 原有兜底会自动开新线程。本次运行已有活线程时不覆盖。
 */
export function hydrateResidentCodexThread(threadId: string, promptHash: string): void {
  if (residentThreadId || !threadId || !promptHash) return;
  residentThreadId = threadId;
  residentPromptHash = promptHash;
  residentStatus = 'interrupted';
}

/** 当前常驻线程快照，供对话持久化一并保存 */
export function residentCodexThreadSnapshot(): { threadId: string; promptHash: string } | undefined {
  return residentThreadId && residentPromptHash
    ? { threadId: residentThreadId, promptHash: residentPromptHash }
    : undefined;
}

async function ensureResidentThread(now: number): Promise<void> {
  const prompt = buildButlerSystemPrompt();
  const settings = getButlerCodexSettings();
  const promptHash = hash(`${prompt}\n\0${settings.model}\n\0${settings.effort}`);
  if (residentThreadId && residentPromptHash !== promptHash) await stopResident();
  if (!residentThreadId) {
    await startResidentThread(now, prompt, promptHash);
    return;
  }
  if (residentStatus !== 'interrupted') return;
  try {
    await resumeResidentThread(now, prompt, promptHash);
  } catch {
    await stopResident();
    await startResidentThread(now, prompt, promptHash);
  }
}

export async function askButlerCodex(options: ButlerCodexAskOptions): Promise<{ text: string }> {
  const availability = codexBrainAvailability();
  if (!availability.available) throw new Error(availability.reason ?? 'Codex 大脑暂不可用');
  const text = options.text.trim();
  if (!text) return { text: '' };
  try {
    await ensureResidentThread(options.now ?? Date.now());
    const threadId = residentThreadId;
    if (!threadId) throw new Error('AI Codex 会话尚未创建');
    const controller = createTurnController(threadId, options.onEvent);
    residentTurn = controller;
    residentEvent = options.onEvent;
    residentStatus = 'running';
    const result = await controller.start(await ensureResidentClient(), roomPrefixedInput(text, options.context));
    residentStatus = 'ready';
    residentTurn = undefined;
    residentEvent = undefined;
    return { text: result };
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason) setCodexBrainUnavailableReason(reason);
    residentTurn = undefined;
    residentEvent = undefined;
    if (residentStatus !== 'interrupted') residentStatus = residentThreadId ? 'ready' : 'idle';
    throw error;
  }
}

/** 新对话：停掉并丢弃常驻线程，下次提问从全新线程（全新上下文）开始 */
export async function discardResidentCodexThread(): Promise<void> {
  await stopResident(true);
}

/**
 * 用官方 deep link 在 Codex App 打开新对话，把完整记录预填到输入框。
 * App 自己创建并拥有线程，避免独立 app-server 生成“列表可见但不可续”的
 * 孤儿线程(issue #105)。快照副本语义不变:RocketX 里的对话继续在原线程上。
 */
export async function transferConversationToCodexApp(
  lines: readonly TransferLine[],
): Promise<CodexHandoffResult> {
  const workspaceRoot = residentWorkspaceRoot ?? await workspaceResolver();
  return openCodexNewThread(transferTranscript('管家对话', lines), workspaceRoot);
}

/**
 * 停止管家当前正在进行的回答：先请求服务端中断本轮，再就地完成
 * 本轮 Promise（保留已生成的部分内容）。没有进行中的轮次时是 no-op。
 */
export async function stopButlerCodexTurn(): Promise<void> {
  const turn = residentTurn;
  if (!turn) return;
  const turnId = turn.activeTurnId();
  if (residentClient && residentThreadId && turnId) {
    await residentClient
      .request('turn/interrupt', { threadId: residentThreadId, turnId })
      .catch(() => undefined);
  }
  turn.stop();
}

export async function runButlerCodexEphemeral(options: ButlerCodexAskOptions): Promise<{ text: string }> {
  const availability = codexBrainAvailability();
  if (!availability.available) throw new Error(availability.reason ?? 'Codex 大脑暂不可用');
  const tools = createButlerTools();
  const registeredTools = new Map(tools.map((tool) => [tool.name, tool]));
  const sessionId = `butler-routine-${crypto.randomUUID()}`;
  const workspaceRoot = await workspaceResolver();
  let threadId: string | undefined;
  let controller: TurnController | undefined;
  const client = new AppServerClient(transportFactory(sessionId, workspaceRoot), {
    onNotification: (method, params) => controller?.onNotification(method, params),
    onServerRequest: (request) => respondDynamicToolCall(request, threadId, registeredTools, options.onEvent),
    onInterrupted: (error) => controller?.interrupt(error),
  });
  try {
    await client.start();
    const now = options.now ?? Date.now();
    const { model } = getButlerCodexSettings();
    const response = await client.request('thread/start', {
      ...(model ? { model } : {}),
      cwd: workspaceRoot,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      ephemeral: true,
      baseInstructions: instructions(now),
      dynamicTools: dynamicTools(tools),
    });
    threadId = response.thread.id;
    controller = createTurnController(threadId, options.onEvent);
    return { text: await controller.start(client, options.text.trim()) };
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason) setCodexBrainUnavailableReason(reason);
    throw error;
  } finally {
    await client.stop().catch(() => undefined);
  }
}

export function setButlerCodexTransportFactory(factory: ButlerCodexTransportFactory): () => void {
  const previous = transportFactory;
  transportFactory = factory;
  return () => {
    transportFactory = previous;
  };
}

export function setButlerCodexWorkspaceResolver(resolver: ButlerCodexWorkspaceResolver): () => void {
  const previous = workspaceResolver;
  workspaceResolver = resolver;
  return () => {
    workspaceResolver = previous;
  };
}

export async function resetButlerCodexRuntime(): Promise<void> {
  await stopResident();
  residentSessionId = undefined;
  residentWorkspaceRoot = undefined;
}
