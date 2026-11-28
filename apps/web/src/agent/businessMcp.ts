import { t } from '../i18n';
import type { JsonValue } from './protocol/generated/serde_json/JsonValue';
import { isTauri } from '../lib/http';
import { registerBusinessMcpLifecyclePort } from '../lib/runtimeLifecycle';
import { butlerMcpLaunchConfigs, type ButlerMcpLaunchConfig } from '../platform/desktopCommands';

const LAUNCH_CONFIG_DEADLINE_MS = 1_000;
const SERVER_NAME = 'rocketx_business';

export interface BusinessMcpLaunchConfig {
  command: string;
  args: string[];
}

type ThreadConfig = Record<string, JsonValue | undefined>;
type LaunchConfigProvider = () => Promise<BusinessMcpLaunchConfig | null>;
type CommandInvoker = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<boolean>;

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('agent.businessMcp.configTimeout'))), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function nativeLaunchConfig(): Promise<BusinessMcpLaunchConfig | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const value = await withDeadline(
    invoke<BusinessMcpLaunchConfig>('business_mcp_launch_config'),
    LAUNCH_CONFIG_DEADLINE_MS,
  );
  if (
    !value
    || typeof value.command !== 'string'
    || !value.command.trim()
    || !Array.isArray(value.args)
    || value.args.some((argument) => typeof argument !== 'string')
  ) {
    throw new Error(t('agent.businessMcp.invalidConfig'));
  }
  return value;
}

async function nativeCommandInvoker(
  command: string,
  args?: Record<string, unknown>,
): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  await withDeadline(invoke(command, args), LAUNCH_CONFIG_DEADLINE_MS);
  return true;
}

let launchConfigProvider: LaunchConfigProvider = nativeLaunchConfig;
let launchConfigPromise: Promise<BusinessMcpLaunchConfig | null> | null = null;
let customMcpProvider: () => Promise<ButlerMcpLaunchConfig[]> = async () => (
  isTauri ? butlerMcpLaunchConfigs().catch(() => []) : []
);
let commandInvoker: CommandInvoker = nativeCommandInvoker;
let credentialGateRequired = isTauri;
let rocketChatCredentialReady = !credentialGateRequired;
let azureDevOpsCredentialReady = !credentialGateRequired;
let credentialRevision = 0;

function updateCredentialState(
  target: 'rocket-chat' | 'azure-devops',
  ready: boolean,
): void {
  if (target === 'rocket-chat') {
    if (rocketChatCredentialReady === ready) return;
    rocketChatCredentialReady = ready;
  } else {
    if (azureDevOpsCredentialReady === ready) return;
    azureDevOpsCredentialReady = ready;
  }
  credentialRevision += 1;
}

function credentialsReady(): boolean {
  return !credentialGateRequired
    || (rocketChatCredentialReady && azureDevOpsCredentialReady);
}

async function loadLaunchConfig(): Promise<BusinessMcpLaunchConfig | null> {
  launchConfigPromise ??= launchConfigProvider().catch(() => {
    launchConfigPromise = null;
    return null;
  });
  return launchConfigPromise;
}

export function mergeBusinessMcpConfig(
  current: ThreadConfig | null | undefined,
  launch: BusinessMcpLaunchConfig,
): ThreadConfig {
  const currentServers = current?.mcp_servers;
  if (currentServers !== undefined && !isRecord(currentServers)) {
    return current ?? {};
  }
  return {
    ...(current ?? {}),
    mcp_servers: {
      ...(currentServers ?? {}),
      [SERVER_NAME]: {
        command: launch.command,
        args: launch.args,
      },
    },
  };
}

export function mergeCustomMcpConfigs(
  current: ThreadConfig | null | undefined,
  customServers: readonly ButlerMcpLaunchConfig[],
): ThreadConfig {
  if (!customServers.length) return current ?? {};
  const currentServers = current?.mcp_servers;
  if (currentServers !== undefined && !isRecord(currentServers)) {
    return current ?? {};
  }
  const merged: Record<string, JsonValue> = { ...(currentServers ?? {}) };
  for (const server of customServers) {
    const key = server.id || server.name;
    if (!key || key === SERVER_NAME || !server.command.trim()) continue;
    merged[key] = {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
  }
  return {
    ...(current ?? {}),
    mcp_servers: merged,
  };
}

export async function businessMcpThreadConfig(
  current?: ThreadConfig | null,
): Promise<ThreadConfig | undefined> {
  let next: ThreadConfig | undefined = current ?? undefined;
  if (credentialsReady()) {
    const launch = await loadLaunchConfig();
    if (launch) {
      next = mergeBusinessMcpConfig(next, launch);
    }
  }
  const custom = await withDeadline(customMcpProvider(), LAUNCH_CONFIG_DEADLINE_MS).catch(() => []);
  if (custom.length > 0) {
    next = mergeCustomMcpConfigs(next, custom);
  }
  return next;
}

async function invokeBestEffort(command: string, args?: Record<string, unknown>): Promise<boolean> {
  try {
    return await commandInvoker(command, args);
  } catch {
    console.warn(`[business-mcp] ${command} failed`);
    return false;
  }
}

export async function syncBusinessMcpRocketChat(input: {
  serverUrl: string;
  userId: string;
  authToken: string;
}): Promise<boolean> {
  updateCredentialState('rocket-chat', false);
  const synced = await invokeBestEffort('business_mcp_sync_rocket_chat', input);
  if (synced) {
    updateCredentialState('rocket-chat', true);
    return true;
  }
  // 同步失败后尽力清空 keychain：清空成功说明没有残留凭据，可以安全注入
  // （各工具按能力返回 not_configured）；只有清空也失败才保持关闭，
  // 避免上一个账号的残留凭据被新会话误用。
  const cleared = await invokeBestEffort('business_mcp_clear_rocket_chat');
  updateCredentialState('rocket-chat', cleared);
  return false;
}

export async function clearBusinessMcpRocketChat(): Promise<boolean> {
  updateCredentialState('rocket-chat', false);
  return invokeBestEffort('business_mcp_clear_rocket_chat');
}

export async function clearBusinessMcpAzureDevOps(): Promise<boolean> {
  updateCredentialState('azure-devops', false);
  const cleared = await invokeBestEffort('business_mcp_clear_azure_devops');
  updateCredentialState('azure-devops', cleared);
  return cleared;
}

export async function syncBusinessMcpAzureDevOps(input: {
  collectionUrl?: string;
  authMode?: string;
  pat?: string;
  allowInsecureAdoHttp?: boolean;
}): Promise<boolean> {
  if (!input.collectionUrl?.trim()) return clearBusinessMcpAzureDevOps();
  if (
    input.authMode
    && !['ntlm', 'default-credentials', 'pat'].includes(input.authMode)
  ) {
    return clearBusinessMcpAzureDevOps();
  }
  updateCredentialState('azure-devops', false);
  const synced = await invokeBestEffort('business_mcp_sync_azure_devops', {
    collectionUrl: input.collectionUrl,
    authMode: input.authMode,
    pat: input.pat,
    allowInsecureAdoHttp: input.allowInsecureAdoHttp === true,
  });
  if (synced) {
    updateCredentialState('azure-devops', true);
    return true;
  }
  // 与 Rocket.Chat 侧一致：同步失败但清空成功即为干净状态，不因此把
  // rocketx_* 房间数据工具一并挡在会话外。
  const cleared = await invokeBestEffort('business_mcp_clear_azure_devops');
  updateCredentialState('azure-devops', cleared);
  return false;
}

export function businessMcpCredentialRevision(): number {
  return credentialRevision;
}

export function setBusinessMcpLaunchConfigProvider(
  provider: LaunchConfigProvider,
): () => void {
  const previous = launchConfigProvider;
  launchConfigProvider = provider;
  launchConfigPromise = null;
  return () => {
    launchConfigProvider = previous;
    launchConfigPromise = null;
  };
}

export function setBusinessMcpCommandInvoker(invoker: CommandInvoker): () => void {
  const previous = {
    commandInvoker,
    credentialGateRequired,
    rocketChatCredentialReady,
    azureDevOpsCredentialReady,
  };
  commandInvoker = invoker;
  credentialGateRequired = true;
  updateCredentialState('rocket-chat', false);
  updateCredentialState('azure-devops', false);
  return () => {
    commandInvoker = previous.commandInvoker;
    credentialGateRequired = previous.credentialGateRequired;
    rocketChatCredentialReady = previous.rocketChatCredentialReady;
    azureDevOpsCredentialReady = previous.azureDevOpsCredentialReady;
    credentialRevision += 1;
  };
}

registerBusinessMcpLifecyclePort({
  syncRocketChat: syncBusinessMcpRocketChat,
  clearRocketChat: clearBusinessMcpRocketChat,
  syncAzureDevOps: syncBusinessMcpAzureDevOps,
  clearAzureDevOps: clearBusinessMcpAzureDevOps,
});
