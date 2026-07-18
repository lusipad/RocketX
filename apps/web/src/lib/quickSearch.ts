import { tsMs, type RcMessage } from '@rcx/rc-client';
import { stripAgentSessionMarker } from '../agent/card';

export interface MessageSearchBackend {
  provider: () => Promise<unknown>;
  global: (keyword: string, limit: number, searchAll: boolean) => Promise<unknown>;
  room: (rid: string, keyword: string, offset: number, count: number) => Promise<RcMessage[]>;
}

export interface MessageSearchOptions {
  searchAll?: boolean;
}

const FALLBACK_CONCURRENCY = 2;
export const MESSAGE_SEARCH_PAGE_SIZE = 20;
const MESSAGE_SEARCH_CACHE_TTL_MS = 30_000;
const MESSAGE_SEARCH_CACHE_MAX = 5;
const MESSAGE_SEARCH_CACHE_RESULT_MAX = 200;

export type MessageSearchSource = 'global' | 'rooms';

export interface MessageSearchPage {
  messages: RcMessage[];
  source: MessageSearchSource;
  page: number;
  hasMore: boolean;
}

interface MessageSearchCacheEntry {
  expiresAt: number;
  result: MessageSearchPage;
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
  load: () => Promise<MessageSearchPage>,
  isCurrent: () => boolean = () => true,
  now: () => number = Date.now,
): Promise<MessageSearchPage> {
  const cached = messageSearchCache.get(key);
  if (cached && cached.expiresAt > now()) {
    messageSearchCache.delete(key);
    messageSearchCache.set(key, cached);
    return cached.result;
  }
  if (cached) messageSearchCache.delete(key);

  const result = await load();
  if (!isCurrent()) return result;
  if (result.messages.length > MESSAGE_SEARCH_CACHE_RESULT_MAX) return result;

  messageSearchCache.set(key, {
    expiresAt: now() + MESSAGE_SEARCH_CACHE_TTL_MS,
    result,
  });
  while (messageSearchCache.size > MESSAGE_SEARCH_CACHE_MAX) {
    const oldest = messageSearchCache.keys().next().value;
    if (oldest === undefined) break;
    messageSearchCache.delete(oldest);
  }
  return result;
}

export function clearMessageSearchCache(): void {
  messageSearchCache.clear();
}

export function mergeMessageSearchResults(...groups: readonly RcMessage[][]): RcMessage[] {
  const unique = new Map<string, RcMessage>();
  for (const messages of groups) {
    for (const message of messages) unique.set(message._id, message);
  }
  return [...unique.values()]
    .sort((a, b) => tsMs(b.ts) - tsMs(a.ts));
}

function attachmentSearchText(
  attachments: RcMessage['attachments'],
): string {
  if (!attachments?.length) return '';
  return attachments
    .flatMap((attachment) => [
      attachment.title,
      attachment.text,
      attachment.description,
      ...(attachment.fields ?? []).flatMap((field) => [field.title, field.value]),
      attachmentSearchText(attachment.attachments),
    ])
    .filter(Boolean)
    .join('\n');
}

/** 先搜索已经加载到内存的消息，让用户不必等远端完整历史扫描结束。 */
export function searchLoadedMessages(
  keyword: string,
  messagesByRoom: Readonly<Record<string, readonly RcMessage[]>>,
  canSearchRoom: (rid: string) => boolean = () => true,
): RcMessage[] {
  const query = keyword.trim().toLocaleLowerCase();
  if (!query) return [];
  const matches: RcMessage[] = [];
  for (const [rid, messages] of Object.entries(messagesByRoom)) {
    if (!canSearchRoom(rid)) continue;
    for (const message of messages) {
      const text = [
        stripAgentSessionMarker(message.msg),
        message.file?.name,
        attachmentSearchText(message.attachments),
      ]
        .filter(Boolean)
        .join('\n')
        .toLocaleLowerCase();
      if (text.includes(query)) matches.push(message);
    }
  }
  return mergeMessageSearchResults(matches).slice(0, MESSAGE_SEARCH_PAGE_SIZE);
}

async function searchRoomMessagePage(
  keyword: string,
  recentRids: string[],
  page: number,
  backend: MessageSearchBackend,
  isCurrent: () => boolean,
  onProgress: (result: MessageSearchPage) => void,
): Promise<MessageSearchPage> {
  let messages: RcMessage[] = [];
  let hasMore = false;
  const offset = page * MESSAGE_SEARCH_PAGE_SIZE;
  for (let i = 0; i < recentRids.length; i += FALLBACK_CONCURRENCY) {
    if (!isCurrent()) {
      return { messages: [], source: 'rooms', page, hasMore: false };
    }
    const batch = await Promise.all(
      recentRids.slice(i, i + FALLBACK_CONCURRENCY).map((rid) =>
        backend.room(rid, keyword, offset, MESSAGE_SEARCH_PAGE_SIZE),
      ),
    );
    hasMore ||= batch.some((roomMessages) => roomMessages.length === MESSAGE_SEARCH_PAGE_SIZE);
    messages = mergeMessageSearchResults(messages, batch.flat());
    if (isCurrent()) onProgress({ messages, source: 'rooms', page, hasMore });
  }
  return { messages, source: 'rooms', page, hasMore };
}

/**
 * 消息搜索：默认可限制在当前会话；用户显式搜索全部时才跨会话查询。
 *
 * 搜索全部且服务端已启用全局搜索时，空数组同样是完整结果。未启用时低并发搜索传入会话，
 * 每批只保留最新 20 条候选并回报进度，保证历史搜索范围完整且内存占用有界。
 */
export async function searchMessagesGlobal(
  keyword: string,
  recentRids: string[],
  backend: MessageSearchBackend,
  isCurrent: () => boolean = () => true,
  onProgress: (result: MessageSearchPage) => void = () => {},
  options: MessageSearchOptions = {},
): Promise<MessageSearchPage> {
  const searchAll = options.searchAll ?? true;
  try {
    const provider = (await backend.provider()) as {
      settings?: { GlobalSearchEnabled?: boolean };
    } | undefined;
    if (!provider || (searchAll && provider.settings?.GlobalSearchEnabled === false)) {
      throw new Error('global search disabled');
    }
    const result = (await backend.global(keyword, MESSAGE_SEARCH_PAGE_SIZE, searchAll)) as {
      message?: { docs?: RcMessage[] };
    };
    const docs = result?.message?.docs;
    if (Array.isArray(docs)) {
      const messages = mergeMessageSearchResults(docs);
      return {
        messages,
        source: 'global',
        page: 0,
        hasMore: docs.length === MESSAGE_SEARCH_PAGE_SIZE,
      };
    }
  } catch {
    /* 服务器未开全局搜索时回退 */
  }

  if (!isCurrent()) {
    return { messages: [], source: 'rooms', page: 0, hasMore: false };
  }

  return searchRoomMessagePage(keyword, recentRids, 0, backend, isCurrent, onProgress);
}

/** 已有首批结果后继续加载下一页；全局提供器扩大 limit，逐房间回退使用 offset。 */
export async function searchMoreMessages(
  keyword: string,
  recentRids: string[],
  source: MessageSearchSource,
  page: number,
  backend: MessageSearchBackend,
  isCurrent: () => boolean = () => true,
  onProgress: (result: MessageSearchPage) => void = () => {},
  options: MessageSearchOptions = {},
): Promise<MessageSearchPage> {
  if (source === 'rooms') {
    return searchRoomMessagePage(keyword, recentRids, page, backend, isCurrent, onProgress);
  }

  const limit = (page + 1) * MESSAGE_SEARCH_PAGE_SIZE;
  const result = (await backend.global(keyword, limit, options.searchAll ?? true)) as {
    message?: { docs?: RcMessage[] };
  };
  const docs = result?.message?.docs;
  if (!Array.isArray(docs)) throw new Error('global search returned no messages');
  return {
    messages: mergeMessageSearchResults(docs),
    source: 'global',
    page,
    hasMore: docs.length === limit,
  };
}
