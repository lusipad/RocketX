import type { ExternalAgentConfigImportParams } from './generated/v2/ExternalAgentConfigImportParams';
import type { ExternalAgentConfigImportResponse } from './generated/v2/ExternalAgentConfigImportResponse';
import type { AppsListParams } from './generated/v2/AppsListParams';
import type { AppsListResponse } from './generated/v2/AppsListResponse';
import type { InitializeParams } from './generated/InitializeParams';
import type { InitializeResponse } from './generated/InitializeResponse';
import type { ListMcpServerStatusParams } from './generated/v2/ListMcpServerStatusParams';
import type { ListMcpServerStatusResponse } from './generated/v2/ListMcpServerStatusResponse';
import type { McpServerToolCallParams } from './generated/v2/McpServerToolCallParams';
import type { McpServerToolCallResponse } from './generated/v2/McpServerToolCallResponse';
import type { MarketplaceAddParams } from './generated/v2/MarketplaceAddParams';
import type { MarketplaceAddResponse } from './generated/v2/MarketplaceAddResponse';
import type { MarketplaceRemoveParams } from './generated/v2/MarketplaceRemoveParams';
import type { MarketplaceRemoveResponse } from './generated/v2/MarketplaceRemoveResponse';
import type { MarketplaceUpgradeParams } from './generated/v2/MarketplaceUpgradeParams';
import type { MarketplaceUpgradeResponse } from './generated/v2/MarketplaceUpgradeResponse';
import type { ModelListParams } from './generated/v2/ModelListParams';
import type { ModelListResponse } from './generated/v2/ModelListResponse';
import type { PermissionProfileListParams } from './generated/v2/PermissionProfileListParams';
import type { PermissionProfileListResponse } from './generated/v2/PermissionProfileListResponse';
import type { PluginInstallParams } from './generated/v2/PluginInstallParams';
import type { PluginInstallResponse } from './generated/v2/PluginInstallResponse';
import type { PluginInstalledParams } from './generated/v2/PluginInstalledParams';
import type { PluginInstalledResponse } from './generated/v2/PluginInstalledResponse';
import type { PluginListParams } from './generated/v2/PluginListParams';
import type { PluginListResponse } from './generated/v2/PluginListResponse';
import type { PluginReadParams } from './generated/v2/PluginReadParams';
import type { PluginReadResponse } from './generated/v2/PluginReadResponse';
import type { PluginSkillReadParams } from './generated/v2/PluginSkillReadParams';
import type { PluginSkillReadResponse } from './generated/v2/PluginSkillReadResponse';
import type { PluginUninstallParams } from './generated/v2/PluginUninstallParams';
import type { PluginUninstallResponse } from './generated/v2/PluginUninstallResponse';
import type { SkillsConfigWriteParams } from './generated/v2/SkillsConfigWriteParams';
import type { SkillsConfigWriteResponse } from './generated/v2/SkillsConfigWriteResponse';
import type { SkillsExtraRootsSetParams } from './generated/v2/SkillsExtraRootsSetParams';
import type { SkillsExtraRootsSetResponse } from './generated/v2/SkillsExtraRootsSetResponse';
import type { SkillsListParams } from './generated/v2/SkillsListParams';
import type { SkillsListResponse } from './generated/v2/SkillsListResponse';
import type { ThreadArchiveParams } from './generated/v2/ThreadArchiveParams';
import type { ThreadArchiveResponse } from './generated/v2/ThreadArchiveResponse';
import type { ThreadGoalClearParams } from './generated/v2/ThreadGoalClearParams';
import type { ThreadGoalClearResponse } from './generated/v2/ThreadGoalClearResponse';
import type { ThreadGoalGetParams } from './generated/v2/ThreadGoalGetParams';
import type { ThreadGoalGetResponse } from './generated/v2/ThreadGoalGetResponse';
import type { ThreadGoalSetParams } from './generated/v2/ThreadGoalSetParams';
import type { ThreadGoalSetResponse } from './generated/v2/ThreadGoalSetResponse';
import type { ThreadForkParams } from './generated/v2/ThreadForkParams';
import type { ThreadForkResponse } from './generated/v2/ThreadForkResponse';
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse';
import type { ThreadSetNameParams } from './generated/v2/ThreadSetNameParams';
import type { ThreadSetNameResponse } from './generated/v2/ThreadSetNameResponse';
import type { ThreadMemoryModeSetParams } from './generated/v2/ThreadMemoryModeSetParams';
import type { ThreadMemoryModeSetResponse } from './generated/v2/ThreadMemoryModeSetResponse';
import type { ThreadListParams } from './generated/v2/ThreadListParams';
import type { ThreadListResponse } from './generated/v2/ThreadListResponse';
import type { ThreadReadParams } from './generated/v2/ThreadReadParams';
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse';
import type { ThreadSettingsUpdateParams } from './generated/v2/ThreadSettingsUpdateParams';
import type { ThreadSettingsUpdateResponse } from './generated/v2/ThreadSettingsUpdateResponse';
import type { ThreadTurnsListParams } from './generated/v2/ThreadTurnsListParams';
import type { ThreadTurnsListResponse } from './generated/v2/ThreadTurnsListResponse';
import type { TurnInterruptParams } from './generated/v2/TurnInterruptParams';
import type { TurnInterruptResponse } from './generated/v2/TurnInterruptResponse';
import type { TurnStartParams } from './generated/v2/TurnStartParams';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse';
import type { TurnSteerParams } from './generated/v2/TurnSteerParams';
import type { TurnSteerResponse } from './generated/v2/TurnSteerResponse';
import { assertCodexHandshake } from './compatibility';
import { serverRequestPolicy } from './serverRequests';

export interface CodexProcessInfo {
  processId: string;
  version: string;
  runtimeSource: 'manual' | 'bundled' | 'standard' | 'system';
  managedSkillRoots: string[];
  runtimeWorkspaceRoot?: string;
}

export interface CodexTransportHandlers {
  onLine: (line: string) => void;
  onExit: (code: number | null) => void;
}

export interface CodexTransport {
  start: (handlers: CodexTransportHandlers) => Promise<CodexProcessInfo>;
  write: (message: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
}

interface ClientMethods {
  initialize: { params: InitializeParams; result: InitializeResponse };
  'model/list': { params: ModelListParams; result: ModelListResponse };
  'permissionProfile/list': {
    params: PermissionProfileListParams;
    result: PermissionProfileListResponse;
  };
  'app/list': { params: AppsListParams; result: AppsListResponse };
  'skills/list': { params: SkillsListParams; result: SkillsListResponse };
  'skills/config/write': {
    params: SkillsConfigWriteParams;
    result: SkillsConfigWriteResponse;
  };
  'skills/extraRoots/set': {
    params: SkillsExtraRootsSetParams;
    result: SkillsExtraRootsSetResponse;
  };
  'marketplace/add': {
    params: MarketplaceAddParams;
    result: MarketplaceAddResponse;
  };
  'marketplace/remove': {
    params: MarketplaceRemoveParams;
    result: MarketplaceRemoveResponse;
  };
  'marketplace/upgrade': {
    params: MarketplaceUpgradeParams;
    result: MarketplaceUpgradeResponse;
  };
  'plugin/list': { params: PluginListParams; result: PluginListResponse };
  'plugin/installed': {
    params: PluginInstalledParams;
    result: PluginInstalledResponse;
  };
  'plugin/read': { params: PluginReadParams; result: PluginReadResponse };
  'plugin/skill/read': {
    params: PluginSkillReadParams;
    result: PluginSkillReadResponse;
  };
  'plugin/install': {
    params: PluginInstallParams;
    result: PluginInstallResponse;
  };
  'plugin/uninstall': {
    params: PluginUninstallParams;
    result: PluginUninstallResponse;
  };
  'mcpServerStatus/list': {
    params: ListMcpServerStatusParams;
    result: ListMcpServerStatusResponse;
  };
  'mcpServer/tool/call': {
    params: McpServerToolCallParams;
    result: McpServerToolCallResponse;
  };
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse };
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse };
  'thread/fork': { params: ThreadForkParams; result: ThreadForkResponse };
  'thread/settings/update': {
    params: ThreadSettingsUpdateParams;
    result: ThreadSettingsUpdateResponse;
  };
  'thread/archive': { params: ThreadArchiveParams; result: ThreadArchiveResponse };
  'thread/goal/set': { params: ThreadGoalSetParams; result: ThreadGoalSetResponse };
  'thread/goal/get': { params: ThreadGoalGetParams; result: ThreadGoalGetResponse };
  'thread/goal/clear': {
    params: ThreadGoalClearParams;
    result: ThreadGoalClearResponse;
  };
  'thread/name/set': { params: ThreadSetNameParams; result: ThreadSetNameResponse };
  'thread/memoryMode/set': {
    params: ThreadMemoryModeSetParams;
    result: ThreadMemoryModeSetResponse;
  };
  'thread/list': { params: ThreadListParams; result: ThreadListResponse };
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse };
  'thread/turns/list': {
    params: ThreadTurnsListParams;
    result: ThreadTurnsListResponse;
  };
  'externalAgentConfig/import': {
    params: ExternalAgentConfigImportParams;
    result: ExternalAgentConfigImportResponse;
  };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/steer': { params: TurnSteerParams; result: TurnSteerResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse };
}

export interface ServerRequestContext {
  method: string;
  params: unknown;
  policy: ReturnType<typeof serverRequestPolicy>;
}

export interface AppServerClientOptions {
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (request: ServerRequestContext) => Promise<unknown>;
  onInterrupted?: (error: Error) => void;
}

interface PendingRequest {
  method: keyof ClientMethods;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertClientResponse(method: keyof ClientMethods, value: unknown): void {
  const response = isRecord(value) ? value : null;
  if (!response) throw new Error(`Codex app-server ${method} 返回了非对象响应。`);
  if (method === 'initialize') {
    if (typeof response.userAgent !== 'string') {
      throw new Error('Codex app-server initialize 响应缺少 userAgent。');
    }
    return;
  }
  if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
    if (!isRecord(response.thread) || typeof response.thread.id !== 'string') {
      throw new Error(`Codex app-server ${method} 响应缺少 thread.id。`);
    }
    return;
  }
  if (method === 'model/list' || method === 'permissionProfile/list' || method === 'app/list') {
    if (!Array.isArray(response.data)) {
      throw new Error(`Codex app-server ${method} 响应缺少 data。`);
    }
    return;
  }
  if (method === 'skills/list') {
    if (!Array.isArray(response.data)) {
      throw new Error('Codex app-server skills/list 响应缺少 data。');
    }
    return;
  }
  if (method === 'skills/config/write') {
    if (typeof response.effectiveEnabled !== 'boolean') {
      throw new Error('Codex app-server skills/config/write 响应缺少 effectiveEnabled。');
    }
    return;
  }
  if (method === 'marketplace/add') {
    if (
      typeof response.marketplaceName !== 'string'
      || typeof response.installedRoot !== 'string'
      || typeof response.alreadyAdded !== 'boolean'
    ) {
      throw new Error('Codex app-server marketplace/add 返回了无效市场。');
    }
    return;
  }
  if (method === 'marketplace/remove') {
    if (
      typeof response.marketplaceName !== 'string'
      || (response.installedRoot !== null && typeof response.installedRoot !== 'string')
    ) {
      throw new Error('Codex app-server marketplace/remove 返回了无效市场。');
    }
    return;
  }
  if (method === 'marketplace/upgrade') {
    if (
      !Array.isArray(response.selectedMarketplaces)
      || !Array.isArray(response.upgradedRoots)
      || !Array.isArray(response.errors)
    ) {
      throw new Error('Codex app-server marketplace/upgrade 返回了无效结果。');
    }
    return;
  }
  if (method === 'plugin/list' || method === 'plugin/installed') {
    if (!Array.isArray(response.marketplaces) || !Array.isArray(response.marketplaceLoadErrors)) {
      throw new Error(`Codex app-server ${method} 返回了无效插件市场。`);
    }
    if (method === 'plugin/list' && !Array.isArray(response.featuredPluginIds)) {
      throw new Error('Codex app-server plugin/list 响应缺少 featuredPluginIds。');
    }
    return;
  }
  if (method === 'plugin/read') {
    if (!isRecord(response.plugin)) {
      throw new Error('Codex app-server plugin/read 响应缺少 plugin。');
    }
    return;
  }
  if (method === 'plugin/skill/read') {
    if (response.contents !== null && typeof response.contents !== 'string') {
      throw new Error('Codex app-server plugin/skill/read 返回了无效 Skill 正文。');
    }
    return;
  }
  if (method === 'plugin/install') {
    if (
      (response.authPolicy !== 'ON_INSTALL' && response.authPolicy !== 'ON_USE')
      || !Array.isArray(response.appsNeedingAuth)
    ) {
      throw new Error('Codex app-server plugin/install 返回了无效安装结果。');
    }
    return;
  }
  if (method === 'mcpServerStatus/list') {
    if (!Array.isArray(response.data)) {
      throw new Error('Codex app-server mcpServerStatus/list 响应缺少 data。');
    }
    return;
  }
  if (method === 'mcpServer/tool/call') {
    if (!Array.isArray(response.content)) {
      throw new Error('Codex app-server mcpServer/tool/call 响应缺少 content。');
    }
    return;
  }
  if (method === 'thread/goal/set') {
    if (!isRecord(response.goal) || typeof response.goal.threadId !== 'string') {
      throw new Error('Codex app-server thread/goal/set 响应缺少 goal。');
    }
    return;
  }
  if (method === 'thread/goal/get') {
    if (response.goal !== null && (!isRecord(response.goal) || typeof response.goal.threadId !== 'string')) {
      throw new Error('Codex app-server thread/goal/get 返回了无效 goal。');
    }
    return;
  }
  if (method === 'thread/goal/clear') {
    if (typeof response.cleared !== 'boolean') {
      throw new Error('Codex app-server thread/goal/clear 响应缺少 cleared。');
    }
    return;
  }
  if (method === 'thread/list' || method === 'thread/turns/list') {
    if (!Array.isArray(response.data)) {
      throw new Error(`Codex app-server ${method} 响应缺少 data。`);
    }
    return;
  }
  if (method === 'thread/read') {
    if (!isRecord(response.thread) || typeof response.thread.id !== 'string') {
      throw new Error('Codex app-server thread/read 响应缺少 thread.id。');
    }
    return;
  }
  if (method === 'turn/start' && (!isRecord(response.turn) || typeof response.turn.id !== 'string')) {
    throw new Error('Codex app-server turn/start 响应缺少 turn.id。');
    return;
  }
  if (method === 'turn/steer' && typeof response.turnId !== 'string') {
    throw new Error('Codex app-server turn/steer 响应缺少 turnId。');
  }
}

export class AppServerClient {
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private started = false;
  private currentProcess?: CodexProcessInfo;

  constructor(
    private readonly transport: CodexTransport,
    private readonly options: AppServerClientOptions = {},
  ) {}

  get processInfo(): CodexProcessInfo | undefined {
    return this.currentProcess;
  }

  async start(): Promise<CodexProcessInfo> {
    if (this.started && this.currentProcess) return this.currentProcess;
    const process = await this.transport.start({
      onLine: (line) => this.receiveLine(line),
      onExit: (code) => this.interrupt(new Error(`Codex app-server 已退出${code === null ? '' : `（${code}）`}`)),
    });
    try {
      const initialized = await this.request('initialize', {
        clientInfo: { name: 'rocketx', title: 'RocketX', version: '0.23.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: null,
        },
      });
      assertCodexHandshake(initialized.userAgent, process.version);
      await this.transport.write({ method: 'initialized' });
      this.currentProcess = process;
      this.started = true;
      return process;
    } catch (error) {
      this.currentProcess = undefined;
      await this.transport.stop().catch(() => undefined);
      throw error;
    }
  }

  request<M extends keyof ClientMethods>(
    method: M,
    params: ClientMethods[M]['params'],
    timeoutMs = 15_000,
  ): Promise<ClientMethods[M]['result']> {
    const id = this.nextId++;
    return new Promise<ClientMethods[M]['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          try {
            assertClientResponse(method, value);
            resolve(value as ClientMethods[M]['result']);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject,
        timer,
      });
      void this.transport.write({ id, method, params }).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.currentProcess = undefined;
    this.rejectPending(new Error('Codex app-server 已停止'));
    await this.transport.stop();
  }

  private receiveLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.interrupt(new Error('Codex app-server 返回了无效 JSON'));
      return;
    }
    if (!isRecord(message)) {
      this.interrupt(new Error('Codex app-server 返回了非对象消息'));
      return;
    }
    if ('id' in message && !('method' in message)) {
      this.receiveResponse(message as unknown as RpcResponse);
      return;
    }
    const method = typeof message.method === 'string' ? message.method : null;
    if (!method) {
      this.interrupt(new Error('Codex app-server 返回了缺少 method 的消息'));
      return;
    }
    if ('id' in message) {
      void this.receiveServerRequest(message.id as number | string, method, message.params).catch((error: unknown) => {
        this.interrupt(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    this.options.onNotification?.(method, message.params);
  }

  private receiveResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error) {
      if (response.error.code === -32601) {
        pending.reject(new Error(`Codex app-server 不支持 RocketX 所需方法：${pending.method}。`));
        return;
      }
      pending.reject(
        new Error(
          `Codex app-server 请求失败${response.error.code === undefined ? '' : ` ${response.error.code}`}：${response.error.message ?? '未知错误'}`,
        ),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private async receiveServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const policy = serverRequestPolicy(method);
    if (policy === 'unknown') {
      await this.transport.write({ id, error: { code: -32601, message: `Unsupported request: ${method}` } });
      return;
    }
    if (policy === 'local-safe' && method === 'currentTime/read') {
      await this.transport.write({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    if (!this.options.onServerRequest) {
      await this.transport.write({ id, error: { code: -32001, message: `Request denied by RocketX: ${method}` } });
      return;
    }
    try {
      const result = await this.options.onServerRequest({ method, params, policy });
      await this.transport.write({ id, result });
    } catch (error) {
      await this.transport.write({
        id,
        error: {
          code: -32001,
          message: error instanceof Error ? error.message : 'Request denied by RocketX',
        },
      });
    }
  }

  private interrupt(error: Error): void {
    this.started = false;
    this.currentProcess = undefined;
    this.rejectPending(error);
    this.options.onInterrupted?.(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
