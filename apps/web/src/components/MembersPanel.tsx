import { useEffect, useMemo, useState } from 'react';
import type { RcUser } from '@rcx/rc-client';
import { Check, Search, UserPlus, X } from 'lucide-react';
import { useChat } from '../stores/chat';
import Avatar from './Avatar';
import PanelShell from './PanelShell';
import UserCard, { type UserCardTarget } from './UserCard';
import { useUserSearch } from './NewChatDialogs';

/** 添加成员弹窗 */
function AddMembersDialog({ onClose }: { onClose: () => void }) {
  const rid = useChat((s) => s.activeRid);
  const inviteMembers = useChat((s) => s.inviteMembers);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Map<string, RcUser>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useUserSearch(keyword);

  const toggle = (u: RcUser) => {
    const next = new Map(selected);
    if (next.has(u._id)) next.delete(u._id);
    else next.set(u._id, u);
    setSelected(next);
  };

  const doInvite = async () => {
    if (!rid || selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await inviteMembers(rid, [...selected.values()]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '邀请失败');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[60vh] w-[400px] flex-col rounded-xl bg-surface-4 shadow-2xl">
        <header className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-[15px] font-semibold text-ink">添加成员</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-2 hover:bg-fill-hover"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-5 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-md bg-fill-1 px-2.5">
            <Search size={14} className="text-ink-3" />
            <input
              autoFocus
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索用户"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
            />
          </div>
        </div>
        <div className="min-h-32 flex-1 overflow-y-auto px-2">
          {users.map((u) => {
            const checked = selected.has(u._id);
            return (
              <button
                key={u._id}
                onClick={() => toggle(u)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-fill-hover"
              >
                <span
                  className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition ${
                    checked ? 'border-primary bg-primary text-white' : 'border-line bg-surface-4'
                  }`}
                >
                  {checked && <Check size={12} strokeWidth={3} />}
                </span>
                <Avatar name={u.name || u.username} username={u.username} size={28} />
                <span className="truncate text-sm text-ink">{u.name || u.username}</span>
                <span className="text-xs text-ink-3">@{u.username}</span>
              </button>
            );
          })}
        </div>
        {error && <div className="px-5 pt-1 text-xs text-danger">{error}</div>}
        <footer className="flex justify-end px-5 py-3.5">
          <button
            onClick={() => void doInvite()}
            disabled={selected.size === 0 || busy}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '邀请中…' : `添加${selected.size > 0 ? `（${selected.size}）` : ''}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 群成员面板：搜索 + 成员列表 */
export default function MembersPanel() {
  const rid = useChat((s) => s.activeRid);
  const loadMembers = useChat((s) => s.loadMembers);
  const [members, setMembers] = useState<RcUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [card, setCard] = useState<UserCardTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const cachedMembers = useChat((s) => (s.activeRid ? s.members[s.activeRid] : undefined));

  // 邀请成功后 store 会清缓存，这里跟着重新拉取
  useEffect(() => {
    if (!rid || cachedMembers) return;
    void loadMembers(rid).then(setMembers);
  }, [rid, cachedMembers, loadMembers]);

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
      <div className="flex items-center gap-2 p-3">
        <div className="flex h-8 flex-1 items-center gap-2 rounded-md bg-fill-1 px-2.5">
          <Search size={14} className="text-ink-3" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索成员"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
        <button
          title="添加成员"
          onClick={() => setAdding(true)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-fill-1 text-ink-2 transition hover:bg-fill-hover hover:text-primary"
        >
          <UserPlus size={15} />
        </button>
      </div>
      {adding && <AddMembersDialog onClose={() => setAdding(false)} />}
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
