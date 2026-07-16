import { buildSections, type Conversation } from '../stores/chat';
import { inFolder, type Folder } from '../stores/folders';
import type { ConvFilter } from '../stores/ui';

export interface ConversationViewOptions {
  filter: ConvFilter;
  folder?: Folder;
  retainedUnreadRid?: string | null;
  groupByType: boolean;
  showUnread: boolean;
  showFavorites: boolean;
  sortBy: 'activity' | 'alphabetical';
}

export type ConversationViewSection = ReturnType<typeof buildSections>[number];

export function filterConversations(
  conversations: Conversation[],
  filter: ConvFilter,
  retainedUnreadRid?: string | null,
): Conversation[] {
  switch (filter) {
    case 'unread':
      return conversations.filter(
        (conversation) =>
          conversation.unread > 0 ||
          conversation.alert ||
          conversation.rid === retainedUnreadRid,
      );
    case 'mentions':
      return conversations.filter((conversation) => conversation.userMentions > 0);
    case 'dm':
      return conversations.filter(
        (conversation) => conversation.type === 'd' && !conversation.isMultiDM,
      );
    case 'multi':
      return conversations.filter((conversation) => conversation.isMultiDM);
    case 'groups':
      return conversations.filter(
        (conversation) =>
          (conversation.type === 'c' || conversation.type === 'p') &&
          !conversation.isTeam &&
          !conversation.isDiscussion,
      );
    case 'teams':
      return conversations.filter(
        (conversation) => conversation.isTeam || !!conversation.teamId,
      );
    case 'discussions':
      return conversations.filter((conversation) => conversation.isDiscussion);
    case 'favorites':
      return conversations.filter((conversation) => conversation.favorite);
    case 'hidden':
      return conversations.filter((conversation) => conversation.hidden);
    default:
      return conversations.filter((conversation) => !conversation.hidden);
  }
}

export function buildConversationView(
  conversations: Conversation[],
  options: ConversationViewOptions,
): ConversationViewSection[] {
  const sort = (items: Conversation[]) =>
    [...items].sort((a, b) =>
      options.sortBy === 'alphabetical'
        ? a.name.localeCompare(b.name, 'zh-CN')
        : b.lastTs - a.lastTs,
    );

  if (options.folder) {
    const manual = options.folder.rids
      .map((rid) => conversations.find((conversation) => conversation.rid === rid))
      .filter((conversation): conversation is Conversation => !!conversation);
    const automatic = sort(
      conversations.filter(
        (conversation) =>
          !options.folder!.rids.includes(conversation.rid) &&
          inFolder(options.folder!, conversation),
      ),
    );
    return [{ key: 'all', label: options.folder.name, items: [...manual, ...automatic] }];
  }

  const filtered = filterConversations(
    conversations,
    options.filter,
    options.retainedUnreadRid,
  );
  if (options.filter !== 'all') {
    return [{ key: 'all', label: options.filter, items: sort(filtered) }];
  }
  return buildSections(filtered, {
    groupByType: options.groupByType,
    showUnread: options.showUnread,
    showFavorites: options.showFavorites,
    sortBy: options.sortBy,
  });
}

export function flattenConversationView(
  sections: ConversationViewSection[],
  collapsedKeys: string[],
  sectionsCollapsible: boolean,
): Conversation[] {
  return sections.flatMap((section) =>
    sectionsCollapsible && collapsedKeys.includes(section.key) ? [] : section.items,
  );
}

export function adjacentConversation(
  conversations: Conversation[],
  activeRid: string | null,
  delta: -1 | 1,
): Conversation | null {
  if (conversations.length === 0) return null;
  const current = conversations.findIndex((conversation) => conversation.rid === activeRid);
  if (current < 0) return delta > 0 ? conversations[0] : conversations.at(-1)!;
  return conversations[Math.max(0, Math.min(conversations.length - 1, current + delta))] ?? null;
}

export function nextUnreadConversation(
  conversations: Conversation[],
  activeRid: string | null,
): Conversation | null {
  const unread = conversations
    .filter((conversation) => conversation.unread > 0 || conversation.alert)
    .sort((a, b) => b.lastTs - a.lastTs);
  if (unread.length === 0) return null;
  const current = unread.findIndex((conversation) => conversation.rid === activeRid);
  if (current < 0) return unread[0];
  if (unread.length === 1) return null;
  return unread[(current + 1) % unread.length];
}

/** 全局指令中心：有未读时只给未读，没有未读时退回最近会话。 */
export function commandCenterConversations(
  conversations: Conversation[],
): Conversation[] {
  const unread = conversations.filter(
    (conversation) => conversation.unread > 0 || conversation.alert,
  );
  return [...(unread.length > 0 ? unread : conversations)].sort(
    (a, b) => b.lastTs - a.lastTs,
  );
}
