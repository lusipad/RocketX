import { create } from 'zustand';
import type { RcMessage } from '@rcx/rc-client';
import { getServerBase, rest } from '../lib/client';
import { collectMentionInbox, type MentionItem } from '../lib/mentionInbox';
import { kernelStore } from '../kernel/store';
import { useAuth } from './auth';
import { useChat } from './chat';

interface PersistedTodayState {
  mentions: MentionItem[];
  processed: string[];
}

interface TodayState {
  scope: string;
  mentions: MentionItem[];
  processed: Set<string>;
  warnings: string[];
  loading: boolean;
  loaded: boolean;
  hydrate: () => Promise<void>;
  refreshMentions: () => Promise<void>;
  setProcessed: (key: string, value: boolean) => Promise<void>;
}

const APP_ID = 'rocketx.today';

function currentScope(): string {
  const userId = useAuth.getState().user?._id ?? 'guest';
  return `${getServerBase() || 'same-origin'}:${userId}`;
}

async function persist(scope: string, mentions: MentionItem[], processed: Set<string>): Promise<void> {
  await kernelStore.appData.set(APP_ID, scope, {
    mentions,
    processed: [...processed],
  } satisfies PersistedTodayState);
}

export const useToday = create<TodayState>((set, get) => ({
  scope: '',
  mentions: [],
  processed: new Set(),
  warnings: [],
  loading: false,
  loaded: false,

  hydrate: async () => {
    const scope = currentScope();
    if (get().loaded && get().scope === scope) return;
    set({ scope, mentions: [], processed: new Set(), warnings: [], loaded: false });
    const saved = await kernelStore.appData.get<PersistedTodayState>(APP_ID, scope);
    if (currentScope() !== scope) return;
    set({
      scope,
      mentions: saved?.mentions ?? [],
      processed: new Set(saved?.processed ?? []),
      loaded: true,
    });
  },

  refreshMentions: async () => {
    await get().hydrate();
    const scope = currentScope();
    const user = useAuth.getState().user;
    if (!user?.username) return;
    const rooms = Object.values(useChat.getState().subscriptions).map((subscription) => ({
      rid: subscription.rid,
      name: subscription.fname || subscription.name,
      userMentions: subscription.userMentions ?? 0,
    }));
    set({ loading: true, warnings: [] });
    try {
      const result = await collectMentionInbox(
        rooms,
        { _id: user._id, username: user.username },
        (rid, offset, count) => rest.getMentionedMessagesPage(rid, offset, count),
      );
      if (currentScope() !== scope) return;
      const merged = new Map<string, MentionItem>();
      for (const item of [...get().mentions, ...result.items]) merged.set(item.message._id, item);
      const mentions = [...merged.values()];
      set({ mentions, warnings: result.warnings });
      await persist(scope, mentions, get().processed);
    } finally {
      if (currentScope() === scope) set({ loading: false });
    }
  },

  setProcessed: async (key, value) => {
    const scope = currentScope();
    const processed = new Set(get().processed);
    if (value) processed.add(key);
    else processed.delete(key);
    set({ processed });
    await persist(scope, get().mentions, processed);
  },
}));

export function mentionMessage(item: MentionItem): RcMessage {
  return item.message;
}
