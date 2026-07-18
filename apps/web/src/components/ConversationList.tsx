import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
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
import { buildConversations, useChat, type Conversation } from '../stores/chat';
import { displayName, useAliases } from '../stores/aliases';
import { inFolder, useFolders } from '../stores/folders';
import { usePrefs } from '../stores/prefs';
import { useUI, type ConvFilter } from '../stores/ui';
import { fmtConvTime, useDayTick } from '../lib/format';
import { buildConversationView } from '../lib/conversationView';
import AliasDialog from './AliasDialog';
import Avatar from './Avatar';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { CreateGroupDialog, StartDMDialog } from './NewChatDialogs';
import { IPMSG_RID, useIpmsg } from '../ipmsg/store';

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
  hidden: '隐藏',
};

function ConversationItem({
  conv,
  active,
  viewMode,
  showAvatar,
  avatarOnly,
}: {
  conv: Conversation;
  active: boolean;
  viewMode: 'extended' | 'medium' | 'condensed';
  showAvatar: boolean;
  avatarOnly: boolean;
}) {
  const openRoom = useChat((s) => s.openRoom);
  const scrollToLatest = useChat((s) => s.scrollToLatest);
  const toggleFavorite = useChat((s) => s.toggleFavorite);
  const toggleMute = useChat((s) => s.toggleMute);
  const markConvRead = useChat((s) => s.markConvRead);
  const hideConv = useChat((s) => s.hideConv);
  const restoreConv = useChat((s) => s.restoreConv);
  const draft = useChat((s) => s.drafts[conv.rid]);
  const filter = useUI((s) => s.convFilter);
  const retainUnread = useUI((s) => s.retainUnread);
  const showDraft = !!draft && !active;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);

  // 单聊显示对方在线状态：DM 的对方用户名就是 avatarUsername，按用户名查状态
  const peerStatus = useChat((s) =>
    conv.avatarUsername ? s.userStatus[conv.avatarUsername] : undefined,
  );

  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const setUserAlias = useAliases((s) => s.setUserAlias);
  const setRoomAlias = useAliases((s) => s.setRoomAlias);
  const shownName = displayName(aliases, conv, nameFormat);
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
  const isIpmsg = conv.source === 'ipmsg';

  const menuItems: MenuItem[] = isIpmsg ? [
    ...(conv.unread > 0
      ? [{ label: '标为已读', icon: Check, onClick: () => useIpmsg.getState().markRead() }]
      : []),
  ] : [
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
    conv.hidden
      ? {
          label: '恢复会话',
          icon: Eye,
          onClick: () => void restoreConv(conv).catch(() => {}),
        }
      : { label: '隐藏会话', icon: EyeOff, danger: true, onClick: () => void hideConv(conv) },
  ];

  const avatarSize = avatarOnly
    ? 40
    : viewMode === 'extended'
      ? 40
      : viewMode === 'medium'
        ? 34
        : 26;
  const showPreview = viewMode === 'extended';
  const padY = avatarOnly ? 'py-2' : viewMode === 'condensed' ? 'py-1' : 'py-2';

  return (
    <>
    <button
      draggable={!isIpmsg}
      onDragStart={(e) => {
        if (isIpmsg) return;
        e.dataTransfer.setData('text/rcx-rid', conv.rid);
        e.dataTransfer.effectAllowed = 'copy';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onClick={() => {
        // 再点已打开的会话 = 回到最新消息（跳去看历史后点会话名回底部，issue #18.6）
        if (active) scrollToLatest();
        else {
          if (filter === 'unread') retainUnread(conv.rid);
          void (conv.hidden
            ? restoreConv(conv).then(() => openRoom(conv.rid))
            : openRoom(conv.rid)).catch(() => {});
        }
      }}
      onContextMenu={(e) => {
        if (menuItems.length === 0) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      aria-label={avatarOnly ? shownName : undefined}
      title={
        avatarOnly
          ? shownName
          : isIpmsg
            ? '未认证的本地兼容频道'
            : '拖到左侧分组可归类；右键更多操作'
      }
      className={`flex w-full cursor-pointer items-center rounded-lg ${
        avatarOnly ? 'justify-center px-1' : 'gap-2.5 px-2.5'
      } ${padY} text-left transition ${
        active ? 'bg-fill-active' : 'hover:bg-fill-hover'
      } ${dragging ? 'opacity-40 ring-1 ring-primary ring-inset' : ''}`}
    >
      {showAvatar && (
        <div className="relative shrink-0">
          <Avatar
            name={shownName}
            username={conv.avatarUsername}
            roomId={conv.avatarUsername ? undefined : conv.rid}
            size={avatarSize}
            status={peerStatus}
          />
          {conv.unread > 0 ? (
            <span
              className={`absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-surface-2 px-1 text-2xs font-medium text-white ${
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
      {!avatarOnly && (
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1 truncate text-sm font-medium text-ink">
              {conv.isTeam ? (
                <Users size={12} className="shrink-0 text-ink-3" />
              ) : conv.isMultiDM ? (
                <UsersRound size={12} className="shrink-0 text-ink-3" />
              ) : conv.type === 'p' ? (
                <Lock size={12} className="shrink-0 text-ink-3" />
              ) : conv.type === 'c' ? (
                <Hash size={12} className="shrink-0 text-ink-3" />
              ) : null}
              <span
                className="truncate"
                title={currentAlias ? `原名：${conv.name}` : undefined}
              >
                {shownName}
              </span>
              {conv.userMentions > 0 && (
                <span
                  className="shrink-0 rounded bg-danger px-1 text-2xs font-medium text-white"
                  title="有人 @ 了你"
                >
                  @
                </span>
              )}
              {conv.muted && <BellOff size={11} className="shrink-0 text-ink-3" />}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-2xs text-ink-3">
              {conv.favorite && <Pin size={10} className="text-primary" />}
              {viewMode !== 'condensed' && fmtConvTime(conv.lastTs)}
              {/* 不显示头像时未读角标挪到右侧 */}
              {!showAvatar && conv.unread > 0 && (
                <span
                  className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs text-white ${
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
      )}
    </button>
      {/* 弹窗移到 button 外：React 事件沿组件树冒泡，放里面点弹窗任意处都会触发
          外层会话按钮的 onClick（切会话+标已读），还有 button 套 button 的非法嵌套（P1-15） */}
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
    </>
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

export default function ConversationList({
  width = 280,
  avatarOnly = false,
}: {
  width?: number;
  avatarOnly?: boolean;
}) {
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
  const retainedUnreadRid = useUI((s) => s.retainedUnreadRid);
  const prefs = usePrefs((s) => s.prefs);
  const folders = useFolders((s) => s.folders);
  const collapsedKeys = useFolders((s) => s.collapsed);
  const toggleCollapse = useFolders((s) => s.toggleCollapse);
  const reorderRoom = useFolders((s) => s.reorderRoom);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const ipmsgEnabled = useIpmsg((state) => state.enabled);
  const ipmsgUnread = useIpmsg((state) => state.unread);
  const ipmsgMessages = useIpmsg((state) => state.messages);

  const folder = folders.find((f) => f.id === activeFolder);

  const sections = useMemo(() => {
    const all = buildConversations(subscriptions, rooms, filter === 'hidden');
    if (ipmsgEnabled) {
      const last = ipmsgMessages.at(-1);
      all.push({
        rid: IPMSG_RID,
        name: 'IP Messenger',
        type: 'd',
        unread: ipmsgUnread,
        alert: ipmsgUnread > 0,
        userMentions: 0,
        favorite: false,
        muted: false,
        hidden: false,
        isDiscussion: false,
        isMultiDM: true,
        isTeam: false,
        lastTs: last?.timestamp ?? 0,
        lastPreview: last?.text ?? '局域网旧协议兼容频道',
        source: 'ipmsg',
      });
    }
    return buildConversationView(all, {
      filter,
      folder,
      retainedUnreadRid,
      groupByType: prefs.sidebarGroupByType,
      showUnread: prefs.sidebarShowUnread,
      showFavorites: prefs.sidebarShowFavorites,
      sortBy: prefs.sidebarSortby,
    });
  }, [subscriptions, rooms, filter, prefs, folder, retainedUnreadRid, ipmsgEnabled, ipmsgMessages, ipmsgUnread]);

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const viewMode = prefs.sidebarViewMode;
  const showAvatar = prefs.sidebarDisplayAvatar;
  const showHeaders = !avatarOnly && !folder && filter === 'all' && prefs.sidebarGroupByType;
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
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-line bg-surface-2"
    >
      {!avatarOnly && (
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
      )}
      <div
        className={`flex-1 overflow-y-auto pb-2 ${avatarOnly ? 'px-1 pt-2' : 'px-2'}`}
        onContextMenu={(e) => {
          // 只处理空白处的右键；会话行自己有菜单，别抢它的
          if ((e.target as HTMLElement).closest('button')) return;
          if (!newAction) return;
          e.preventDefault();
          setBgMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {!avatarOnly && !ready && <LoadingConversations />}
        {!avatarOnly && ready && total === 0 && (
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
                  className="flex w-full items-center gap-1 px-2 py-1.5 text-2xs font-medium text-ink-3 transition hover:text-ink-2"
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  {section.label}
                  <span className="text-ink-3">({section.items.length})</span>
                  {isCollapsed && sectionUnread > 0 && (
                    <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-2xs text-white">
                      {sectionUnread}
                    </span>
                  )}
                </button>
              )}
              {(!showHeaders || !isCollapsed) &&
                section.items.map((c) =>
                  folder ? (
                    <div
                      key={c.rid}
                      onDragOver={(e) => {
                        if (!e.dataTransfer.types.includes('text/rcx-rid')) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setDropTarget(c.rid);
                      }}
                      onDragLeave={() => setDropTarget((prev) => (prev === c.rid ? null : prev))}
                      onDrop={(e) => {
                        const rid = e.dataTransfer.getData('text/rcx-rid');
                        if (rid && rid !== c.rid) reorderRoom(folder.id, rid, c.rid);
                        setDropTarget(null);
                      }}
                      className={dropTarget === c.rid ? 'border-t-2 border-primary' : ''}
                    >
                      <ConversationItem
                        conv={c}
                        active={c.rid === activeRid}
                        viewMode={viewMode}
                        showAvatar={avatarOnly || showAvatar}
                        avatarOnly={avatarOnly}
                      />
                    </div>
                  ) : (
                    <ConversationItem
                      key={c.rid}
                      conv={c}
                      active={c.rid === activeRid}
                      viewMode={viewMode}
                      showAvatar={avatarOnly || showAvatar}
                      avatarOnly={avatarOnly}
                    />
                  ),
                )}
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
