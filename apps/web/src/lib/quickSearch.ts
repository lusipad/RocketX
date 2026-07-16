import { tsMs, type RcMessage } from '@rcx/rc-client';

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

export function mergeMessageSearchResults(...groups: readonly RcMessage[][]): RcMessage[] {
  const unique = new Map<string, RcMessage>();
  for (const messages of groups) {
    for (const message of messages) unique.set(message._id, message);
  }
  return [...unique.values()]
    .sort((a, b) => tsMs(b.ts) - tsMs(a.ts))
    .slice(0, MAX_MESSAGE_RESULTS);
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
): RcMessage[] {
  const query = keyword.trim().toLocaleLowerCase();
  if (!query) return [];
  const matches: RcMessage[] = [];
  for (const messages of Object.values(messagesByRoom)) {
    for (const message of messages) {
      const text = [
        message.msg,
        message.file?.name,
        attachmentSearchText(message.attachments),
      ]
        .filter(Boolean)
        .join('\n')
        .toLocaleLowerCase();
      if (text.includes(query)) matches.push(message);
    }
  }
  return mergeMessageSearchResults(matches);
}

/**
 * 跨会话消息搜索：服务端已启用全局搜索时以它为准；否则逐房间回退。
 *
 * 已启用全局搜索时，空数组同样是完整结果。未启用时低并发搜索所有可访问会话，
 * 每批只保留最新 20 条候选并回报进度，保证历史搜索范围完整且内存占用有界。
 */
export async function searchMessagesGlobal(
  keyword: string,
  recentRids: string[],
  backend: MessageSearchBackend,
  isCurrent: () => boolean = () => true,
  onProgress: (messages: RcMessage[]) => void = () => {},
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
    if (Array.isArray(docs)) return mergeMessageSearchResults(docs);
  } catch {
    /* 服务器未开全局搜索时回退 */
  }

  if (!isCurrent()) return [];

  let messages: RcMessage[] = [];
  for (let i = 0; i < recentRids.length; i += FALLBACK_CONCURRENCY) {
    if (!isCurrent()) return [];
    const batch = await Promise.all(
      recentRids.slice(i, i + FALLBACK_CONCURRENCY).map((rid) => backend.room(rid, keyword)),
    );
    messages = mergeMessageSearchResults(messages, batch.flat());
    if (isCurrent()) onProgress(messages);
  }
  return messages;
}
