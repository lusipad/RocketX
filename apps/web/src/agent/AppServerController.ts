import {
  AppServerClient,
  TauriPiTransport,
  type CodexTransport,
  type ServerRequestContext,
} from './protocol';
import { businessMcpThreadConfig } from './businessMcp';
import type { AppInfo } from './protocol/generated/v2/AppInfo';
import type { Model } from './protocol/generated/v2/Model';
import type { PermissionProfileSummary } from './protocol/generated/v2/PermissionProfileSummary';
import type { PluginListResponse } from './protocol/generated/v2/PluginListResponse';
import type { PluginReadResponse } from './protocol/generated/v2/PluginReadResponse';
import type { PluginInstallResponse } from './protocol/generated/v2/PluginInstallResponse';
import type { SkillMetadata } from './protocol/generated/v2/SkillMetadata';
import type { DynamicToolSpec } from './protocol/generated/v2/DynamicToolSpec';
import type { Thread } from './protocol/generated/v2/Thread';
import type { Turn } from './protocol/generated/v2/Turn';
import type { UserInput } from './protocol/generated/v2/UserInput';
import {
  executeRegisteredDynamicTool,
  getRegisteredDynamicTools,
  type HostDynamicToolProvider,
} from './dynamicToolRegistry';
import { buildUiLanguageInstruction, t } from '../i18n';

export type CodexPermissionPreset = 'ask' | 'auto' | 'full';

const SCHEDULE_MUTATION_TOOLS = new Set([
  'create_scheduled_task',
  'update_scheduled_task',
  'delete_scheduled_task',
  'run_scheduled_task',
]);

export interface CodexRuntimeSelection {
  model: string;
  effort: string | null;
  permissionPreset: CodexPermissionPreset;
}

export interface CodexPermissionSettings {
  permissions: ':workspace' | ':danger-full-access';
  approvalPolicy: 'on-request' | 'never';
  approvalsReviewer: 'user' | 'guardian_subagent';
}

export interface CodexCatalog {
  models: Model[];
  permissionProfiles: PermissionProfileSummary[];
  skills: SkillMetadata[];
  apps: AppInfo[];
  plugins: PluginListResponse;
  catalogErrors: { apps?: string; plugins?: string };
}

export interface AppServerControllerOptions {
  transportFactory?: (sessionId: string, workspaceRoot: string) => CodexTransport;
  toolProvider?: HostDynamicToolProvider;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (request: ServerRequestContext) => Promise<unknown>;
  onInterrupted?: (error: Error) => void;
}

export function permissionSettings(preset: CodexPermissionPreset): CodexPermissionSettings {
  if (preset === 'full') {
    return {
      permissions: ':danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
    };
  }
  return {
    permissions: ':workspace',
    approvalPolicy: 'on-request',
    approvalsReviewer: preset === 'auto' ? 'guardian_subagent' : 'user',
  };
}

function flattenSkills(
  entries: readonly { cwd: string; skills: SkillMetadata[] }[],
  workspaceRoot: string,
): SkillMetadata[] {
  const normalize = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const root = normalize(workspaceRoot);
  return entries.find((entry) => normalize(entry.cwd) === root)?.skills ?? [];
}

const EMPTY_PLUGINS: PluginListResponse = {
  marketplaces: [],
  marketplaceLoadErrors: [],
  featuredPluginIds: [],
};

function catalogError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.match(/Request failed with status \d{3} [^:<\r\n]+/)?.[0]
    ?? value.split(/\r?\n/, 1)[0].slice(0, 240);
}

async function readCatalog(
  client: AppServerClient,
  workspaceRoot: string,
  threadId: string | null,
): Promise<CodexCatalog> {
  const optional = <T>(request: Promise<T>) => request.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
  const [models, permissions, skills, apps, plugins] = await Promise.all([
    client.request('model/list', { includeHidden: false }),
    client.request('permissionProfile/list', { cwd: workspaceRoot }),
    client.request('skills/list', { cwds: [workspaceRoot], forceReload: true }),
    optional(client.request('app/list', { threadId, forceRefetch: true })),
    optional(client.request('plugin/list', { cwds: [workspaceRoot] })),
  ]);
  return {
    models: models.data.filter((model) => !model.hidden),
    permissionProfiles: permissions.data,
    skills: flattenSkills(skills.data, workspaceRoot),
    apps: apps.status === 'fulfilled' ? apps.value.data : [],
    plugins: plugins.status === 'fulfilled' ? plugins.value : EMPTY_PLUGINS,
    catalogErrors: {
      ...(apps.status === 'rejected' ? { apps: catalogError(apps.reason) } : {}),
      ...(plugins.status === 'rejected' ? { plugins: catalogError(plugins.reason) } : {}),
    },
  };
}

export class AppServerController {
  private client?: AppServerClient;
  private startingClient?: AppServerClient;
  private connectionGeneration = 0;
  private sessionId?: string;
  private requestedWorkspaceRoot?: string;
  private workspaceRoot?: string;
  private catalog?: CodexCatalog;
  private approvedScheduleMutationThreads = new Set<string>();
  private readonly transportFactory: NonNullable<AppServerControllerOptions['transportFactory']>;

  constructor(private readonly options: AppServerControllerOptions = {}) {
    this.transportFactory = options.transportFactory
      ?? ((sessionId, workspaceRoot) => new TauriPiTransport(sessionId, workspaceRoot));
  }

  get currentCatalog(): CodexCatalog | undefined {
    return this.catalog;
  }

  get currentWorkspaceRoot(): string | undefined {
    return this.workspaceRoot;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  switchWorkspaceRoot(workspaceRoot: string): boolean {
    const normalized = workspaceRoot.trim();
    if (!normalized || !this.client || !this.catalog) return false;
    this.requestedWorkspaceRoot = normalized;
    this.workspaceRoot = normalized;
    return true;
  }

  async connect(sessionId: string, workspaceRoot: string): Promise<CodexCatalog> {
    if (this.client && this.sessionId === sessionId && this.requestedWorkspaceRoot === workspaceRoot && this.catalog) {
      return this.catalog;
    }
    const stopping = this.stop();
    const generation = this.connectionGeneration;
    await stopping;
    if (generation !== this.connectionGeneration) throw new Error(t('agent.transport.piCanceled'));
    const client = new AppServerClient(this.transportFactory(sessionId, workspaceRoot), {
      onNotification: (method, params) => {
        if (generation === this.connectionGeneration) this.options.onNotification?.(method, params);
      },
      onServerRequest: (request) => {
        if (generation !== this.connectionGeneration) throw new Error(t('agent.transport.piCanceled'));
        return this.handleServerRequest(request);
      },
      onInterrupted: (error) => {
        if (generation !== this.connectionGeneration) return;
        this.connectionGeneration += 1;
        this.client = undefined;
        this.startingClient = undefined;
        this.catalog = undefined;
        void client.stop().catch(() => undefined);
        this.options.onInterrupted?.(error);
      },
    });
    this.startingClient = client;
    try {
      const process = await client.start();
      if (generation !== this.connectionGeneration) throw new Error(t('agent.transport.piCanceled'));
      if (process.managedSkillRoots.length === 0) {
        throw new Error(t('agent.appServer.missingSkillRoots'));
      }
      await client.request('skills/extraRoots/set', { extraRoots: process.managedSkillRoots });
      if (generation !== this.connectionGeneration) throw new Error(t('agent.transport.piCanceled'));
      const projectless = !workspaceRoot.trim() || workspaceRoot.trim() === '~';
      const runtimeWorkspaceRoot = projectless
        ? process.runtimeWorkspaceRoot?.trim() || workspaceRoot
        : workspaceRoot;
      const catalog = await readCatalog(client, runtimeWorkspaceRoot, null);
      if (generation !== this.connectionGeneration) throw new Error(t('agent.transport.piCanceled'));
      this.assertPermissionProfiles(catalog.permissionProfiles);
      this.startingClient = undefined;
      this.client = client;
      this.sessionId = sessionId;
      this.requestedWorkspaceRoot = workspaceRoot;
      this.workspaceRoot = runtimeWorkspaceRoot;
      this.catalog = catalog;
      return catalog;
    } catch (error) {
      if (this.startingClient === client) this.startingClient = undefined;
      void client.stop().catch(() => undefined);
      throw error;
    }
  }

  async refreshCatalog(threadId?: string): Promise<CodexCatalog> {
    const client = this.requireClient();
    const workspaceRoot = this.requireWorkspaceRoot();
    const generation = this.connectionGeneration;
    const catalog = await readCatalog(client, workspaceRoot, threadId ?? null);
    if (generation !== this.connectionGeneration) throw new Error(t('agent.transport.piCanceled'));
    this.assertPermissionProfiles(catalog.permissionProfiles);
    this.catalog = catalog;
    return catalog;
  }

  async listThreads(workspaceRoots?: readonly string[]): Promise<Thread[]> {
    const roots = [...new Set(
      (workspaceRoots?.length ? workspaceRoots : [this.requireWorkspaceRoot()])
        .map((root) => root.trim())
        .filter(Boolean),
    )];
    const response = await this.requireClient().request('thread/list', {
      cwd: roots.length === 1 ? roots[0] : roots,
      archived: false,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      limit: 100,
    });
    return response.data;
  }

  async readThread(threadId: string): Promise<{ thread: Thread; turns: Turn[] }> {
    const response = await this.requireClient().request('thread/read', {
      threadId,
      includeTurns: true,
    });
    if (response.thread.turns.length > 0) {
      return { thread: response.thread, turns: response.thread.turns };
    }
    const turns = await this.requireClient().request('thread/turns/list', {
      threadId,
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'full',
    });
    return { thread: response.thread, turns: turns.data };
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    const normalized = name.trim();
    if (!normalized) throw new Error(t('agent.appServer.emptyTaskName'));
    await this.requireClient().request('thread/name/set', { threadId, name: normalized });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.requireClient().request('thread/archive', { threadId });
  }

  async startThread(selection: CodexRuntimeSelection, name?: string, targetWorkspaceRoot?: string): Promise<Thread> {
    const client = this.requireClient();
    const workspaceRoot = targetWorkspaceRoot?.trim() || this.requireWorkspaceRoot();
    this.assertSelection(selection);
    const permissions = permissionSettings(selection.permissionPreset);
    const config = await businessMcpThreadConfig({ features: { memories: true } });
    const response = await client.request('thread/start', {
      model: selection.model,
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      developerInstructions: buildUiLanguageInstruction(),
      ...permissions,
      ...(config ? { config } : {}),
      dynamicTools: this.dynamicTools(),
    });
    await client.request('thread/memoryMode/set', { threadId: response.thread.id, mode: 'enabled' });
    await client.request('thread/settings/update', {
      threadId: response.thread.id,
      model: selection.model,
      effort: selection.effort,
      ...permissions,
    });
    if (name?.trim()) {
      await client.request('thread/name/set', { threadId: response.thread.id, name: name.trim() });
    }
    return response.thread;
  }

  async resumeThread(threadId: string, selection: CodexRuntimeSelection, targetWorkspaceRoot?: string): Promise<Thread> {
    const client = this.requireClient();
    const workspaceRoot = targetWorkspaceRoot?.trim() || this.requireWorkspaceRoot();
    this.assertSelection(selection);
    const permissions = permissionSettings(selection.permissionPreset);
    const config = await businessMcpThreadConfig({ features: { memories: true } });
    const response = await client.request('thread/resume', {
      threadId,
      model: selection.model,
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      developerInstructions: buildUiLanguageInstruction(),
      ...permissions,
      excludeTurns: true,
      ...(config ? { config } : {}),
      dynamicTools: this.dynamicTools(),
    });
    await client.request('thread/memoryMode/set', { threadId: response.thread.id, mode: 'enabled' });
    await client.request('thread/settings/update', {
      threadId: response.thread.id,
      model: selection.model,
      effort: selection.effort,
      ...permissions,
    });
    return response.thread;
  }

  async forkThread(threadId: string, selection: CodexRuntimeSelection, name?: string): Promise<Thread> {
    const client = this.requireClient();
    const workspaceRoot = this.requireWorkspaceRoot();
    this.assertSelection(selection);
    const permissions = permissionSettings(selection.permissionPreset);
    const config = await businessMcpThreadConfig({ features: { memories: true } });
    const response = await client.request('thread/fork', {
      threadId,
      model: selection.model,
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      developerInstructions: buildUiLanguageInstruction(),
      ...permissions,
      excludeTurns: true,
      ...(config ? { config } : {}),
      dynamicTools: this.dynamicTools(),
    });
    await client.request('thread/memoryMode/set', { threadId: response.thread.id, mode: 'enabled' });
    await client.request('thread/settings/update', {
      threadId: response.thread.id,
      model: selection.model,
      effort: selection.effort,
      ...permissions,
    });
    if (name?.trim()) {
      await client.request('thread/name/set', { threadId: response.thread.id, name: name.trim() });
    }
    return response.thread;
  }

  async updateSettings(threadId: string, selection: CodexRuntimeSelection): Promise<void> {
    this.assertSelection(selection);
    await this.requireClient().request('thread/settings/update', {
      threadId,
      model: selection.model,
      effort: selection.effort,
      ...permissionSettings(selection.permissionPreset),
    });
  }

  async startTurn(
    threadId: string,
    input: UserInput[],
    selection: CodexRuntimeSelection,
    options?: { runtimeWorkspaceRoots?: string[]; workspaceRoot?: string },
  ): Promise<string> {
    this.assertSelection(selection);
    const workspaceRoot = options?.workspaceRoot?.trim() || this.requireWorkspaceRoot();
    const runtimeWorkspaceRoots = [...new Set([
      workspaceRoot,
      ...(options?.runtimeWorkspaceRoots ?? []),
    ].map((root) => root.trim()).filter(Boolean))];
    const response = await this.requireClient().request('turn/start', {
      threadId,
      input,
      cwd: workspaceRoot,
      runtimeWorkspaceRoots,
      model: selection.model,
      effort: selection.effort,
      ...permissionSettings(selection.permissionPreset),
    });
    return response.turn.id;
  }

  async steerTurn(threadId: string, turnId: string, input: UserInput[]): Promise<string> {
    const response = await this.requireClient().request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input,
    });
    return response.turnId;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.requireClient().request('turn/interrupt', { threadId, turnId });
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    const client = this.requireClient() as AppServerClient & {
      request: (method: 'thread/unsubscribe', params: { threadId: string }) => Promise<unknown>;
    };
    await client.request('thread/unsubscribe', { threadId });
  }

  async installPlugin(remoteMarketplaceName: string, pluginName: string): Promise<PluginInstallResponse> {
    return this.requireClient().request('plugin/install', { remoteMarketplaceName, pluginName });
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    await this.requireClient().request('plugin/uninstall', { pluginId });
  }

  async readPlugin(remoteMarketplaceName: string, pluginName: string): Promise<PluginReadResponse> {
    return this.requireClient().request('plugin/read', { remoteMarketplaceName, pluginName });
  }

  async setSkillEnabled(path: string, enabled: boolean): Promise<boolean> {
    const response = await this.requireClient().request('skills/config/write', { path, enabled });
    return response.effectiveEnabled;
  }

  private async handleServerRequest(request: ServerRequestContext): Promise<unknown> {
    if (request.policy !== 'dynamic-tool') {
      if (this.options.onServerRequest) return this.options.onServerRequest(request);
      throw new Error(t('agent.appServer.unhandledRequest', { method: request.method }));
    }

    const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    const tool = typeof params.tool === 'string' ? params.tool : '';
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    if (SCHEDULE_MUTATION_TOOLS.has(tool) && !this.approvedScheduleMutationThreads.has(threadId)) {
      if (!this.options.onServerRequest) throw new Error(t('agent.appServer.scheduleApprovalRequired'));
      const action = tool === 'create_scheduled_task'
        ? t('agent.appServer.scheduleAction.create')
        : tool === 'update_scheduled_task'
          ? t('agent.appServer.scheduleAction.update')
          : tool === 'delete_scheduled_task'
            ? t('agent.appServer.scheduleAction.delete')
            : t('agent.appServer.scheduleAction.run');
      const approval = await this.options.onServerRequest({
        method: 'item/rocketxScheduledTask/requestApproval',
        policy: 'host-approval',
        params: {
          ...params,
          reason: t('agent.appServer.scheduleApprovalReason', { action, args: JSON.stringify(params.arguments ?? {}, null, 2) }),
        },
      });
      const decision = typeof approval === 'object' && approval !== null && !Array.isArray(approval)
        ? (approval as Record<string, unknown>).decision
        : undefined;
      if (decision === 'acceptForSession' && threadId) {
        this.approvedScheduleMutationThreads.add(threadId);
      } else if (decision !== 'accept' && decision !== 'approved') {
        throw new Error(t('agent.appServer.scheduleApprovalDeclined'));
      }
    }
    return this.options.toolProvider
      ? this.options.toolProvider.executeTool(request.params)
      : executeRegisteredDynamicTool(request.params);
  }

  private dynamicTools(): DynamicToolSpec[] {
    return this.options.toolProvider
      ? this.options.toolProvider.getTools()
      : getRegisteredDynamicTools();
  }

  async stop(): Promise<void> {
    this.connectionGeneration += 1;
    const client = this.client ?? this.startingClient;
    this.client = undefined;
    this.startingClient = undefined;
    this.catalog = undefined;
    this.sessionId = undefined;
    this.requestedWorkspaceRoot = undefined;
    this.workspaceRoot = undefined;
    this.approvedScheduleMutationThreads.clear();
    if (client) await client.stop().catch(() => undefined);
  }

  private requireClient(): AppServerClient {
    if (!this.client) throw new Error(t('agent.appServer.runtimeNotConnected'));
    return this.client;
  }

  private requireWorkspaceRoot(): string {
    if (!this.workspaceRoot) throw new Error(t('agent.appServer.noWorkspaceSelected'));
    return this.workspaceRoot;
  }

  private assertPermissionProfiles(profiles: readonly PermissionProfileSummary[]): void {
    for (const id of [':workspace', ':danger-full-access']) {
      if (!profiles.some((profile) => profile.id === id && profile.allowed)) {
        throw new Error(t('agent.appServer.missingPermissionProfile', { id }));
      }
    }
  }

  private assertSelection(selection: CodexRuntimeSelection): void {
    const catalog = this.catalog;
    if (!catalog) throw new Error(t('agent.appServer.catalogNotLoaded'));
    const model = catalog.models.find((item) => item.model === selection.model || item.id === selection.model);
    if (!model) throw new Error(t('agent.appServer.modelMissing', { model: selection.model }));
    if (selection.effort && !model.supportedReasoningEfforts.some(
      (item) => item.reasoningEffort === selection.effort,
    )) {
      throw new Error(t('agent.appServer.unsupportedEffort', { model: model.displayName, effort: selection.effort }));
    }
    const profile = permissionSettings(selection.permissionPreset).permissions;
    if (!catalog.permissionProfiles.some((item) => item.id === profile && item.allowed)) {
      throw new Error(t('agent.appServer.disallowedPermissionProfile', { profile }));
    }
  }
}
