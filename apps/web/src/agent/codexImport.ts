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
 * 转移会话写进 Claude Code 标准会话根（~/.claude/projects/rocketx-transfers/）。
 * codex 的外部会话导入器只探测该布局，写在应用自己的附件目录会被判
 * session_missing——这正是「转到 Codex 无效」的根因（issue #99）。
 * 路径由 Rust 端拼装，这里只传 UUID 与内容。
 */
export async function writeCodexTransferSession(
  sessionUuid: string,
  content: string,
): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('codex_transfer_session_write', { sessionUuid, content });
}

/** 导入完成后清走源文件，避免它出现在 Claude Code 自己的会话列表里 */
export async function cleanupCodexTransferSession(sessionUuid: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('codex_transfer_session_cleanup', { sessionUuid }).catch(() => undefined);
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
