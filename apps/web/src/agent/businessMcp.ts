import type { JsonValue } from './protocol/generated/serde_json/JsonValue';
import { isTauri } from '../lib/http';

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
    const timer = setTimeout(() => reject(new Error('业务 MCP 本地配置读取超时')), timeoutMs);
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
    throw new Error('业务 MCP 启动配置无效');
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

export async function businessMcpThreadConfig(
  current?: ThreadConfig | null,
): Promise<ThreadConfig | undefined> {
  if (!credentialsReady()) return current ?? undefined;
  const launch = await loadLaunchConfig();
  if (!launch) return current ?? undefined;
  return mergeBusinessMcpConfig(current, launch);
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
  if (!synced) {
    await invokeBestEffort('business_mcp_clear_rocket_chat');
    return false;
  }
  updateCredentialState('rocket-chat', true);
  return true;
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
  if (!synced) {
    await invokeBestEffort('business_mcp_clear_azure_devops');
    return false;
  }
  updateCredentialState('azure-devops', true);
  return true;
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
