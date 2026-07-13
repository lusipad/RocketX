import { useMemo, useState } from 'react';
import {
  AtSign,
  Check,
  Hash,
  MessageSquareText,
  RefreshCw,
  Settings,
  User,
} from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import { useUI, type ConvFilter, type ConvSort } from '../stores/ui';

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
  const sort = useUI((s) => s.convSort);
  const setSort = useUI((s) => s.setConvSort);
  const [sortMenu, setSortMenu] = useState(false);

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
    <aside className="flex w-[150px] shrink-0 flex-col border-r border-line bg-surface-2 px-2 py-3">
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="text-[13px] font-medium text-ink">分组</span>
        <div className="relative">
          <button
            title="会话排序"
            onClick={() => setSortMenu((v) => !v)}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-ink"
          >
            <Settings size={13} />
          </button>
          {sortMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setSortMenu(false)} />
              <div className="absolute left-0 z-30 mt-1 w-32 rounded-lg border border-line bg-surface-4 py-1 shadow-[0_4px_16px_rgba(31,35,41,0.16)]">
                <div className="px-3 py-1 text-[11px] text-ink-3">会话排序</div>
                {(
                  [
                    { key: 'time', label: '按时间' },
                    { key: 'unread', label: '未读优先' },
                  ] as { key: ConvSort; label: string }[]
                ).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => {
                      setSort(key);
                      setSortMenu(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-fill-hover"
                  >
                    <span className="w-3.5">
                      {sort === key && <Check size={13} className="text-primary" />}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
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
                  ? 'bg-fill-active font-medium text-ink'
                  : 'text-ink-2 hover:bg-fill-hover'
              }`}
            >
              <Icon size={14} className={isActive ? 'text-primary-hover' : ''} />
              {label}
              {count > 0 && (
                <span className="ml-auto text-[11px] text-ink-3">
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
