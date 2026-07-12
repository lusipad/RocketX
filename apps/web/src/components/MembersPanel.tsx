import { useEffect, useMemo, useState } from 'react';
import type { RcUser } from '@rcx/rc-client';
import { Search } from 'lucide-react';
import { useChat } from '../stores/chat';
import Avatar from './Avatar';
import PanelShell from './PanelShell';
import UserCard, { type UserCardTarget } from './UserCard';

/** 群成员面板：搜索 + 成员列表 */
export default function MembersPanel() {
  const rid = useChat((s) => s.activeRid);
  const loadMembers = useChat((s) => s.loadMembers);
  const [members, setMembers] = useState<RcUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [card, setCard] = useState<UserCardTarget | null>(null);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    void loadMembers(rid)
      .then(setMembers)
      .finally(() => setLoading(false));
  }, [rid, loadMembers]);

  const filtered = useMemo(() => {
    const q = keyword.toLowerCase();
    return q
      ? members.filter(
          (m) =>
            m.username.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q),
        )
      : members;
  }, [members, keyword]);

  return (
    <PanelShell title={`群成员${members.length ? `（${members.length}）` : ''}`}>
      <div className="p-3">
        <div className="flex h-8 items-center gap-2 rounded-md bg-fill-1 px-2.5">
          <Search size={14} className="text-ink-3" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索成员"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {loading && <div className="py-8 text-center text-sm text-ink-3">加载中…</div>}
        {!loading &&
          filtered.map((m) => (
            <div
              key={m._id}
              onClick={() => setCard(m)}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-fill-hover"
            >
              <Avatar name={m.name || m.username} username={m.username} size={32} />
              <div className="min-w-0">
                <div className="truncate text-sm text-ink">{m.name || m.username}</div>
                <div className="truncate text-xs text-ink-3">@{m.username}</div>
              </div>
              {m.status && (
                <span
                  title={m.status}
                  className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                    m.status === 'online'
                      ? 'bg-success'
                      : m.status === 'away'
                        ? 'bg-[#ff8800]'
                        : m.status === 'busy'
                          ? 'bg-danger'
                          : 'bg-line'
                  }`}
                />
              )}
            </div>
          ))}
        {!loading && filtered.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">未找到匹配的成员</div>
        )}
      </div>
      {card && <UserCard user={card} onClose={() => setCard(null)} />}
    </PanelShell>
  );
}
