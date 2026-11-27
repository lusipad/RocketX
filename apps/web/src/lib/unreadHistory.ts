import { tsMs, type RcDate, type RcMessage, type RoomType } from '@rcx/rc-client';
import { t } from '../i18n';

export interface UnreadHistoryResult {
  messages: RcMessage[];
  pages: number;
  truncated: boolean;
}

export async function collectUnreadHistory(
  input: { rid: string; type: RoomType; lastSeen?: RcDate; pageSize?: number; maxPages?: number },
  fetchHistory: (rid: string, type: RoomType, count: number, latest?: string) => Promise<RcMessage[]>,
): Promise<UnreadHistoryResult> {
  const pageSize = input.pageSize ?? 50;
  const maxPages = input.maxPages ?? 20;
  const lastSeenMs = tsMs(input.lastSeen);
  const byId = new Map<string, RcMessage>();
  let latest: string | undefined;
  let pages = 0;
  let reachedBoundary = false;

  while (pages < maxPages) {
    const page = await fetchHistory(input.rid, input.type, pageSize, latest);
    pages += 1;
    if (!page.length) {
      reachedBoundary = true;
      break;
    }
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const message of page) {
      const messageMs = tsMs(message.ts);
      oldestMs = Math.min(oldestMs, messageMs);
      if (!lastSeenMs || messageMs > lastSeenMs) byId.set(message._id, message);
    }
    if ((lastSeenMs && oldestMs <= lastSeenMs) || page.length < pageSize) {
      reachedBoundary = true;
      break;
    }
    const nextLatest = new Date(oldestMs).toISOString();
    if (nextLatest === latest) throw new Error(t('chat.unreadHistory.paginationStalled'));
    latest = nextLatest;
  }

  return {
    messages: [...byId.values()].sort((left, right) => tsMs(left.ts) - tsMs(right.ts)),
    pages,
    truncated: !reachedBoundary,
  };
}
