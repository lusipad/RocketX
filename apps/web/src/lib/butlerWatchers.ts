export interface ButlerEventCard {
  id: string;
  kind: 'mention-stale';
  title: string;
  detail: string;
  at: number;
}

export interface ButlerWatcherEvent extends ButlerEventCard {
  dedupeKey: string;
  rid: string;
}

export interface ButlerWatcherSnapshot {
  subscriptions?: Array<{
    rid: string;
    name: string;
    userMentions: number;
    lastMessageAt?: number;
  }>;
  seenKeys?: ReadonlySet<string> | readonly string[];
}

function seen(snapshot: ButlerWatcherSnapshot, key: string): boolean {
  const keys = snapshot.seenKeys;
  if (keys instanceof Set) return keys.has(key);
  return (keys as readonly string[] | undefined)?.includes(key) ?? false;
}

function localDate(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 从已有 store 快照中找出值得放到管家桌面的事项；不发送系统通知。 */
export function checkWatchers(snapshot: ButlerWatcherSnapshot, now: number): ButlerWatcherEvent[] {
  const cards: ButlerWatcherEvent[] = [];

  const today = localDate(now);
  for (const subscription of snapshot.subscriptions ?? []) {
    const lastMessageAt = subscription.lastMessageAt ?? 0;
    const age = now - lastMessageAt;
    const dedupeKey = `mention:${subscription.rid}:${today}`;
    if (subscription.userMentions <= 0 || lastMessageAt <= 0 || age <= 2 * 60 * 60 * 1000 || seen(snapshot, dedupeKey)) continue;
    const hours = Math.floor(age / (60 * 60 * 1000));
    cards.push({
      id: `event:${dedupeKey}`,
      dedupeKey,
      rid: subscription.rid,
      kind: 'mention-stale',
      title: `@我未回应：${subscription.name}（${hours}小时前）`,
      detail: `当前仍有 ${subscription.userMentions} 条 @我 未处理。`,
      at: now,
    });
  }

  return cards;
}
