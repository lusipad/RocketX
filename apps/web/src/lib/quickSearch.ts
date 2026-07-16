import type { RcMessage } from '@rcx/rc-client';

export interface MessageSearchBackend {
  provider: () => Promise<unknown>;
  global: (keyword: string) => Promise<unknown>;
  room: (rid: string, keyword: string) => Promise<RcMessage[]>;
}

const FALLBACK_CONCURRENCY = 2;
const MAX_MESSAGE_RESULTS = 20;
const MESSAGE_SEARCH_CACHE_TTL_MS = 30_000;
const MESSAGE_SEARCH_CACHE_MAX = 20;

interface MessageSearchCacheEntry {
  expiresAt: number;
  messages: RcMessage[];
}

const messageSearchCache = new Map<string, MessageSearchCacheEntry>();

export type QuickSearchTab = 'all' | 'convs' | 'messages' | 'files' | 'contacts' | 'work';

export const QUICK_SEARCH_TABS: QuickSearchTab[] = ['all', 'convs', 'messages', 'files', 'contacts', 'work'];
export const QUICK_SEARCH_RESULT_SECTIONS = ['contacts', 'convs', 'messages', 'files', 'work'] as const;

export function chooseAvailableSearchTab(
  current: QuickSearchTab,
  counts: Record<QuickSearchTab, number>,
): QuickSearchTab {
  if (counts[current] > 0) return current;
  return (['convs', 'messages', 'files', 'contacts', 'work'] as const).find((tab) => counts[tab] > 0) ?? current;
}

export function searchesSettledFor(
  keyword: string,
  messageKeyword: string,
  contactKeyword: string,
): boolean {
  const current = keyword.trim();
  return !!current && messageKeyword === current && contactKeyword === current;
}

/** 短时复用同一服务器、账号和会话范围的成功搜索，避免反复逐房间请求。 */
export async function searchMessagesCached(
  key: string,
  load: () => Promise<RcMessage[]>,
  isCurrent: () => boolean = () => true,
  now: () => number = Date.now,
): Promise<RcMessage[]> {
  const cached = messageSearchCache.get(key);
  if (cached && cached.expiresAt > now()) {
    messageSearchCache.delete(key);
    messageSearchCache.set(key, cached);
    return cached.messages;
  }
  if (cached) messageSearchCache.delete(key);

  const messages = await load();
  if (!isCurrent()) return messages;

  messageSearchCache.set(key, {
    expiresAt: now() + MESSAGE_SEARCH_CACHE_TTL_MS,
    messages,
  });
  while (messageSearchCache.size > MESSAGE_SEARCH_CACHE_MAX) {
    const oldest = messageSearchCache.keys().next().value;
    if (oldest === undefined) break;
    messageSearchCache.delete(oldest);
  }
  return messages;
}

export function clearMessageSearchCache(): void {
  messageSearchCache.clear();
}

/**
 * 跨会话消息搜索：服务端已启用全局搜索时以它为准；否则逐房间回退。
 *
 * 已启用全局搜索时，空数组同样是完整结果。未启用时按最近会话顺序低并发搜索，
 * 收集到界面所需的结果数后停止，避免一次性并发请求全部房间。
 */
export async function searchMessagesGlobal(
  keyword: string,
  recentRids: string[],
  backend: MessageSearchBackend,
  isCurrent: () => boolean = () => true,
): Promise<RcMessage[]> {
  try {
    const provider = (await backend.provider()) as {
      settings?: { GlobalSearchEnabled?: boolean };
    } | undefined;
    if (!provider || provider.settings?.GlobalSearchEnabled === false) {
      throw new Error('global search disabled');
    }
    const result = (await backend.global(keyword)) as {
      message?: { docs?: RcMessage[] };
    };
    const docs = result?.message?.docs;
    if (Array.isArray(docs)) return docs;
  } catch {
    /* 服务器未开全局搜索时回退 */
  }

  if (!isCurrent()) return [];

  const messages: RcMessage[] = [];
  for (let i = 0; i < recentRids.length; i += FALLBACK_CONCURRENCY) {
    if (!isCurrent()) return [];
    const batch = await Promise.all(
      recentRids.slice(i, i + FALLBACK_CONCURRENCY).map((rid) => backend.room(rid, keyword)),
    );
    messages.push(...batch.flat());
    if (messages.length >= MAX_MESSAGE_RESULTS) return messages.slice(0, MAX_MESSAGE_RESULTS);
  }
  return messages;
}
