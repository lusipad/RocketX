import { invoke } from '@tauri-apps/api/core';
import { kernelStore } from '../kernel/store';
import { isTauri } from './http';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';

interface CodexExecResult {
  text: string;
  threadId?: string;
}

export async function runCodexTrigger(context: {
  rid: string;
  text: string;
  tmid?: string;
}): Promise<void> {
  const prompt = context.text.replace(/^\$codex(?:\s+|$)/i, '').trim();
  if (!prompt) throw new Error('$codex 后面需要写问题或粘贴日志');
  if (!isTauri) throw new Error('$codex 仅支持 RocketX 桌面端');
  const startedAt = Date.now();
  toast.info('Codex 正在分析，结果会发回当前会话');
  try {
    const result = await invoke<CodexExecResult>('codex_exec_once', { prompt });
    await useChat.getState().send(`🤖 **Codex**\n\n${result.text}`, {
      rid: context.rid,
      ...(context.tmid ? { tmid: context.tmid } : {}),
    });
    await kernelStore.audit.append({
      appId: 'rocketx.agent',
      action: 'agent.codex.once',
      allowed: true,
      durationMs: Date.now() - startedAt,
      ...(result.threadId ? { threadId: result.threadId } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await kernelStore.audit.append({
      appId: 'rocketx.agent',
      action: 'agent.codex.once',
      allowed: false,
      durationMs: Date.now() - startedAt,
      reason,
    });
    throw error;
  }
}
