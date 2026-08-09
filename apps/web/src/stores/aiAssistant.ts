import { create } from 'zustand';
import { runCodexAutomation } from '../agent/codexAutomation';
import { collectUnreadHistory } from '../lib/unreadHistory';
import { rest } from '../lib/client';
import { useChat } from './chat';
import { useCodexWorkspace } from './codexWorkspace';

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
      const room = chat.rooms[rid];
      const roomName = subscription.fname || subscription.name || room?.fname || room?.name || rid;
      const codex = useCodexWorkspace.getState();
      const result = await runCodexAutomation({
        workspaceRoot: codex.workspaceRoot,
        model: codex.selectedModel || undefined,
        effort: codex.selectedEffort,
        skillName: 'room-digest',
        name: `总结 ${roomName}`,
        text: [
          '$room-digest',
          `房间：${roomName}`,
          `时间范围：${subscription.ls || '今天开始'} 至 ${new Date().toISOString()}`,
          '这是用户在会话总结面板发起的真实查询。请按 Skill 实时读取房间消息，不使用 UI 缓存或猜测。',
        ].join('\n'),
      });
      if (revision === summaryRevision) set({ content: result.text, status: 'done' });
    } catch (error) {
      if (revision === summaryRevision) {
        set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }
  },
}));
