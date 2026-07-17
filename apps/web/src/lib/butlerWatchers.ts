export interface ButlerEventCard {
  id: string;
  kind: 'build-failed' | 'mention-stale' | 'workitem-assigned';
  title: string;
  detail: string;
  at: number;
}

export interface ButlerWatcherEvent extends ButlerEventCard {
  dedupeKey: string;
}

export interface ButlerWatcherSnapshot {
  builds?: Array<{
    id: number | string;
    definition: string;
    buildNumber: string;
    project?: string;
    status?: string;
    result: string;
  }>;
  workItems?: Array<{
    id: number | string;
    title: string;
    assignedTo?: string;
    project?: string;
  }>;
  subscriptions?: Array<{
    rid: string;
    name: string;
    userMentions: number;
    lastMessageAt?: number;
  }>;
  user?: { username?: string; name?: string };
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

/** 从已有 store 快照中找出值得放到「今日」的事项；不发送系统通知。 */
export function checkWatchers(snapshot: ButlerWatcherSnapshot, now: number): ButlerWatcherEvent[] {
  const cards: ButlerWatcherEvent[] = [];

  for (const build of snapshot.builds ?? []) {
    const dedupeKey = `build:${build.id}`;
    if (build.result.toLocaleLowerCase() !== 'failed' || seen(snapshot, dedupeKey)) continue;
    cards.push({
      id: `event:${dedupeKey}`,
      dedupeKey,
      kind: 'build-failed',
      title: `构建失败：${build.definition} · ${build.buildNumber}`,
      detail: [build.project, build.status].filter(Boolean).join(' · ') || '请在工作台查看失败详情。',
      at: now,
    });
  }

  const identities = [snapshot.user?.username, snapshot.user?.name]
    .filter((value): value is string => !!value?.trim())
    .map((value) => value.toLocaleLowerCase());
  if (identities.length > 0) {
    for (const item of snapshot.workItems ?? []) {
      const assignedTo = item.assignedTo?.toLocaleLowerCase() ?? '';
      const dedupeKey = `workitem:${item.id}`;
      if (!assignedTo || seen(snapshot, dedupeKey) || !identities.some((identity) => assignedTo.includes(identity))) continue;
      cards.push({
        id: `event:${dedupeKey}`,
        dedupeKey,
        kind: 'workitem-assigned',
        title: `新指派工作项：#${item.id} ${item.title}`,
        detail: [item.project, item.assignedTo].filter(Boolean).join(' · ') || '已指派给你。',
        at: now,
      });
    }
  }

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
      kind: 'mention-stale',
      title: `@我未回应：${subscription.name}（${hours}小时前）`,
      detail: `当前仍有 ${subscription.userMentions} 条 @我 未处理。`,
      at: now,
    });
  }

  return cards;
}
