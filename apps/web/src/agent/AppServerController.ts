import {
  AppServerClient,
  TauriCodexTransport,
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
import type { Thread } from './protocol/generated/v2/Thread';
import type { Turn } from './protocol/generated/v2/Turn';
import type { UserInput } from './protocol/generated/v2/UserInput';

export type CodexPermissionPreset = 'ask' | 'auto' | 'full';

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
  const [models, permissions, skills] = await Promise.all([
    client.request('model/list', { includeHidden: false }),
    client.request('permissionProfile/list', { cwd: workspaceRoot }),
    client.request('skills/list', { cwds: [workspaceRoot], forceReload: true }),
  ]);
  const [apps, plugins] = await Promise.allSettled([
    client.request('app/list', { threadId, forceRefetch: true }),
    client.request('plugin/list', { cwds: [workspaceRoot] }),
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
  private sessionId?: string;
  private workspaceRoot?: string;
  private catalog?: CodexCatalog;
  private readonly transportFactory: NonNullable<AppServerControllerOptions['transportFactory']>;

  constructor(private readonly options: AppServerControllerOptions = {}) {
    this.transportFactory = options.transportFactory
      ?? ((sessionId, workspaceRoot) => new TauriCodexTransport(sessionId, workspaceRoot));
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

  async connect(sessionId: string, workspaceRoot: string): Promise<CodexCatalog> {
    if (this.client && this.sessionId === sessionId && this.workspaceRoot === workspaceRoot && this.catalog) {
      return this.catalog;
    }
    await this.stop();
    const client = new AppServerClient(this.transportFactory(sessionId, workspaceRoot), {
      onNotification: this.options.onNotification,
      onServerRequest: this.options.onServerRequest,
      onInterrupted: (error) => {
        this.client = undefined;
        this.catalog = undefined;
        this.options.onInterrupted?.(error);
      },
    });
    const process = await client.start();
    try {
      if (process.managedSkillRoots.length === 0) {
        throw new Error('RocketX 没有提供 Codex Skill 根目录');
      }
      await client.request('skills/extraRoots/set', { extraRoots: process.managedSkillRoots });
      const catalog = await readCatalog(client, workspaceRoot, null);
      this.assertPermissionProfiles(catalog.permissionProfiles);
      this.client = client;
      this.sessionId = sessionId;
      this.workspaceRoot = workspaceRoot;
      this.catalog = catalog;
      return catalog;
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    }
  }

  async refreshCatalog(threadId?: string): Promise<CodexCatalog> {
    const client = this.requireClient();
    const workspaceRoot = this.requireWorkspaceRoot();
    this.catalog = await readCatalog(client, workspaceRoot, threadId ?? null);
    this.assertPermissionProfiles(this.catalog.permissionProfiles);
    return this.catalog;
  }

  async listThreads(): Promise<Thread[]> {
    const response = await this.requireClient().request('thread/list', {
      cwd: this.requireWorkspaceRoot(),
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
    if (!normalized) throw new Error('任务名称不能为空');
    await this.requireClient().request('thread/name/set', { threadId, name: normalized });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.requireClient().request('thread/archive', { threadId });
  }

  async startThread(selection: CodexRuntimeSelection, name?: string): Promise<Thread> {
    const client = this.requireClient();
    const workspaceRoot = this.requireWorkspaceRoot();
    this.assertSelection(selection);
    const permissions = permissionSettings(selection.permissionPreset);
    const config = await businessMcpThreadConfig({ features: { memories: true } });
    const response = await client.request('thread/start', {
      model: selection.model,
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      ...permissions,
      ...(config ? { config } : {}),
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

  async resumeThread(threadId: string, selection: CodexRuntimeSelection): Promise<Thread> {
    const client = this.requireClient();
    const workspaceRoot = this.requireWorkspaceRoot();
    this.assertSelection(selection);
    const permissions = permissionSettings(selection.permissionPreset);
    const config = await businessMcpThreadConfig({ features: { memories: true } });
    const response = await client.request('thread/resume', {
      threadId,
      model: selection.model,
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      ...permissions,
      excludeTurns: true,
      ...(config ? { config } : {}),
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
    options?: { runtimeWorkspaceRoots?: string[] },
  ): Promise<string> {
    this.assertSelection(selection);
    const workspaceRoot = this.requireWorkspaceRoot();
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

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.catalog = undefined;
    this.sessionId = undefined;
    this.workspaceRoot = undefined;
    if (client) await client.stop().catch(() => undefined);
  }

  private requireClient(): AppServerClient {
    if (!this.client) throw new Error('Codex Runtime 尚未连接');
    return this.client;
  }

  private requireWorkspaceRoot(): string {
    if (!this.workspaceRoot) throw new Error('尚未选择工作区');
    return this.workspaceRoot;
  }

  private assertPermissionProfiles(profiles: readonly PermissionProfileSummary[]): void {
    for (const id of [':workspace', ':danger-full-access']) {
      if (!profiles.some((profile) => profile.id === id && profile.allowed)) {
        throw new Error(`当前 Codex Runtime 缺少必需权限档 ${id}，请升级 Codex。`);
      }
    }
  }

  private assertSelection(selection: CodexRuntimeSelection): void {
    const catalog = this.catalog;
    if (!catalog) throw new Error('Codex Runtime 能力目录尚未加载');
    const model = catalog.models.find((item) => item.model === selection.model || item.id === selection.model);
    if (!model) throw new Error(`当前 Codex Runtime 没有模型 ${selection.model}`);
    if (selection.effort && !model.supportedReasoningEfforts.some(
      (item) => item.reasoningEffort === selection.effort,
    )) {
      throw new Error(`模型 ${model.displayName} 不支持推理强度 ${selection.effort}`);
    }
    const profile = permissionSettings(selection.permissionPreset).permissions;
    if (!catalog.permissionProfiles.some((item) => item.id === profile && item.allowed)) {
      throw new Error(`当前 Codex Runtime 不允许权限档 ${profile}`);
    }
  }
}
