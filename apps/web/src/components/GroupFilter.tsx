import { useMemo } from 'react';
import {
  AtSign,
  Hash,
  MessageSquareText,
  RefreshCw,
  Settings,
  User,
} from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import { useUI, type ConvFilter } from '../stores/ui';

const FILTERS: { key: ConvFilter; label: string; icon: typeof AtSign }[] = [
  { key: 'all', label: '消息', icon: MessageSquareText },
  { key: 'unread', label: '未读', icon: RefreshCw },
  { key: 'mentions', label: '@我', icon: AtSign },
  { key: 'dm', label: '单聊', icon: User },
  { key: 'groups', label: '群组', icon: Hash },
];

/** 飞书「分组」栏：会话列表的过滤维度 */
export default function GroupFilter() {
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const filter = useUI((s) => s.convFilter);
  const setFilter = useUI((s) => s.setConvFilter);

  const counts = useMemo(() => {
    const convs = buildConversations(subscriptions, rooms);
    const unread = convs.filter((c) => c.unread > 0 || c.alert).length;
    const mentions = convs.reduce((n, c) => n + c.unread, 0);
    return {
      all: convs.reduce((n, c) => n + c.unread, 0) || (unread > 0 ? unread : 0),
      unread,
      mentions,
      dm: 0,
      groups: 0,
    } as Record<ConvFilter, number>;
  }, [subscriptions, rooms]);

  return (
    <aside className="flex w-[150px] shrink-0 flex-col bg-dark-2 px-2 py-3">
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="text-[13px] font-medium text-dark-ink">分组</span>
        <button
          title="分组设置（规划中）"
          className="flex h-6 w-6 cursor-not-allowed items-center justify-center rounded text-dark-ink-3"
        >
          <Settings size={13} />
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {FILTERS.map(({ key, label, icon: Icon }) => {
          const isActive = key === filter;
          const count = counts[key];
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition ${
                isActive
                  ? 'bg-dark-active font-medium text-white'
                  : 'text-dark-ink-2 hover:bg-dark-hover'
              }`}
            >
              <Icon size={14} className={isActive ? 'text-primary-hover' : ''} />
              {label}
              {count > 0 && (
                <span className="ml-auto text-[11px] text-dark-ink-3">
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
