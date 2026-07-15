import type { RcUser } from '@rcx/rc-client';
import { pinyinMatch, pinyinScore } from './pinyin';

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
