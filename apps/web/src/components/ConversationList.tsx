import { useMemo, useState } from 'react';
import { BellOff, Check, EyeOff, Hash, Lock, Pin, PinOff, Bell } from 'lucide-react';
import { buildConversations, useChat, type Conversation } from '../stores/chat';
import { useUI, type ConvFilter, type ConvSort } from '../stores/ui';
import { fmtConvTime } from '../lib/format';
import Avatar from './Avatar';
import ContextMenu, { type MenuItem } from './ContextMenu';

const FILTER_TITLE: Record<ConvFilter, string> = {
  all: '消息',
  unread: '未读',
  mentions: '@我',
  dm: '单聊',
  groups: '群组',
};

function applyFilter(convs: Conversation[], filter: ConvFilter): Conversation[] {
  switch (filter) {
    case 'unread':
      return convs.filter((c) => c.unread > 0 || c.alert);
    case 'mentions':
      return convs.filter((c) => c.type !== 'd' && c.unread > 0);
    case 'dm':
      return convs.filter((c) => c.type === 'd');
    case 'groups':
      return convs.filter((c) => c.type === 'c' || c.type === 'p');
    default:
      return convs;
  }
}

function applySort(convs: Conversation[], sort: ConvSort): Conversation[] {
  if (sort !== 'unread') return convs; // buildConversations 已按 置顶+时间 排好
  return [...convs].sort(
    (a, b) =>
      Number(b.favorite) - Number(a.favorite) ||
      Number(b.unread > 0 || b.alert) - Number(a.unread > 0 || a.alert) ||
      b.lastTs - a.lastTs,
  );
}

function ConversationItem({ conv, active }: { conv: Conversation; active: boolean }) {
  const openRoom = useChat((s) => s.openRoom);
  const toggleFavorite = useChat((s) => s.toggleFavorite);
  const toggleMute = useChat((s) => s.toggleMute);
  const markConvRead = useChat((s) => s.markConvRead);
  const hideConv = useChat((s) => s.hideConv);
  const draft = useChat((s) => s.drafts[conv.rid]);
  const showDraft = !!draft && !active;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // 飞书式会话右键菜单
  const menuItems: MenuItem[] = [
    {
      label: conv.favorite ? '取消置顶' : '置顶会话',
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
    { label: '隐藏会话', icon: EyeOff, danger: true, onClick: () => void hideConv(conv) },
  ];

  return (
    <button
      onClick={() => void openRoom(conv.rid)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition ${
        active ? 'bg-dark-active' : 'hover:bg-dark-hover'
      }`}
    >
      <div className="relative shrink-0">
        <Avatar name={conv.name} username={conv.avatarUsername} size={40} />
        {/* 飞书习惯：被 @ 或私聊显示数字角标，频道普通新消息显示红点，免打扰灰色 */}
        {conv.unread > 0 ? (
          <span
            className={`absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-dark-3 px-1 text-[10px] font-medium text-white ${
              conv.muted ? 'bg-dark-ink-3' : 'bg-danger'
            }`}
          >
            {conv.unread > 99 ? '99+' : conv.unread}
          </span>
        ) : conv.alert && !active ? (
          <span
            className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-dark-3 ${
              conv.muted ? 'bg-dark-ink-3' : 'bg-danger'
            }`}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 truncate text-[13.5px] font-medium text-dark-ink">
            {conv.type === 'p' && <Lock size={12} className="shrink-0 text-dark-ink-3" />}
            {conv.type === 'c' && <Hash size={12} className="shrink-0 text-dark-ink-3" />}
            <span className="truncate">{conv.name}</span>
            {conv.isDiscussion && (
              <span
                className="shrink-0 rounded bg-white/10 px-1 text-[10px] text-dark-ink-2"
                title={conv.parentName ? `来自 ${conv.parentName}` : '讨论'}
              >
                讨论
              </span>
            )}
            {conv.muted && <BellOff size={11} className="shrink-0 text-dark-ink-3" />}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-dark-ink-3">
            {conv.favorite && <Pin size={10} className="text-primary-hover" />}
            {fmtConvTime(conv.lastTs)}
          </span>
        </div>
        <div
          className={`mt-0.5 truncate text-xs ${
            conv.unread > 0 || conv.alert ? 'text-dark-ink-2' : 'text-dark-ink-3'
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
  const filter = useUI((s) => s.convFilter);
  const sort = useUI((s) => s.convSort);
  const conversations = useMemo(
    () => applySort(applyFilter(buildConversations(subscriptions, rooms), filter), sort),
    [subscriptions, rooms, filter, sort],
  );
  const activeRid = useChat((s) => s.activeRid);
  const ready = useChat((s) => s.ready);

  return (
    <aside className="flex w-[280px] shrink-0 flex-col bg-dark-3">
      <div className="px-4 pt-4 pb-2 text-[15px] font-semibold text-dark-ink">
        {FILTER_TITLE[filter]}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {!ready && <div className="p-4 text-center text-sm text-dark-ink-3">加载会话中…</div>}
        {ready && conversations.length === 0 && (
          <div className="p-4 text-center text-sm text-dark-ink-3">
            {filter === 'all' ? '暂无会话' : '该分组下暂无会话'}
          </div>
        )}
        {conversations.map((c) => (
          <ConversationItem key={c.rid} conv={c} active={c.rid === activeRid} />
        ))}
      </div>
    </aside>
  );
}
