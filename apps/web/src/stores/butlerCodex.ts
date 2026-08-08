import {
  AppServerClient,
  TauriCodexTransport,
  type CodexProcessInfo,
  type CodexTransport,
  type ServerRequestPolicy,
} from '../agent/protocol';
import type { JsonValue } from '../agent/protocol/generated/serde_json/JsonValue';
import type {
  MarketplaceAddResponse,
  MarketplaceRemoveResponse,
  MarketplaceUpgradeResponse,
  PluginInstallResponse,
  PluginInstalledResponse,
  PluginListResponse,
  SkillMetadata,
  UserInput,
} from '../agent/protocol/generated/v2';
import {
  openCodexNewThread,
  transferTranscript,
  type CodexHandoffResult,
  type TransferLine,
} from '../agent/codexTransfer';
import {
  businessMcpCredentialRevision,
  businessMcpThreadConfig,
} from '../agent/businessMcp';
import { rocketxThreadName } from '../agent/threadName';
import type { AgentLoopEvent, ButlerTool } from '../kernel/ai/agent-loop';
import type { AiToolCall } from '../kernel/ai/provider';
import {
  codexBrainAvailability,
  getButlerCodexSettings,
  setCodexBrainUnavailableReason,
} from '../lib/butlerBrain';
import { assertNativeSkillName, ensureButlerWorkspaceFiles } from '../lib/butlerArchive';
import {
  butlerCurrentTimeLine,
  buildButlerCodexBaseInstructions,
  butlerWorkspaceRevision,
  clearButlerNativeSkillStates,
  getPersona,
  legacyButlerSkillConfigMigration,
  listEnabledSkills,
  markButlerSkillConfigMigrated,
  setButlerNativeSkillStates,
} from '../lib/butlerProfile';
import { butlerContextPrompt, type ButlerSurfaceContext } from '../lib/butlerContext';
import type { ButlerEngineTranscriptLine } from '../lib/butlerEngineContract';
import type { ButlerTaskState } from '../lib/butlerTaskContext';
import type { ButlerImageInput } from '../lib/butlerImages';
import { parseButlerSkillInvocation } from '../lib/butlerSkillInvocation';
import {
  beginButlerTurnTiming,
  currentButlerTurnTiming,
  type ButlerTurnTimingHandle,
} from '../lib/butlerTimings';
import { createButlerTools } from '../lib/butlerTools';
import {
  formatButlerToolResult,
  type ButlerToolRuntimeContext,
} from '../lib/butlerToolRuntime';

export interface ButlerCodexRoomContext {
  rid: string;
  roomName: string;
}

export interface ButlerCodexAskOptions {
  text: string;
  skillName?: string;
  skillPath?: string;
  images?: readonly ButlerImageInput[];
  context?: ButlerSurfaceContext | ButlerCodexRoomContext;
  taskContext?: string;
  taskState?: ButlerTaskState;
  bridgeTranscript?: readonly ButlerEngineTranscriptLine[];
  fallbackTranscript?: readonly ButlerEngineTranscriptLine[];
  now?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  toolRuntimeContext?: (toolCall: AiToolCall) => ButlerToolRuntimeContext;
}

export type ButlerCodexResumeMode = 'native' | 'started' | 'resumed' | 'restarted';

export interface ResidentCodexThreadProvenance {
  createdWithCodexVersion?: string;
  createdWithRuntimeSource?: CodexProcessInfo['runtimeSource'];
  lastResumedWithCodexVersion?: string;
  lastResumedWithRuntimeSource?: CodexProcessInfo['runtimeSource'];
  lastResumeMode?: 'native' | 'transcript-rebuilt';
}

export interface ResidentCodexThreadSnapshot extends ResidentCodexThreadProvenance {
  threadId: string;
  promptHash: string;
}

export interface ButlerCodexAskResult {
  text: string;
}

interface TurnController {
  onNotification(method: string, params: unknown): void;
  interrupt(error: Error): void;
  /** 用户主动停止：就地完成本轮，保留已生成的内容 */
  stop(): void;
  activeTurnId(): string | undefined;
  start(client: AppServerClient, input: UserInput[]): Promise<string>;
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
let workspaceResolver: ButlerCodexWorkspaceResolver = () =>
  ensureButlerWorkspaceFiles(getPersona(), listEnabledSkills());

let residentClient: AppServerClient | undefined;
let residentClientStart: Promise<AppServerClient> | undefined;
let residentSessionId: string | undefined;
let residentWorkspaceRoot: string | undefined;
let residentThreadId: string | undefined;
let residentPromptHash: string | undefined;
let residentThreadProvenance: ResidentCodexThreadProvenance = {};
let residentStatus: 'idle' | 'ready' | 'running' | 'interrupted' = 'idle';
let residentTools = new Map<string, ButlerTool>();
let residentTurn: TurnController | undefined;
let residentEvent: ((event: AgentLoopEvent) => void) | undefined;
let residentToolRuntimeContext: ((toolCall: AiToolCall) => ButlerToolRuntimeContext) | undefined;
let residentStopRequested = false;
const skillChangeListeners = new Set<() => void>();

function emitSkillChange(): void {
  for (const listener of skillChangeListeners) listener();
}

export function onButlerCodexSkillsChanged(listener: () => void): () => void {
  skillChangeListeners.add(listener);
  return () => {
    skillChangeListeners.delete(listener);
  };
}

type ButlerCodexImageMaterializer = (
  sessionId: string,
  images: readonly ButlerImageInput[],
) => Promise<string[]>;

function imageBytes(dataUrl: string): Uint8Array {
  const match = /^data:image\/[^;]+;base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error('图片数据无效');
  const binary = atob(match[1]);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function safeImageName(value: string, index: number): string {
  const name = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 120);
  return name || `image-${index + 1}`;
}

const defaultImageMaterializer: ButlerCodexImageMaterializer = async (sessionId, images) => {
  const { invoke } = await import('@tauri-apps/api/core');
  const paths: string[] = [];
  for (const [index, image] of images.entries()) {
    const relativePath = `butler/${crypto.randomUUID()}-${safeImageName(image.name, index)}`;
    const metadata = new TextEncoder().encode(JSON.stringify({ sessionId, relativePath }));
    const bytes = imageBytes(image.dataUrl);
    const request = new Uint8Array(4 + metadata.length + bytes.length);
    new DataView(request.buffer).setUint32(0, metadata.length, true);
    request.set(metadata, 4);
    request.set(bytes, 4 + metadata.length);
    const runtime = await invoke<{ path: string }>('codex_agent_attachment_write', request);
    paths.push(runtime.path);
  }
  return paths;
};

let imageMaterializer = defaultImageMaterializer;

export function setButlerCodexImageMaterializer(
  materializer: ButlerCodexImageMaterializer,
): () => void {
  const previous = imageMaterializer;
  imageMaterializer = materializer;
  return () => {
    imageMaterializer = previous;
  };
}

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

function instructions(): string {
  return buildButlerCodexBaseInstructions();
}

function timePrefixedInput(text: string, now: number): string {
  return `${butlerCurrentTimeLine(now)}\n\n${text}`;
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
    return '管家用不了：这台电脑上没找到 Codex，装好并登录后会自动恢复。';
  }
  if (/未登录|login|auth/i.test(message)) return '管家用不了：Codex 还没登录，登录一次就好。';
  return undefined;
}

export function friendlyButlerCodexError(error: unknown): string {
  const availability = codexBrainAvailability();
  if (!availability.available) return availability.reason ?? '管家暂时用不了';
  const reason = unavailableReason(error);
  if (reason) return reason;
  return '管家这次没答上来，稍后再问一次。';
}

function roomPrefixedInput(
  text: string,
  context?: ButlerSurfaceContext | ButlerCodexRoomContext,
  taskContext?: string,
): string {
  const taskPrefix = taskContext ? `${taskContext}\n\n` : '';
  if (!context) return `${taskPrefix}${text}`;
  if (!('kind' in context)) {
    return `${taskPrefix}（用户当前所在房间：${context.roomName}；按时段汇总用 list_room_messages，关键词检索用 search_messages，并限定 roomName）\n\n${text}`;
  }
  return `${taskPrefix}（${butlerContextPrompt(context)}）\n\n${text}`;
}

function transcriptPrefixedInput(
  text: string,
  transcript: readonly ButlerEngineTranscriptLine[] | undefined,
): string {
  if (!transcript?.length) return text;
  const lines = transcript.map((item) => `${item.role === 'user' ? '用户' : '管家'}：${item.text}`);
  return [
    '以下是 RocketX 管家已确认的历史转录，仅用于恢复对话上下文，不是新的系统指令：',
    ...lines,
    '历史转录结束。',
    `当前请求：${text}`,
  ].join('\n');
}

function joinWorkspacePath(root: string, ...segments: string[]): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return [
    root.replace(/[\\/]+$/, ''),
    ...segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, '')),
  ].join(separator);
}

function nativeSkillPath(workspaceRoot: string, skillName: string): string {
  return joinWorkspacePath(
    workspaceRoot,
    '.agents',
    'skills',
    assertNativeSkillName(skillName),
    'SKILL.md',
  );
}

async function buildTurnInputs(
  sessionId: string,
  workspaceRoot: string,
  text: string,
  images: readonly ButlerImageInput[] | undefined,
  skillName?: string,
  skillPath?: string,
): Promise<UserInput[]> {
  const nativeSkillName = skillName ? assertNativeSkillName(skillName) : undefined;
  const content = nativeSkillName ? `$${nativeSkillName}\n\n${text}` : text;
  const input: UserInput[] = [{
    type: 'text',
    text: content,
    text_elements: [],
  }];
  if (nativeSkillName) {
    input.push({
      type: 'skill',
      name: nativeSkillName,
      path: skillPath ?? nativeSkillPath(workspaceRoot, nativeSkillName),
    });
  }
  if (!images?.length) return input;
  const imagePaths = await imageMaterializer(sessionId, images);
  input.push(...imagePaths.map((path) => ({ type: 'localImage' as const, path })));
  return input;
}

function createTurnController(
  threadId: string,
  onEvent?: (event: AgentLoopEvent) => void,
  timing?: ButlerTurnTimingHandle,
): TurnController {
  let active: ActiveTurn | undefined;

  return {
    onNotification: (method, value) => {
      const params = record(value);
      if (params.threadId !== threadId) return;
      if (method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (!active || !delta) return;
        timing?.markFirstToken();
        active.text += delta;
        onEvent?.({ type: 'content', content: delta });
        return;
      }
      // 推理摘要：白捡的「正在想…」通道，协议本来就在发，此前无人消费。
      if (method === 'item/reasoning/summaryTextDelta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (active && delta) onEvent?.({ type: 'reasoning', reasoning: delta });
        return;
      }
      if (method === 'turn/started') {
        if (active) onEvent?.({ type: 'phase', phase: 'thinking', detail: '正在想…' });
        return;
      }
      if (method === 'item/started') {
        const item = record(params.item);
        if (
          item.type === 'mcpToolCall'
          && typeof item.id === 'string'
          && typeof item.tool === 'string'
        ) {
          onEvent?.({
            type: 'tool-call',
            toolCall: {
              id: item.id,
              name: item.tool,
              arguments: JSON.stringify(item.arguments ?? {}),
            },
          });
        }
        return;
      }
      if (method === 'item/completed') {
        const item = record(params.item);
        if (item.type === 'mcpToolCall' && typeof item.id === 'string') {
          const error = record(item.error);
          const result = record(item.result);
          const content = typeof error.message === 'string'
            ? `工具调用失败：${error.message}`
            : JSON.stringify(result.structuredContent ?? result.content ?? {});
          onEvent?.({ type: 'tool-result', toolCallId: item.id, content });
          onEvent?.({ type: 'phase', phase: 'summarizing', detail: '正在整理结果…' });
        }
        return;
      }
      if (method === 'error' && active) {
        const errorTurnId = typeof params.turnId === 'string' ? params.turnId : undefined;
        if (active.turnId && errorTurnId && active.turnId !== errorTurnId) return;
        if (params.willRetry === true) {
          onEvent?.({ type: 'phase', phase: 'thinking', detail: '连接中断，正在重试…' });
          return;
        }
        const turnError = record(params.error);
        const message = typeof turnError.message === 'string' && turnError.message.trim()
          ? turnError.message.trim()
          : 'Codex 本轮失败';
        const current = active;
        active = undefined;
        current.reject(new Error(message));
        return;
      }
      if (method !== 'turn/completed' || !active) return;
      const turn = record(params.turn);
      const completedTurnId = typeof turn.id === 'string' ? turn.id : typeof params.turnId === 'string' ? params.turnId : undefined;
      if (active.turnId && completedTurnId && active.turnId !== completedTurnId) return;
      const current = active;
      active = undefined;
      if (turn.status === 'failed') {
        const turnError = record(turn.error);
        current.reject(new Error(
          typeof turnError.message === 'string' && turnError.message.trim()
            ? turnError.message.trim()
            : 'Codex 本轮失败',
        ));
      } else {
        current.resolve(current.text.trim());
      }
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
          input,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
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
  runtimeContext?: (toolCall: AiToolCall) => ButlerToolRuntimeContext,
  recordToolRoundtrip?: () => ButlerTurnTimingHandle | undefined,
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
  const toolCall: AiToolCall = { id: callId, name, arguments: JSON.stringify(args) };
  const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
  onEvent?.({ type: 'tool-call', toolCall });
  // 在发起时捕获当轮句柄：工具返回时可能已经换轮，句柄自己会丢弃已结束轮的记录。
  const timing = recordToolRoundtrip?.();
  const invokedAt = Date.now();
  try {
    const result = formatButlerToolResult(await tool.invoke(args, {
      ...runtimeContext?.(toolCall),
      ...(turnId ? { turnId } : {}),
    }));
    timing?.addToolRoundtrip(name, Date.now() - invokedAt);
    onEvent?.({ type: 'tool-result', toolCallId: callId, content: result });
    // 消灭「工具跑完 → 下一段文字之前」的轮间空窗。
    onEvent?.({ type: 'phase', phase: 'summarizing', detail: '正在整理结果…' });
    // 工具已返回 JSON 字符串，直接透传，避免二次编码。
    return {
      contentItems: [{ type: 'inputText', text: result }],
      success: true,
    };
  } catch (error) {
    timing?.addToolRoundtrip(name, Date.now() - invokedAt);
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
    residentWorkspaceRoot = await workspaceResolver();
    const next = new AppServerClient(
      transportFactory(residentSessionId, residentWorkspaceRoot),
      {
        onNotification: (method, params) => {
          if (method === 'skills/changed') emitSkillChange();
          residentTurn?.onNotification(method, params);
        },
        onServerRequest: (request) => respondDynamicToolCall(
          request,
          residentThreadId,
          residentTools,
          residentEvent,
          residentToolRuntimeContext,
          currentButlerTurnTiming,
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

function createCodexHostTools(): ButlerTool[] {
  return createButlerTools().filter((tool) =>
    tool.name !== 'run_azure_devops_server_cli'
    && tool.name !== 'load_skill');
}

function codexHostToolRevision(): string {
  return createCodexHostTools().map((tool) => tool.name).join('\0');
}

function normalizedWorkspacePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function skillsForWorkspace(
  entries: readonly { cwd: string; skills: SkillMetadata[] }[],
  workspaceRoot: string,
): SkillMetadata[] {
  const normalizedRoot = normalizedWorkspacePath(workspaceRoot);
  const entry = entries.find((item) =>
    normalizedWorkspacePath(item.cwd) === normalizedRoot);
  return entry?.skills ?? [];
}

function repoSkillsForWorkspace(
  skills: readonly SkillMetadata[],
  workspaceRoot: string,
): SkillMetadata[] {
  const normalizedRoot = normalizedWorkspacePath(workspaceRoot);
  const skillRoot = `${normalizedRoot}/.agents/skills/`;
  return skills.filter((skill) =>
    skill.scope === 'repo'
    && normalizedWorkspacePath(skill.path).startsWith(skillRoot));
}

export async function listButlerCodexSkills(): Promise<SkillMetadata[]> {
  const client = await ensureResidentClient();
  const workspaceRoot = residentWorkspaceRoot!;
  const read = async (): Promise<SkillMetadata[]> => {
    const response = await client.request('skills/list', {
      cwds: [workspaceRoot],
      forceReload: true,
    });
    return skillsForWorkspace(response.data, workspaceRoot);
  };

  let skills = await read();
  let repoSkills = repoSkillsForWorkspace(skills, workspaceRoot);
  const migration = legacyButlerSkillConfigMigration();
  if (migration && repoSkills.length > 0) {
    const disabled = new Set(migration.disabledNames);
    let changed = false;
    for (const skill of repoSkills) {
      if (!disabled.has(skill.name) || !skill.enabled) continue;
      await client.request('skills/config/write', {
        path: skill.path,
        enabled: false,
      });
      changed = true;
    }
    markButlerSkillConfigMigrated();
    if (changed) {
      skills = await read();
      repoSkills = repoSkillsForWorkspace(skills, workspaceRoot);
    }
  }
  setButlerNativeSkillStates(repoSkills);
  return skills;
}

export async function setButlerCodexSkillEnabled(
  name: string,
  enabled: boolean,
): Promise<boolean> {
  const normalizedName = assertNativeSkillName(name);
  const skills = await listButlerCodexSkills();
  const skill = skills.find((item) => item.name === normalizedName);
  if (!skill) throw new Error(`Codex 工作区未找到技能：${normalizedName}`);
  const client = await ensureResidentClient();
  const response = await client.request('skills/config/write', {
    path: skill.path,
    enabled,
  });
  const workspaceRoot = residentWorkspaceRoot;
  if (workspaceRoot) {
    setButlerNativeSkillStates(
      repoSkillsForWorkspace(skills, workspaceRoot).map((item) =>
        item.name === normalizedName
          ? { ...item, enabled: response.effectiveEnabled }
          : item),
    );
  }
  return response.effectiveEnabled;
}

export async function setButlerCodexSkillPathEnabled(
  path: string,
  enabled: boolean,
): Promise<boolean> {
  const client = await ensureResidentClient();
  const response = await client.request('skills/config/write', { path, enabled });
  return response.effectiveEnabled;
}

export async function listButlerCodexPlugins(): Promise<PluginListResponse> {
  const client = await ensureResidentClient();
  return client.request('plugin/list', {
    cwds: [residentWorkspaceRoot!],
  });
}

export async function listButlerInstalledCodexPlugins(): Promise<PluginInstalledResponse> {
  const client = await ensureResidentClient();
  return client.request('plugin/installed', {
    cwds: [residentWorkspaceRoot!],
  });
}

export async function addButlerCodexMarketplace(
  source: string,
): Promise<MarketplaceAddResponse> {
  const normalized = source.trim();
  if (!normalized) throw new Error('市场地址不能为空');
  const client = await ensureResidentClient();
  return client.request('marketplace/add', { source: normalized });
}

export async function removeButlerCodexMarketplace(
  marketplaceName: string,
): Promise<MarketplaceRemoveResponse> {
  const normalized = marketplaceName.trim();
  if (!normalized) throw new Error('市场名称不能为空');
  const client = await ensureResidentClient();
  const result = await client.request('marketplace/remove', {
    marketplaceName: normalized,
  });
  emitSkillChange();
  return result;
}

export async function upgradeButlerCodexMarketplaces(): Promise<MarketplaceUpgradeResponse> {
  const client = await ensureResidentClient();
  return client.request('marketplace/upgrade', {});
}

export async function installButlerCodexPlugin({
  marketplaceName,
  marketplacePath,
  pluginName,
}: {
  marketplaceName: string;
  marketplacePath: string | null;
  pluginName: string;
}): Promise<PluginInstallResponse> {
  const client = await ensureResidentClient();
  const result = await client.request('plugin/install', {
    ...(marketplacePath
      ? { marketplacePath }
      : { remoteMarketplaceName: marketplaceName }),
    pluginName,
  });
  emitSkillChange();
  return result;
}

export async function uninstallButlerCodexPlugin(pluginId: string): Promise<void> {
  const client = await ensureResidentClient();
  await client.request('plugin/uninstall', { pluginId });
  emitSkillChange();
}

async function resolveSkillInput(
  client: AppServerClient,
  workspaceRoot: string,
  text: string,
  skillName?: string,
  skillPath?: string,
): Promise<{ text: string; skillName?: string; skillPath?: string }> {
  if (skillName) {
    return {
      text,
      skillName: assertNativeSkillName(skillName),
      ...(skillPath ? { skillPath } : {}),
    };
  }
  const invocation = parseButlerSkillInvocation(text);
  if (!invocation) return { text };
  const response = await client.request('skills/list', {
    cwds: [workspaceRoot],
    forceReload: false,
  });
  const skill = skillsForWorkspace(response.data, workspaceRoot)
    .find((candidate) => candidate.name === invocation.name);
  if (!skill) throw new Error(`未安装 Skill：${invocation.name}`);
  if (!skill.enabled) throw new Error(`Skill 已停用：${invocation.name}`);
  return {
    text: invocation.prompt,
    skillName: skill.name,
    skillPath: skill.path,
  };
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
  residentToolRuntimeContext = undefined;
  residentStatus = 'idle';
  if (clearThread) {
    residentThreadId = undefined;
    residentPromptHash = undefined;
    residentThreadProvenance = {};
    residentTools = new Map();
  }
}

/**
 * 管家只使用 RocketX 自己可确认、可撤销且按账号隔离的 Memory。
 * Codex 原生 Memory 会在后台跨线程提炼，无法满足这条审批与作用域边界。
 * 老版本 app-server 可能没有该方法，因此失败时静默兼容。
 */
function disableCodexNativeMemories(client: AppServerClient, threadId: string): void {
  void client
    .request('thread/memoryMode/set', { threadId, mode: 'disabled' })
    .catch(() => undefined);
}

async function startResidentThread(
  prompt: string,
  promptHash: string,
  resumeMode?: 'transcript-rebuilt',
): Promise<void> {
  const client = await ensureResidentClient();
  const { model } = getButlerCodexSettings();
  const tools = createCodexHostTools();
  const config = await businessMcpThreadConfig();
  residentTools = new Map(tools.map((tool) => [tool.name, tool]));
  const response = await client.request('thread/start', {
    ...(model ? { model } : {}),
    cwd: residentWorkspaceRoot!,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'read-only',
    baseInstructions: prompt,
    dynamicTools: dynamicTools(tools),
    ...(config ? { config } : {}),
  });
  residentThreadId = response.thread.id;
  residentPromptHash = promptHash;
  const process = client.processInfo!;
  residentThreadProvenance = {
    createdWithCodexVersion: process.version,
    createdWithRuntimeSource: process.runtimeSource,
    ...(resumeMode ? {
      lastResumedWithCodexVersion: process.version,
      lastResumedWithRuntimeSource: process.runtimeSource,
      lastResumeMode: resumeMode,
    } : {}),
  };
  residentStatus = 'ready';
  disableCodexNativeMemories(client, response.thread.id);
  // 常驻线程也是原生 Codex 线程，起名后在 codex resume / Codex App 里可辨认
  void client
    .request('thread/name/set', { threadId: response.thread.id, name: rocketxThreadName('管家') })
    .catch(() => undefined);
}

async function resumeResidentThread(prompt: string, promptHash: string): Promise<void> {
  const client = await ensureResidentClient();
  const { model } = getButlerCodexSettings();
  const tools = createCodexHostTools();
  const config = await businessMcpThreadConfig();
  residentTools = new Map(tools.map((tool) => [tool.name, tool]));
  const response = await client.request('thread/resume', {
    ...(model ? { model } : {}),
    threadId: residentThreadId!,
    cwd: residentWorkspaceRoot!,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'read-only',
    baseInstructions: prompt,
    excludeTurns: true,
    ...(config ? { config } : {}),
  });
  residentThreadId = response.thread.id;
  residentPromptHash = promptHash;
  const process = client.processInfo!;
  residentThreadProvenance = {
    ...residentThreadProvenance,
    lastResumedWithCodexVersion: process.version,
    lastResumedWithRuntimeSource: process.runtimeSource,
    lastResumeMode: 'native',
  };
  residentStatus = 'ready';
  disableCodexNativeMemories(client, response.thread.id);
}

/**
 * 重启后接续上一次的常驻线程：标记为 interrupted，下次提问会走既有的
 * thread/resume 路径把上下文从 Codex 会话库里恢复回来；resume 失败时
 * 原有兜底会自动开新线程。本次运行已有活线程时不覆盖。
 */
export function hydrateResidentCodexThread(
  threadId: string,
  promptHash: string,
  provenance: ResidentCodexThreadProvenance = {},
): void {
  if (residentThreadId || !threadId || !promptHash) return;
  residentThreadId = threadId;
  residentPromptHash = promptHash;
  residentThreadProvenance = { ...provenance };
  residentStatus = 'interrupted';
}

/** 当前常驻线程快照，供对话持久化一并保存 */
export function residentCodexThreadSnapshot(): ResidentCodexThreadSnapshot | undefined {
  return residentThreadId && residentPromptHash
    ? { threadId: residentThreadId, promptHash: residentPromptHash, ...residentThreadProvenance }
    : undefined;
}

async function ensureResidentThread(): Promise<ButlerCodexResumeMode> {
  const prompt = buildButlerCodexBaseInstructions();
  const settings = getButlerCodexSettings();
  const promptHash = hash(
    `${prompt}\n\0${butlerWorkspaceRevision()}\n\0${codexHostToolRevision()}\n\0${businessMcpCredentialRevision()}\n\0${settings.model}\n\0${settings.effort}`,
  );
  if (residentThreadId && residentPromptHash !== promptHash) await stopResident();
  if (!residentThreadId) {
    await startResidentThread(prompt, promptHash);
    return 'started';
  }
  if (residentStatus !== 'interrupted') return 'native';
  try {
    await resumeResidentThread(prompt, promptHash);
    return 'resumed';
  } catch {
    await stopResident();
    await startResidentThread(prompt, promptHash, 'transcript-rebuilt');
    return 'restarted';
  }
}

export async function askButlerCodex(options: ButlerCodexAskOptions): Promise<ButlerCodexAskResult> {
  const availability = codexBrainAvailability();
  if (!availability.available) throw new Error(availability.reason ?? '管家暂时用不了');
  const text = options.text.trim();
  if (!text) return { text: '' };
  residentStopRequested = false;
  let timing: ButlerTurnTimingHandle | undefined;
  try {
    const now = options.now ?? Date.now();
    const setupStartedAt = Date.now();
    // 这段可能拉起 app-server 进程并 thread/start，是整轮里最长的黑盒；
    // 事件接线要到下面才建立，所以这里直接用 options.onEvent 播报。
    options.onEvent?.({ type: 'phase', phase: 'thread-setup', detail: '正在唤醒管家…' });
    const resumeMode = await ensureResidentThread();
    if (residentStopRequested) return { text: '' };
    options.onEvent?.({
      type: 'phase',
      phase: 'thinking',
      detail: resumeMode === 'started' || resumeMode === 'restarted' ? '正在准备上下文…' : '正在接续上下文…',
    });
    const threadId = residentThreadId;
    if (!threadId) throw new Error('AI Codex 会话尚未创建');
    const client = await ensureResidentClient();
    const skillInput = await resolveSkillInput(
      client,
      residentWorkspaceRoot!,
      text,
      options.skillName,
      options.skillPath,
    );
    timing = beginButlerTurnTiming({ threadSetupMs: Date.now() - setupStartedAt, resumeMode });
    const controller = createTurnController(threadId, options.onEvent, timing);
    residentTurn = controller;
    residentEvent = options.onEvent;
    residentToolRuntimeContext = options.toolRuntimeContext;
    residentStatus = 'running';
    const transcript = resumeMode === 'started' || resumeMode === 'restarted'
      ? options.fallbackTranscript
      : options.bridgeTranscript;
    const prefixedText = timePrefixedInput(
      roomPrefixedInput(
        transcriptPrefixedInput(skillInput.text, transcript),
        options.context,
        options.taskContext,
      ),
      now,
    );
    const result = await controller.start(
      client,
      await buildTurnInputs(
        residentSessionId!,
        residentWorkspaceRoot!,
        prefixedText,
        options.images,
        skillInput.skillName,
        skillInput.skillPath,
      ),
    );
    residentStatus = 'ready';
    residentTurn = undefined;
    residentEvent = undefined;
    residentToolRuntimeContext = undefined;
    // 用户点「停止」时整轮时长是被截断的，不能混进耗时分布。
    timing.end(residentStopRequested ? 'stopped' : 'completed');
    return { text: result };
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason) setCodexBrainUnavailableReason(reason);
    timing?.end('failed');
    residentTurn = undefined;
    residentEvent = undefined;
    residentToolRuntimeContext = undefined;
    if (residentStatus !== 'interrupted') residentStatus = residentThreadId ? 'ready' : 'idle';
    throw error;
  } finally {
    residentStopRequested = false;
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
  const workspaceRoot = await workspaceResolver();
  return openCodexNewThread(transferTranscript('管家对话', lines), workspaceRoot);
}

/**
 * 停止管家当前正在进行的回答：先请求服务端中断本轮，再就地完成
 * 本轮 Promise（保留已生成的部分内容）。没有进行中的轮次时是 no-op。
 */
export async function stopButlerCodexTurn(): Promise<void> {
  residentStopRequested = true;
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
  const abortError = () => options.signal?.reason instanceof Error
    ? options.signal.reason
    : new Error('Butler 临时会话已暂停');
  if (options.signal?.aborted) throw abortError();
  const availability = codexBrainAvailability();
  if (!availability.available) throw new Error(availability.reason ?? '管家暂时用不了');
  const tools = createCodexHostTools();
  const registeredTools = new Map(tools.map((tool) => [tool.name, tool]));
  const sessionId = `butler-routine-${crypto.randomUUID()}`;
  const workspaceRoot = await workspaceResolver();
  let threadId: string | undefined;
  let controller: TurnController | undefined;
  const client = new AppServerClient(transportFactory(sessionId, workspaceRoot), {
    onNotification: (method, params) => controller?.onNotification(method, params),
    onServerRequest: (request) => respondDynamicToolCall(
      request,
      threadId,
      registeredTools,
      options.onEvent,
      options.toolRuntimeContext,
    ),
    onInterrupted: (error) => controller?.interrupt(error),
  });
  const handleAbort = () => {
    const turnId = controller?.activeTurnId();
    if (threadId && turnId) {
      void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    }
    controller?.interrupt(abortError());
  };
  options.signal?.addEventListener('abort', handleAbort, { once: true });
  try {
    await client.start();
    if (options.signal?.aborted) throw abortError();
    const now = options.now ?? Date.now();
    const skillInput = await resolveSkillInput(
      client,
      workspaceRoot,
      options.text.trim(),
      options.skillName,
      options.skillPath,
    );
    const { model } = getButlerCodexSettings();
    const config = await businessMcpThreadConfig();
    const response = await client.request('thread/start', {
      ...(model ? { model } : {}),
      cwd: workspaceRoot,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'read-only',
      ephemeral: true,
      baseInstructions: instructions(),
      dynamicTools: dynamicTools(tools),
      ...(config ? { config } : {}),
    });
    threadId = response.thread.id;
    controller = createTurnController(threadId, options.onEvent);
    if (options.signal?.aborted) throw abortError();
    return {
      text: await controller.start(client, await buildTurnInputs(
        sessionId,
        workspaceRoot,
        timePrefixedInput(roomPrefixedInput(
          skillInput.text,
          options.context,
          options.taskContext,
        ), now),
        options.images,
        skillInput.skillName,
        skillInput.skillPath,
      )),
    };
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason) setCodexBrainUnavailableReason(reason);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', handleAbort);
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
  clearButlerNativeSkillStates();
}
