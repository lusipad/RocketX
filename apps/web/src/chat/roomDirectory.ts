import { tsMs, type RcRoom, type RcSubscription } from '@rcx/rc-client';
import { messagePreview } from './messageProjection';

export interface Conversation {
  rid: string;
  name: string;
  type: RcSubscription['t'];
  unread: number;
  alert: boolean;
  userMentions: number;
  favorite: boolean;
  muted: boolean;
  hidden: boolean;
  isDiscussion: boolean;
  isMultiDM: boolean;
  parentName?: string;
  isTeam: boolean;
  teamId?: string;
  lastTs: number;
  lastPreview: string;
  avatarUsername?: string;
}

export type SectionKey = 'unread' | 'favorites' | 'teams' | 'discussions' | 'channels' | 'multi' | 'direct';

export const SECTION_LABELS: Record<SectionKey, string> = {
  unread: '未读',
  favorites: '收藏',
  teams: '团队',
  discussions: '讨论',
  channels: '频道与群组',
  multi: '多人聊天',
  direct: '私聊',
};

export function roomMembershipPolicy(
  hasSubscription: boolean,
  room: Pick<RcRoom, 't' | 'prid'> | undefined,
): { requiresJoin: boolean; canCompose: boolean } {
  const requiresJoin = !hasSubscription && !!room && (room.t === 'c' || !!room.prid);
  return { requiresJoin, canCompose: !requiresJoin || !!room?.prid };
}

export function buildConversations(
  subscriptions: Record<string, RcSubscription>,
  rooms: Record<string, RcRoom>,
  includeHidden = false,
): Conversation[] {
  const items: Conversation[] = [];
  for (const sub of Object.values(subscriptions)) {
    const hidden = sub.open === false;
    if (hidden && !includeHidden) continue;
    const room = rooms[sub.rid];
    const lastTs = Math.max(tsMs(room?.lm), tsMs(room?.lastMessage?.ts));
    const prid = sub.prid ?? room?.prid;
    const parent = prid ? rooms[prid] : undefined;
    const dmSize = room?.uids?.length ?? room?.usersCount;
    const isMultiDM =
      sub.t === 'd' && (dmSize !== undefined ? dmSize > 2 : (sub.fname ?? sub.name).includes(','));
    items.push({
      rid: sub.rid,
      name: sub.fname || sub.name,
      type: sub.t,
      unread: sub.unread,
      alert: sub.alert,
      userMentions: sub.userMentions ?? 0,
      favorite: !!sub.f,
      muted: !!sub.disableNotifications,
      hidden,
      isDiscussion: !!prid,
      isMultiDM,
      parentName: parent ? parent.fname || parent.name : undefined,
      isTeam: !!(room?.teamMain ?? sub.teamMain),
      teamId: room?.teamId ?? sub.teamId,
      lastTs,
      lastPreview: messagePreview(room?.lastMessage),
      avatarUsername: sub.t === 'd' && !isMultiDM ? sub.name : undefined,
    });
  }
  items.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastTs - a.lastTs);
  return items;
}

export function sectionOf(conv: Conversation): SectionKey {
  if (conv.favorite) return 'favorites';
  if (conv.isTeam) return 'teams';
  if (conv.isDiscussion) return 'discussions';
  if (conv.isMultiDM) return 'multi';
  if (conv.type === 'd') return 'direct';
  return 'channels';
}

export function buildSections(
  convs: Conversation[],
  opts: { groupByType: boolean; showUnread: boolean; showFavorites: boolean; sortBy: 'activity' | 'alphabetical' },
): { key: SectionKey | 'all'; label: string; items: Conversation[] }[] {
  const sortFn = (a: Conversation, b: Conversation) =>
    opts.sortBy === 'alphabetical' ? a.name.localeCompare(b.name, 'zh-CN') : b.lastTs - a.lastTs;
  const rest = [...convs];
  const sections: { key: SectionKey | 'all'; label: string; items: Conversation[] }[] = [];
  if (opts.showUnread) {
    const unread = rest.filter((conversation) => conversation.unread > 0 || conversation.alert);
    if (unread.length > 0) {
      sections.push({ key: 'unread', label: SECTION_LABELS.unread, items: unread.sort(sortFn) });
      for (const conversation of unread) rest.splice(rest.indexOf(conversation), 1);
    }
  }
  if (!opts.groupByType) {
    const favorites = opts.showFavorites ? rest.filter((conversation) => conversation.favorite) : [];
    if (favorites.length > 0) {
      sections.push({ key: 'favorites', label: SECTION_LABELS.favorites, items: favorites.sort(sortFn) });
      for (const conversation of favorites) rest.splice(rest.indexOf(conversation), 1);
    }
    sections.push({ key: 'all', label: '会话', items: rest.sort(sortFn) });
    return sections;
  }
  const order: SectionKey[] = ['favorites', 'teams', 'discussions', 'channels', 'multi', 'direct'];
  const buckets = new Map<SectionKey, Conversation[]>();
  for (const conversation of rest) {
    const key = opts.showFavorites ? sectionOf(conversation) : sectionOf({ ...conversation, favorite: false });
    const list = buckets.get(key) ?? [];
    list.push(conversation);
    buckets.set(key, list);
  }
  for (const key of order) {
    const items = buckets.get(key);
    if (items?.length) sections.push({ key, label: SECTION_LABELS[key], items: items.sort(sortFn) });
  }
  return sections;
}
