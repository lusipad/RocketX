import { create } from 'zustand';
import { getAiBus } from '../kernel/ai/runtime';
import { collectUnreadHistory } from '../lib/unreadHistory';
import { rest } from '../lib/client';
import { useChat } from './chat';

interface SummaryState {
  rid: string | null;
  status: 'idle' | 'loading' | 'done' | 'error';
  content: string;
  reasoning: string;
  messageCount: number;
  truncated: boolean;
  error: string | null;
  summarize: (rid: string) => Promise<void>;
}

let summaryRevision = 0;

function summaryContext(messages: Array<{ u: { name?: string; username: string }; msg: string }>): string {
  const selected: string[] = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const line = `${message.u.name || message.u.username}: ${message.msg}`;
    if (selected.length && chars + line.length > 120_000) break;
    selected.push(line);
    chars += line.length;
  }
  return selected.reverse().join('\n');
}

export const useAiAssistant = create<SummaryState>((set) => ({
  rid: null,
  status: 'idle',
  content: '',
  reasoning: '',
  messageCount: 0,
  truncated: false,
  error: null,

  summarize: async (rid) => {
    const revision = ++summaryRevision;
    set({ rid, status: 'loading', content: '', reasoning: '', messageCount: 0, truncated: false, error: null });
    try {
      const chat = useChat.getState();
      const subscription = chat.subscriptions[rid];
      if (!subscription) throw new Error('只能总结已加入的会话');
      const unread = await collectUnreadHistory(
        { rid, type: subscription.t, lastSeen: subscription.ls, maxPages: 20 },
        (roomId, type, count, latest) => rest.getHistory(roomId, type, count, latest),
      );
      if (revision !== summaryRevision) return;
      const messages = unread.messages.length ? unread.messages : (chat.messages[rid] ?? []).slice(-200);
      if (!messages.length) throw new Error('当前会话没有可总结的消息');
      set({ messageCount: messages.length, truncated: unread.truncated });
      const context = summaryContext(messages);
      for await (const chunk of getAiBus().chat('summary', {
        messages: [
          {
            role: 'system',
            content: '你是 RocketX 的会话总结助手。只依据给定聊天记录，用中文输出：一句话结论、关键进展、明确决定、待办与负责人、仍未解决的问题。不要猜测；没有的栏目写“无”。',
          },
          { role: 'user', content: `请总结以下 ${messages.length} 条聊天记录：\n\n${context}` },
        ],
        thinking: 'disabled',
        maxTokens: 1600,
      })) {
        if (revision !== summaryRevision) return;
        if (chunk.content) set((state) => ({ content: state.content + chunk.content }));
        if (chunk.reasoning) set((state) => ({ reasoning: state.reasoning + chunk.reasoning }));
      }
      if (revision === summaryRevision) set({ status: 'done' });
    } catch (error) {
      if (revision === summaryRevision) {
        set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }
  },
}));
