import { useMemo } from 'react';
import {
  AtSign,
  Hash,
  MessageSquareText,
  MessagesSquare,
  Pin,
  RefreshCw,
  User,
  Users,
} from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import { useUI, type ConvFilter } from '../stores/ui';

const FILTERS: { key: ConvFilter; label: string; icon: typeof AtSign }[] = [
  { key: 'all', label: '消息', icon: MessageSquareText },
  { key: 'unread', label: '未读', icon: RefreshCw },
  { key: 'mentions', label: '@我', icon: AtSign },
  { key: 'favorites', label: '收藏', icon: Pin },
  { key: 'dm', label: '单聊', icon: User },
  { key: 'groups', label: '群组', icon: Hash },
  { key: 'teams', label: '团队', icon: Users },
  { key: 'discussions', label: '讨论', icon: MessagesSquare },
];

/** 飞书式「分组」栏：会话过滤维度（计数取自真实数据） */
export default function GroupFilter() {
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const filter = useUI((s) => s.convFilter);
  const setFilter = useUI((s) => s.setConvFilter);

  const counts = useMemo(() => {
    const convs = buildConversations(subscriptions, rooms);
    return {
      all: 0, // 「消息」不显示计数
      unread: convs.filter((c) => c.unread > 0 || c.alert).length,
      mentions: convs.reduce((n, c) => n + c.userMentions, 0),
      favorites: convs.filter((c) => c.favorite).length,
      dm: convs.filter((c) => c.type === 'd').length,
      groups: convs.filter(
        (c) => (c.type === 'c' || c.type === 'p') && !c.isTeam && !c.isDiscussion,
      ).length,
      teams: convs.filter((c) => c.isTeam || !!c.teamId).length,
      discussions: convs.filter((c) => c.isDiscussion).length,
    } as Record<ConvFilter, number>;
  }, [subscriptions, rooms]);

  return (
    <aside className="flex w-[150px] shrink-0 flex-col border-r border-line bg-surface-2 px-2 py-3">
      <div className="px-2 pb-2 text-[13px] font-medium text-ink">分组</div>
      <div className="flex flex-col gap-0.5">
        {FILTERS.map(({ key, label, icon: Icon }) => {
          const isActive = key === filter;
          const count = counts[key];
          // 未读 / @我 用红色强调，其余是中性计数
          const highlight = (key === 'unread' || key === 'mentions') && count > 0;
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition ${
                isActive ? 'bg-fill-active font-medium text-ink' : 'text-ink-2 hover:bg-fill-hover'
              }`}
            >
              <Icon size={14} className={isActive ? 'text-primary' : ''} />
              {label}
              {count > 0 && (
                <span
                  className={`ml-auto text-[11px] ${
                    highlight ? 'font-medium text-danger' : 'text-ink-3'
                  }`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
