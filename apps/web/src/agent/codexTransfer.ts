import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../lib/http';

const MAX_EXTERNAL_URL_LENGTH = 8192;

export type CodexHandoffResult = 'opened' | 'opened-with-copy' | 'copied' | 'unavailable';

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

export function codexNewThreadDeepLink(prompt: string, path: string): string {
  const query = new URLSearchParams();
  if (prompt) query.set('prompt', prompt);
  if (path.trim()) query.set('path', path.trim());
  if ([...query].length === 0) throw new Error('Codex 新对话缺少上下文和工作区');
  return `codex://threads/new?${query.toString()}`;
}

async function openCodexUrl(url: string): Promise<void> {
  if (isTauri) {
    await invoke('open_external_url', { url });
  } else {
    window.location.assign(url);
  }
}

async function copyCodexPrompt(prompt: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(prompt);
    return true;
  } catch {
    return false;
  }
}

/**
 * 使用 Codex App 官方 deep link 打开由 App 自己拥有的新对话。
 * deep link 只预填输入框，不替用户发送；过长记录完整复制到剪贴板，
 * 同时打开正确工作区，避免 URL 上限导致静默截断。
 */
export async function openCodexNewThread(
  prompt: string,
  path: string,
): Promise<CodexHandoffResult> {
  const url = codexNewThreadDeepLink(prompt, path);
  if (url.length > MAX_EXTERNAL_URL_LENGTH) {
    if (!(await copyCodexPrompt(prompt))) return 'unavailable';
    try {
      await openCodexUrl(codexNewThreadDeepLink('', path));
      return 'opened-with-copy';
    } catch {
      return 'copied';
    }
  }
  try {
    await openCodexUrl(url);
    return 'opened';
  } catch {
    return (await copyCodexPrompt(prompt)) ? 'copied' : 'unavailable';
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
    '请接续以上上下文：如果最后一个用户请求包含尚未完成的明确任务，直接继续执行；否则简要确认已接收并等待用户下一步。',
  ].join('\n');
}
