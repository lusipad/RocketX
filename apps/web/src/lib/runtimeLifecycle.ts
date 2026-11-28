export type BusinessMcpRocketChatInput = {
  serverUrl: string;
  userId: string;
  authToken: string;
};

export type BusinessMcpAzureDevOpsInput = {
  collectionUrl?: string;
  authMode?: string;
  pat?: string;
  allowInsecureAdoHttp?: boolean;
};

export interface BusinessMcpLifecyclePort {
  syncRocketChat: (input: BusinessMcpRocketChatInput) => Promise<boolean>;
  clearRocketChat: () => Promise<boolean>;
  syncAzureDevOps: (input: BusinessMcpAzureDevOpsInput) => Promise<boolean>;
  clearAzureDevOps: () => Promise<boolean>;
}

let businessMcpPort: BusinessMcpLifecyclePort | null = null;
const shutdownHooks = new Map<string, () => Promise<void> | void>();

/** 由 AI 运行时适配层注册业务 MCP 同步实现，避免 auth / workbench 反向依赖上层 Agent。 */
export function registerBusinessMcpLifecyclePort(port: BusinessMcpLifecyclePort): () => void {
  businessMcpPort = port;
  return () => {
    if (businessMcpPort === port) businessMcpPort = null;
  };
}

export async function lifecycleSyncBusinessMcpRocketChat(
  input: BusinessMcpRocketChatInput,
): Promise<boolean> {
  return businessMcpPort ? businessMcpPort.syncRocketChat(input) : false;
}

export async function lifecycleClearBusinessMcpRocketChat(): Promise<boolean> {
  return businessMcpPort ? businessMcpPort.clearRocketChat() : false;
}

export async function lifecycleSyncBusinessMcpAzureDevOps(
  input: BusinessMcpAzureDevOpsInput,
): Promise<boolean> {
  return businessMcpPort ? businessMcpPort.syncAzureDevOps(input) : false;
}

export async function lifecycleClearBusinessMcpAzureDevOps(): Promise<boolean> {
  return businessMcpPort ? businessMcpPort.clearAzureDevOps() : false;
}

/** 由 kernel / lan / butler 运行时模块注册清理回调，供账号切换或登出时统一停机。 */
export function registerUserRuntimeShutdownHook(
  key: string,
  hook: () => Promise<void> | void,
): () => void {
  shutdownHooks.set(key, hook);
  return () => {
    if (shutdownHooks.get(key) === hook) shutdownHooks.delete(key);
  };
}

export async function runUserRuntimeShutdownHooks(): Promise<void> {
  await Promise.all(
    [...shutdownHooks.values()].map((hook) =>
      Promise.resolve()
        .then(() => hook())
        .catch(() => undefined),
    ),
  );
}
