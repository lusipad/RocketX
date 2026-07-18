import type { AppServerClient } from './protocol';
import type { ExternalAgentConfigImportCompletedNotification } from './protocol/generated/v2/ExternalAgentConfigImportCompletedNotification';

/** 导入完成通知的等待者与提前到达缓冲（通知可能先于请求响应到达） */
const importWaiters = new Map<string, (result: ExternalAgentConfigImportCompletedNotification) => void>();
const completedImports = new Map<string, ExternalAgentConfigImportCompletedNotification>();

/** 各 app-server 客户端在 onNotification 里把 import/completed 交到这里 */
export function dispatchCodexImportCompleted(params: unknown): void {
  const payload = params as ExternalAgentConfigImportCompletedNotification;
  if (typeof payload?.importId !== 'string') return;
  const waiter = importWaiters.get(payload.importId);
  if (waiter) {
    importWaiters.delete(payload.importId);
    waiter(payload);
  } else {
    completedImports.set(payload.importId, payload);
  }
}

/**
 * 把已写盘的会话 JSONL 经官方外部 Agent 导入器导入 Codex，生成一条
 * App 认可来源的原生线程（app-server 直接创建的线程 source 是
 * appServer，Codex App 的会话列表默认只显示交互来源）。
 * 等待 import/completed 并核对成败；导入产物是快照副本。
 */
export async function importSessionFileToCodex(
  client: AppServerClient,
  options: { path: string; cwd: string; title: string },
): Promise<void> {
  const response = await client.request('externalAgentConfig/import', {
    migrationItems: [
      {
        itemType: 'SESSIONS',
        description: 'Transfer RocketX conversation',
        cwd: null,
        details: {
          plugins: [],
          skills: [],
          sessions: [{ path: options.path, cwd: options.cwd, title: options.title }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: [],
        },
      },
    ],
  });
  const buffered = completedImports.get(response.importId);
  completedImports.delete(response.importId);
  const result = buffered ?? await new Promise<ExternalAgentConfigImportCompletedNotification>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        importWaiters.delete(response.importId);
        reject(new Error('Codex 导入超时，请稍后重试'));
      }, 30_000);
      importWaiters.set(response.importId, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    },
  );
  const sessions = result.itemTypeResults.find((item) => item.itemType === 'SESSIONS');
  const failure = sessions?.failures[0];
  if (!sessions || failure || sessions.successes.length === 0) {
    throw new Error(failure?.message ?? 'Codex 未接受这份对话导入');
  }
}
