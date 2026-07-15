import type { RcMessage } from '@rcx/rc-client';

export interface MessageSearchBackend {
  global: (keyword: string) => Promise<unknown>;
  room: (rid: string, keyword: string) => Promise<RcMessage[]>;
}

const FALLBACK_ROOMS = 8;
const FALLBACK_CONCURRENCY = 2;

export type QuickSearchTab = 'all' | 'convs' | 'messages' | 'contacts' | 'work';

export const QUICK_SEARCH_TABS: QuickSearchTab[] = ['all', 'convs', 'messages', 'contacts', 'work'];

export function chooseAvailableSearchTab(
  current: QuickSearchTab,
  counts: Record<QuickSearchTab, number>,
): QuickSearchTab {
  if (counts[current] > 0) return current;
  return (['convs', 'messages', 'contacts', 'work'] as const).find((tab) => counts[tab] > 0) ?? current;
}

export function searchesSettledFor(
  keyword: string,
  messageKeyword: string,
  contactKeyword: string,
): boolean {
  const current = keyword.trim();
  return !!current && messageKeyword === current && contactKeyword === current;
}

/**
 * 跨会话消息搜索：服务端全局搜索可用时以它为准；只有接口不可用或响应非法才回退。
 *
 * 全局搜索成功返回空数组同样是完整结果，不能再逐房间请求。回退限制并发，且任何
 * 后端失败都会交给界面显示，避免把 429/500 伪装成“没有结果”。
 */
export async function searchMessagesGlobal(
  keyword: string,
  recentRids: string[],
  backend: MessageSearchBackend,
  isCurrent: () => boolean = () => true,
): Promise<RcMessage[]> {
  try {
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
  const rids = recentRids.slice(0, FALLBACK_ROOMS);
  for (let i = 0; i < rids.length; i += FALLBACK_CONCURRENCY) {
    if (!isCurrent()) return [];
    const batch = await Promise.all(
      rids.slice(i, i + FALLBACK_CONCURRENCY).map((rid) => backend.room(rid, keyword)),
    );
    messages.push(...batch.flat());
  }
  return messages;
}
