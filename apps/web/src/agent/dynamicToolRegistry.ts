import type { DynamicToolSpec } from './protocol/generated/v2/DynamicToolSpec';

export interface HostDynamicToolProvider {
  getTools: () => DynamicToolSpec[];
  executeTool: (params: unknown) => Promise<unknown> | unknown;
}

let activeProvider: HostDynamicToolProvider | null = null;

/**
 * 宿主动态工具注册表（DP_9 抽象接口）。
 * `AppServerController` 仅依赖该轻量合同，具体的记忆/待办/日历/GitHub 工具实现由上层 `codexHostTools` 注入。
 */
export function registerHostDynamicToolProvider(provider: HostDynamicToolProvider): () => void {
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) activeProvider = null;
  };
}

export function getRegisteredDynamicTools(): DynamicToolSpec[] {
  return activeProvider ? activeProvider.getTools() : [];
}

export async function executeRegisteredDynamicTool(params: unknown): Promise<unknown> {
  if (!activeProvider) {
    throw new Error('Host dynamic tool provider is not registered');
  }
  return activeProvider.executeTool(params);
}
