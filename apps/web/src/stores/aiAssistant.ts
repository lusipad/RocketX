import { tsMs } from '@rcx/rc-client';
import { create } from 'zustand';
import { t } from '../i18n';
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
      if (!subscription) throw new Error(t('butler.summary.onlyJoined'));
      const unread = await collectUnreadHistory(
        { rid, type: subscription.t, lastSeen: subscription.ls, maxPages: 20 },
        (roomId, type, count, latest) => rest.getHistory(roomId, type, count, latest),
      );
      if (revision !== summaryRevision) return;
      const messages = unread.messages.length ? unread.messages : (chat.messages[rid] ?? []).slice(-200);
      if (!messages.length) throw new Error(t('butler.summary.noMessages'));
      set({ messageCount: messages.length, truncated: unread.truncated });
      const room = chat.rooms[rid];
      const roomName = subscription.fname || subscription.name || room?.fname || room?.name || rid;
      const lastSeenMs = tsMs(subscription.ls);
      const fromRange = typeof subscription.ls === 'string'
        ? subscription.ls
        : lastSeenMs
          ? new Date(lastSeenMs).toISOString()
          : t('butler.summary.sinceStart');
      const codex = useCodexWorkspace.getState();
      const result = await runCodexAutomation({
        workspaceRoot: codex.workspaceRoot,
        model: codex.selectedModel || undefined,
        effort: codex.selectedEffort,
        skillName: 'room-digest',
        name: t('butler.summary.taskTitle', { roomName }),
        text: [
          '$room-digest',
          t('butler.summary.promptRoom', { roomName }),
          t('butler.summary.promptRange', { from: fromRange, to: new Date().toISOString() }),
          t('butler.summary.promptNote'),
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
