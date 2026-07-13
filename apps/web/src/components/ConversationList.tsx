import { useMemo, useState } from 'react';
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Folder as FolderIcon,
  FolderMinus,
  Hash,
  Lock,
  Pin,
  PinOff,
  Users,
} from 'lucide-react';
import { buildConversations, buildSections, useChat, type Conversation } from '../stores/chat';
import { useFolders } from '../stores/folders';
import { usePrefs } from '../stores/prefs';
import { useUI, type ConvFilter } from '../stores/ui';
import { fmtConvTime } from '../lib/format';
import Avatar from './Avatar';
import ContextMenu, { type MenuItem } from './ContextMenu';

const FILTER_TITLE: Record<ConvFilter, string> = {
  all: '消息',
  unread: '未读',
  mentions: '@我',
  dm: '单聊',
  groups: '群组',
  teams: '团队',
  discussions: '讨论',
  favorites: '收藏',
};

/** 过滤器（@我 用 userMentions 而非 unread —— 频道普通未读不算被 @） */
function applyFilter(convs: Conversation[], filter: ConvFilter): Conversation[] {
  switch (filter) {
    case 'unread':
      return convs.filter((c) => c.unread > 0 || c.alert);
    case 'mentions':
      return convs.filter((c) => c.userMentions > 0);
    case 'dm':
      return convs.filter((c) => c.type === 'd');
    case 'groups':
      return convs.filter(
        (c) => (c.type === 'c' || c.type === 'p') && !c.isTeam && !c.isDiscussion,
      );
    case 'teams':
      return convs.filter((c) => c.isTeam || !!c.teamId);
    case 'discussions':
      return convs.filter((c) => c.isDiscussion);
    case 'favorites':
      return convs.filter((c) => c.favorite);
    default:
      return convs;
  }
}

function ConversationItem({
  conv,
  active,
  viewMode,
  showAvatar,
}: {
  conv: Conversation;
  active: boolean;
  viewMode: 'extended' | 'medium' | 'condensed';
  showAvatar: boolean;
}) {
  const openRoom = useChat((s) => s.openRoom);
  const toggleFavorite = useChat((s) => s.toggleFavorite);
  const toggleMute = useChat((s) => s.toggleMute);
  const markConvRead = useChat((s) => s.markConvRead);
  const hideConv = useChat((s) => s.hideConv);
  const draft = useChat((s) => s.drafts[conv.rid]);
  const showDraft = !!draft && !active;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const folders = useFolders((s) => s.folders);
  const addRoom = useFolders((s) => s.addRoom);
  const removeRoom = useFolders((s) => s.removeRoom);
  const inFolders = folders.filter((f) => f.rids.includes(conv.rid));
  const notInFolders = folders.filter((f) => !f.rids.includes(conv.rid));

  const menuItems: MenuItem[] = [
    {
      label: conv.favorite ? '取消收藏' : '收藏会话',
      icon: conv.favorite ? PinOff : Pin,
      onClick: () => void toggleFavorite(conv),
    },
    {
      label: conv.muted ? '取消免打扰' : '消息免打扰',
      icon: conv.muted ? Bell : BellOff,
      onClick: () => void toggleMute(conv),
    },
    ...(conv.unread > 0 || conv.alert
      ? [{ label: '标为已读', icon: Check, onClick: () => void markConvRead(conv.rid) }]
      : []),
    // 移入 / 移出自定义分组
    ...notInFolders.map((f) => ({
      label: `移入「${f.name}」`,
      icon: FolderIcon,
      onClick: () => addRoom(f.id, conv.rid),
    })),
    ...inFolders.map((f) => ({
      label: `移出「${f.name}」`,
      icon: FolderMinus,
      onClick: () => removeRoom(f.id, conv.rid),
    })),
    { label: '隐藏会话', icon: EyeOff, danger: true, onClick: () => void hideConv(conv) },
  ];

  const avatarSize = viewMode === 'extended' ? 40 : viewMode === 'medium' ? 34 : 26;
  const showPreview = viewMode === 'extended';
  const padY = viewMode === 'condensed' ? 'py-1' : 'py-2';

  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/rcx-rid', conv.rid);
        e.dataTransfer.effectAllowed = 'copy';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onClick={() => void openRoom(conv.rid)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      title="拖到左侧分组可归类；右键更多操作"
      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 ${padY} text-left transition ${
        active ? 'bg-fill-active' : 'hover:bg-fill-hover'
      } ${dragging ? 'opacity-40 ring-1 ring-primary ring-inset' : ''}`}
    >
      {showAvatar && (
        <div className="relative shrink-0">
          <Avatar name={conv.name} username={conv.avatarUsername} size={avatarSize} />
          {conv.unread > 0 ? (
            <span
              className={`absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-surface-2 px-1 text-[10px] font-medium text-white ${
                conv.muted ? 'bg-ink-3' : 'bg-danger'
              }`}
            >
              {conv.unread > 99 ? '99+' : conv.unread}
            </span>
          ) : conv.alert && !active ? (
            <span
              className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-2 ${
                conv.muted ? 'bg-ink-3' : 'bg-danger'
              }`}
            />
          ) : null}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 truncate text-[13.5px] font-medium text-ink">
            {conv.isTeam ? (
              <Users size={12} className="shrink-0 text-ink-3" />
            ) : conv.type === 'p' ? (
              <Lock size={12} className="shrink-0 text-ink-3" />
            ) : conv.type === 'c' ? (
              <Hash size={12} className="shrink-0 text-ink-3" />
            ) : null}
            <span className="truncate">{conv.name}</span>
            {conv.userMentions > 0 && (
              <span
                className="shrink-0 rounded bg-danger px-1 text-[10px] font-medium text-white"
                title="有人 @ 了你"
              >
                @
              </span>
            )}
            {conv.muted && <BellOff size={11} className="shrink-0 text-ink-3" />}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-3">
            {conv.favorite && <Pin size={10} className="text-primary" />}
            {viewMode !== 'condensed' && fmtConvTime(conv.lastTs)}
            {/* 不显示头像时未读角标挪到右侧 */}
            {!showAvatar && conv.unread > 0 && (
              <span
                className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] text-white ${
                  conv.muted ? 'bg-ink-3' : 'bg-danger'
                }`}
              >
                {conv.unread > 99 ? '99+' : conv.unread}
              </span>
            )}
          </span>
        </div>
        {showPreview && (
          <div
            className={`mt-0.5 truncate text-xs ${
              conv.unread > 0 || conv.alert ? 'text-ink-2' : 'text-ink-3'
            }`}
          >
            {showDraft ? (
              <>
                <span className="text-danger">[草稿] </span>
                {draft}
              </>
            ) : (
              conv.lastPreview || ' '
            )}
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </button>
  );
}

export default function ConversationList() {
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const activeRid = useChat((s) => s.activeRid);
  const ready = useChat((s) => s.ready);
  const filter = useUI((s) => s.convFilter);
  const activeFolder = useUI((s) => s.activeFolder);
  const prefs = usePrefs((s) => s.prefs);
  const folders = useFolders((s) => s.folders);
  const collapsedKeys = useFolders((s) => s.collapsed);
  const toggleCollapse = useFolders((s) => s.toggleCollapse);

  const folder = folders.find((f) => f.id === activeFolder);

  const sections = useMemo(() => {
    const all = buildConversations(subscriptions, rooms);
    const sortFn = (a: Conversation, b: Conversation) =>
      prefs.sidebarSortby === 'alphabetical'
        ? a.name.localeCompare(b.name, 'zh-CN')
        : b.lastTs - a.lastTs;

    // 自定义分组视图：只显示该分组里的会话（按加入顺序）
    if (folder) {
      const items = folder.rids
        .map((rid) => all.find((c) => c.rid === rid))
        .filter((c): c is Conversation => !!c);
      return [{ key: 'all' as const, label: folder.name, items }];
    }

    const filtered = applyFilter(all, filter);
    // 只有「全部」视图分区，其他过滤器是扁平列表
    if (filter !== 'all') {
      return [{ key: 'all' as const, label: FILTER_TITLE[filter], items: [...filtered].sort(sortFn) }];
    }
    return buildSections(filtered, {
      groupByType: prefs.sidebarGroupByType ?? true,
      showUnread: prefs.sidebarShowUnread ?? false,
      showFavorites: prefs.sidebarShowFavorites ?? true,
      sortBy: prefs.sidebarSortby ?? 'activity',
    });
  }, [subscriptions, rooms, filter, prefs, folder]);

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const viewMode = prefs.sidebarViewMode ?? 'medium';
  const showAvatar = prefs.sidebarDisplayAvatar ?? true;
  const showHeaders = !folder && filter === 'all' && (prefs.sidebarGroupByType ?? true);
  const title = folder ? folder.name : FILTER_TITLE[filter];

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-line bg-surface-2">
      <div className="px-4 pt-4 pb-2 text-[15px] font-semibold text-ink">{title}</div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {!ready && <div className="p-4 text-center text-sm text-ink-3">加载会话中…</div>}
        {ready && total === 0 && (
          <div className="p-4 text-center text-sm leading-relaxed text-ink-3">
            {folder ? (
              <>
                这个分组还是空的
                <div className="mt-1 text-xs">把会话拖到左侧分组名上，或右键会话「移入分组」</div>
              </>
            ) : filter === 'all' ? (
              '暂无会话'
            ) : (
              '该分组下暂无会话'
            )}
          </div>
        )}
        {sections.map((section) => {
          const isCollapsed = collapsedKeys.includes(section.key);
          const sectionUnread = section.items.reduce((n, c) => n + c.unread, 0);
          return (
            <div key={section.key} className="mb-1">
              {showHeaders && (
                <button
                  onClick={() => toggleCollapse(section.key)}
                  className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-medium text-ink-3 transition hover:text-ink-2"
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  {section.label}
                  <span className="text-ink-3">({section.items.length})</span>
                  {isCollapsed && sectionUnread > 0 && (
                    <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] text-white">
                      {sectionUnread}
                    </span>
                  )}
                </button>
              )}
              {(!showHeaders || !isCollapsed) &&
                section.items.map((c) => (
                  <ConversationItem
                    key={c.rid}
                    conv={c}
                    active={c.rid === activeRid}
                    viewMode={viewMode}
                    showAvatar={showAvatar}
                  />
                ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
