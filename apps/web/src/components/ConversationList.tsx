import { useEffect, useMemo, useState } from 'react';
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
  Plus,
  Tag,
  User,
  Users,
  UsersRound,
} from 'lucide-react';
import { buildConversations, buildSections, useChat, type Conversation } from '../stores/chat';
import { displayName, useAliases } from '../stores/aliases';
import { inFolder, useFolders } from '../stores/folders';
import { usePrefs } from '../stores/prefs';
import { useUI, type ConvFilter } from '../stores/ui';
import { fmtConvTime, useDayTick } from '../lib/format';
import AliasDialog from './AliasDialog';
import Avatar from './Avatar';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { CreateGroupDialog, StartDMDialog } from './NewChatDialogs';

const FILTER_TITLE: Record<ConvFilter, string> = {
  all: '消息',
  unread: '未读',
  mentions: '@我',
  dm: '单聊',
  multi: '多人聊天',
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
    // 单聊只算 1 对 1
    case 'dm':
      return convs.filter((c) => c.type === 'd' && !c.isMultiDM);
    // 多人聊天：没名字、由参与者拼出来的临时群聊，独立成一类 ——
    // 和「general-test」这种有名有姓的频道混在一起，用户根本分不清哪个是哪个
    case 'multi':
      return convs.filter((c) => c.isMultiDM);
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
  const [aliasOpen, setAliasOpen] = useState(false);

  const aliases = useAliases((s) => s.aliases);
  const setUserAlias = useAliases((s) => s.setUserAlias);
  const setRoomAlias = useAliases((s) => s.setRoomAlias);
  const shownName = displayName(aliases, conv);
  // 单聊的备注跟着「人」走（在通讯录改了这里也变）；其余会话的备注跟着会话走
  const aliasIsUser = !!conv.avatarUsername;
  const currentAlias = aliasIsUser
    ? aliases[`u:${conv.avatarUsername}`]
    : aliases[`r:${conv.rid}`];

  const folders = useFolders((s) => s.folders);
  const addRoom = useFolders((s) => s.addRoom);
  const removeRoom = useFolders((s) => s.removeRoom);
  // 规则命中的会话不提供「移出」——移出也会被规则立刻拉回来，只能去改规则
  const inFolders = folders.filter((f) => f.rids.includes(conv.rid));
  const notInFolders = folders.filter((f) => !inFolder(f, conv));

  const menuItems: MenuItem[] = [
    {
      label: currentAlias ? '修改备注名' : '设置备注名',
      icon: Tag,
      onClick: () => setAliasOpen(true),
    },
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
          <Avatar name={shownName} username={conv.avatarUsername} size={avatarSize} />
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
            ) : conv.isMultiDM ? (
              <UsersRound size={12} className="shrink-0 text-ink-3" />
            ) : conv.type === 'p' ? (
              <Lock size={12} className="shrink-0 text-ink-3" />
            ) : conv.type === 'c' ? (
              <Hash size={12} className="shrink-0 text-ink-3" />
            ) : null}
            <span className="truncate" title={currentAlias ? `原名：${conv.name}` : undefined}>
              {shownName}
            </span>
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
      {aliasOpen && (
        <AliasDialog
          title={aliasIsUser ? '给联系人设置备注' : '给会话设置备注'}
          originalName={conv.name}
          current={currentAlias}
          onSubmit={(alias) =>
            aliasIsUser
              ? setUserAlias(conv.avatarUsername!, alias)
              : setRoomAlias(conv.rid, alias)
          }
          onClose={() => setAliasOpen(false)}
        />
      )}
    </button>
  );
}

/**
 * 会话加载中。
 *
 * 超过 8 秒还没好，就不能再让用户对着「加载会话中…」干等 —— 服务器挂了、网络不通、
 * 或者初始化出了别的岔子，都长这个样子，而用户既看不到原因也没有出路。
 * 给个明确的说法和一个重试按钮。
 */
function LoadingConversations() {
  const init = useChat((s) => s.init);
  const [slow, setSlow] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  if (!slow) {
    return <div className="p-4 text-center text-sm text-ink-3">加载会话中…</div>;
  }

  return (
    <div className="p-4 text-center">
      <div className="text-sm text-ink-2">会话列表加载不出来</div>
      <div className="mt-1 text-xs leading-relaxed text-ink-3">
        可能是服务器没响应或网络不通。
      </div>
      <button
        onClick={() => {
          setRetrying(true);
          void init().finally(() => setRetrying(false));
        }}
        disabled={retrying}
        className="mt-3 h-8 rounded-md bg-primary px-4 text-xs text-white transition hover:bg-primary-hover disabled:opacity-50"
      >
        {retrying ? '重试中…' : '重试'}
      </button>
    </div>
  );
}

/** 每个分类下「新建」对应什么动作；没有对应动作的分类（未读、@我…）不显示入口 */
const NEW_ACTIONS: Partial<
  Record<ConvFilter, { label: string; dialog: 'dm' | 'group' | 'team'; icon: typeof Plus }>
> = {
  dm: { label: '发起私聊', dialog: 'dm', icon: User },
  multi: { label: '发起多人聊天', dialog: 'dm', icon: UsersRound },
  groups: { label: '创建群组', dialog: 'group', icon: Hash },
  teams: { label: '创建团队', dialog: 'team', icon: Users },
};

export default function ConversationList() {
  // 跨过零点后「昨天 / 周X」这类相对时间要跟着变
  useDayTick();
  const [dialog, setDialog] = useState<'dm' | 'group' | 'team' | null>(null);
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
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

    // 自定义分组视图：手工拖入的排在前（按加入顺序），规则命中的接在后面
    if (folder) {
      const manual = folder.rids
        .map((rid) => all.find((c) => c.rid === rid))
        .filter((c): c is Conversation => !!c);
      const byRule = all
        .filter((c) => !folder.rids.includes(c.rid) && inFolder(folder, c))
        .sort(sortFn);
      return [{ key: 'all' as const, label: folder.name, items: [...manual, ...byRule] }];
    }

    const filtered = applyFilter(all, filter);
    // 只有「全部」视图分区，其他过滤器是扁平列表
    if (filter !== 'all') {
      return [{ key: 'all' as const, label: FILTER_TITLE[filter], items: [...filtered].sort(sortFn) }];
    }
    return buildSections(filtered, {
      groupByType: prefs.sidebarGroupByType,
      showUnread: prefs.sidebarShowUnread,
      showFavorites: prefs.sidebarShowFavorites,
      sortBy: prefs.sidebarSortby,
    });
  }, [subscriptions, rooms, filter, prefs, folder]);

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const viewMode = prefs.sidebarViewMode;
  const showAvatar = prefs.sidebarDisplayAvatar;
  const showHeaders = !folder && filter === 'all' && (prefs.sidebarGroupByType);
  const title = folder ? folder.name : FILTER_TITLE[filter];

  /**
   * 当前分类下「新建」意味着什么。
   * 在「多人聊天」里想新建，要的显然是多人聊天，而不是让人回到左上角的 + 再选一遍。
   */
  const newAction = NEW_ACTIONS[filter];

  const openNew = () => {
    if (!newAction) return;
    setDialog(newAction.dialog);
  };

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-line bg-surface-2">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-[15px] font-semibold text-ink">{title}</span>
        {newAction && (
          <button
            onClick={openNew}
            title={newAction.label}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
          >
            <Plus size={15} />
          </button>
        )}
      </div>
      <div
        className="flex-1 overflow-y-auto px-2 pb-2"
        onContextMenu={(e) => {
          // 只处理空白处的右键；会话行自己有菜单，别抢它的
          if ((e.target as HTMLElement).closest('button')) return;
          if (!newAction) return;
          e.preventDefault();
          setBgMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {!ready && <LoadingConversations />}
        {ready && total === 0 && (
          <div className="p-4 text-center text-sm leading-relaxed text-ink-3">
            {folder ? (
              <>
                这个分组还是空的
                <div className="mt-1 text-xs">把会话拖到左侧分组名上，或右键会话「移入分组」</div>
              </>
            ) : (
              <>
                {filter === 'all' ? '暂无会话' : `还没有${FILTER_TITLE[filter]}`}
                {/* 空列表最该给的是「怎么开始」，而不是一句「暂无」 */}
                {newAction && (
                  <div className="mt-2">
                    <button onClick={openNew} className="text-xs text-primary hover:underline">
                      {newAction.label}
                    </button>
                  </div>
                )}
              </>
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

      {bgMenu && newAction && (
        <ContextMenu
          x={bgMenu.x}
          y={bgMenu.y}
          items={[{ label: newAction.label, icon: newAction.icon, onClick: openNew }]}
          onClose={() => setBgMenu(null)}
        />
      )}
      {dialog === 'dm' && <StartDMDialog onClose={() => setDialog(null)} />}
      {(dialog === 'group' || dialog === 'team') && (
        <CreateGroupDialog kind={dialog} onClose={() => setDialog(null)} />
      )}
    </aside>
  );
}
