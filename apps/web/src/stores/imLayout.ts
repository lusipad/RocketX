import { create } from 'zustand';
import { getServerBase } from '../lib/client';
import {
  DEFAULT_CONVERSATION_WIDTH,
  clampConversationWidth,
  defaultImLayout,
  imLayoutStorageKey,
  parseImLayout,
  type ImLayoutStateV1,
} from '../lib/imLayout';

interface ImLayoutStore {
  ownerId: string | null;
  ownerServer: string | null;
  layout: ImLayoutStateV1;
  hydrate: (userId: string) => void;
  setConversationWidth: (width: number) => void;
  resetConversationWidth: () => void;
  setGroupCollapsed: (collapsed: boolean) => void;
}

function persist(server: string, ownerId: string, layout: ImLayoutStateV1): void {
  try {
    localStorage.setItem(imLayoutStorageKey(server, ownerId), JSON.stringify(layout));
  } catch {
    /* 存储不可用时仅保留当前会话状态 */
  }
}

export const useImLayout = create<ImLayoutStore>((set, get) => ({
  ownerId: null,
  ownerServer: null,
  layout: defaultImLayout(),

  hydrate: (userId) => {
    const server = getServerBase();
    if (get().ownerId === userId && get().ownerServer === server) return;
    let layout = defaultImLayout();
    try {
      layout = parseImLayout(
        localStorage.getItem(imLayoutStorageKey(server, userId)),
      );
    } catch {
      /* 使用默认布局 */
    }
    set({ ownerId: userId, ownerServer: server, layout });
  },

  setConversationWidth: (width) => {
    const { ownerId, ownerServer, layout } = get();
    const next = { ...layout, conversationWidth: clampConversationWidth(width) };
    if (ownerId && ownerServer !== null) persist(ownerServer, ownerId, next);
    set({ layout: next });
  },

  resetConversationWidth: () => get().setConversationWidth(DEFAULT_CONVERSATION_WIDTH),

  setGroupCollapsed: (groupCollapsed) => {
    const { ownerId, ownerServer, layout } = get();
    const next = { ...layout, groupCollapsed };
    if (ownerId && ownerServer !== null) persist(ownerServer, ownerId, next);
    set({ layout: next });
  },
}));
