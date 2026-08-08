import type { RcUser } from '@rcx/rc-client';
import { pinyinMatch, pinyinScore } from './pinyin';
import {
  collectUserDirectory,
  type UserDirectoryPage,
  type UserDirectoryResult,
} from './userDirectory';

const SEARCH_ROSTER_PAGE_SIZE = 100;
const SEARCH_ROSTER_CACHE_TTL_MS = 5 * 60 * 1_000;

interface CachedSearchRoster {
  expiresAt: number;
  firstUsers?: RcUser[];
  firstPageListeners: Set<(users: RcUser[]) => void>;
  promise: Promise<UserDirectoryResult>;
}

const searchRosterCache = new Map<string, CachedSearchRoster>();

function cachedSearchRoster(
  cacheKey: string,
  fetchPage: (offset: number) => Promise<UserDirectoryPage>,
): CachedSearchRoster {
  const now = Date.now();
  for (const [key, entry] of searchRosterCache) {
    if (entry.expiresAt <= now) searchRosterCache.delete(key);
  }

  const cached = searchRosterCache.get(cacheKey);
  if (cached) return cached;

  let entry!: CachedSearchRoster;
  const promise = (async () => {
    const first = await fetchPage(0);
    entry.firstUsers = first.users;
    for (const listener of entry.firstPageListeners) listener(first.users);
    entry.firstPageListeners.clear();
    return await collectUserDirectory(first, fetchPage, {
      pageSize: SEARCH_ROSTER_PAGE_SIZE,
    });
  })();
  entry = {
    expiresAt: now + SEARCH_ROSTER_CACHE_TTL_MS,
    firstPageListeners: new Set(),
    promise,
  };
  searchRosterCache.set(cacheKey, entry);
  void promise.catch(() => {
    if (searchRosterCache.get(cacheKey) === entry) searchRosterCache.delete(cacheKey);
  });
  return entry;
}

/** 在安全上限内分页加载花名册；首屏先回传，不完整时由结果 warning 明示。 */
export async function loadUserSearchRoster(
  fetchPage: (offset: number) => Promise<UserDirectoryPage>,
  options: {
    cacheKey?: string;
    isCurrent?: () => boolean;
    onFirstPage?: (users: RcUser[]) => void;
  } = {},
): Promise<UserDirectoryResult> {
  const isCurrent = options.isCurrent ?? (() => true);
  if (options.cacheKey) {
    const entry = cachedSearchRoster(options.cacheKey, fetchPage);
    const notifyFirstPage = (users: RcUser[]) => {
      if (isCurrent()) options.onFirstPage?.(users);
    };
    if (entry.firstUsers) notifyFirstPage(entry.firstUsers);
    else entry.firstPageListeners.add(notifyFirstPage);
    try {
      return await entry.promise;
    } finally {
      entry.firstPageListeners.delete(notifyFirstPage);
    }
  }

  const first = await fetchPage(0);
  if (isCurrent()) options.onFirstPage?.(first.users);
  return await collectUserDirectory(first, fetchPage, {
    pageSize: SEARCH_ROSTER_PAGE_SIZE,
    isCurrent,
  });
}

/** 将服务端结果与本地花名册的拼音命中合并，远端数据优先。 */
export function mergeUserSearchResults(
  keyword: string,
  roster: RcUser[],
  remote: RcUser[],
  labelOf: (user: RcUser) => string = (user) => user.name || user.username,
): RcUser[] {
  const merged = new Map<string, RcUser>();
  for (const user of roster) {
    if (pinyinMatch(keyword, labelOf(user), user.name, user.username)) {
      merged.set(user._id, user);
    }
  }
  for (const user of remote) merged.set(user._id, user);

  return [...merged.values()].sort((a, b) => {
    const score = pinyinScore(keyword, labelOf(a)) - pinyinScore(keyword, labelOf(b));
    return score || a.username.localeCompare(b.username);
  });
}
