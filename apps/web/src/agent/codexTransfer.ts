import type { AppServerClient } from './protocol';
import { isTauri } from '../lib/http';

/** 待转移的对话行（结构化定义，避免依赖 butler store 造成环） */
export interface TransferLine {
  role: 'user' | 'assistant';
  text: string;
}

/** 托管会话里的一条消息：谁说的、是不是 Codex 的回复 */
export interface AgentTransferMessage {
  text: string;
  author: string;
  assistant: boolean;
}

export function codexThreadDeepLink(threadId: string): string {
  const id = threadId.trim();
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new Error('Codex threadId 无效');
  return `codex://threads/${encodeURIComponent(id)}`;
}

export async function openCodexThread(
  threadId: string,
): Promise<'opened' | 'copied' | 'unavailable'> {
  const url = codexThreadDeepLink(threadId);
  try {
    if (isTauri) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } else {
      window.location.assign(url);
    }
    return 'opened';
  } catch {
    try {
      await navigator.clipboard.writeText(`codex resume ${threadId}`);
      return 'copied';
    } catch {
      return 'unavailable';
    }
  }
}

/**
 * 托管会话消息 → 转移对话行：Codex 回复作 assistant，成员发言作 user
 * 并带上说话人前缀（多人群聊导入后才分得清谁说的）。
 */
export function agentConversationLines(
  messages: readonly AgentTransferMessage[],
): TransferLine[] {
  return messages
    .filter((message) => !!message.text.trim())
    .map((message) =>
      message.assistant
        ? { role: 'assistant' as const, text: message.text }
        : { role: 'user' as const, text: `${message.author}：${message.text}` },
    );
}

/**
 * 把对话渲染成转移线程的首轮输入。转移走的是 companion 同款机制——
 * 原生 thread/start + thread/name/set，对话记录作为首条消息进线程，
 * 在 Codex App / CLI 的会话列表里直接可见、可接续（issue #105）。
 * 📌 记忆标记行与首个用户消息之前的开场白不转移。
 */
/**
 * companion 同款的转移线程创建:thread/start + thread/name/set +
 * 记录作为首轮输入。老 CLI 没有 thread/name/set 时照 companion 的
 * 做法忽略(名字丢了线程仍可用);只要一句确认,用最低推理档,
 * 不等模型说完——turn 受理那一刻线程已带着完整记录进了会话列表。
 */
export async function startNamedCodexThreadWithTranscript(
  client: AppServerClient,
  options: { cwd: string; name: string; transcript: string; model?: string },
): Promise<string> {
  const response = await client.request('thread/start', {
    ...(options.model ? { model: options.model } : {}),
    cwd: options.cwd,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
  });
  const threadId = response.thread.id;
  try {
    await client.request('thread/name/set', { threadId, name: options.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unknown (variant|method)/i.test(message)) throw error;
  }
  await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: options.transcript, text_elements: [] }],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    effort: 'minimal',
  });
  return threadId;
}

export function transferTranscript(
  kind: string,
  lines: readonly TransferLine[],
): string {
  const firstUser = lines.findIndex((item) => item.role === 'user');
  const usable = (firstUser === -1 ? [] : lines.slice(firstUser)).filter(
    (item) => !!item.text.trim() && !item.text.startsWith('📌'),
  );
  if (usable.length === 0) throw new Error('还没有可转移的对话内容');
  const body = usable
    .map((item) => `${item.role === 'user' ? '【用户】' : '【助手】'}\n${item.text}`)
    .join('\n\n');
  return [
    `以下是从 RocketX 转移过来的${kind}完整记录，请作为上下文接续：`,
    '',
    body,
    '',
    '———',
    '请只回复一句话确认已接收，不要开始任何任务；等待用户在这个会话里继续。',
  ].join('\n');
}
