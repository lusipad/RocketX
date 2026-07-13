import { useEffect, useMemo, useState } from 'react';
import type { RcUser } from '@rcx/rc-client';
import { AlertCircle, Check, Search, UserPlus } from 'lucide-react';
import { useChat } from '../stores/chat';
import { humanError } from '../stores/toast';
import Avatar from './Avatar';
import PanelShell from './PanelShell';
import Dialog from './Dialog';
import UserCard, { type UserCardTarget } from './UserCard';
import { useUserSearch } from './NewChatDialogs';
import { SkeletonList } from './Skeleton';

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
      setError(humanError(err, '邀请失败'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="添加成员"
      width={400}
      onClose={onClose}
      footer={
        <button
          onClick={() => void doInvite()}
          disabled={selected.size === 0 || busy}
          className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? '邀请中…' : `添加${selected.size > 0 ? `（${selected.size}）` : ''}`}
        </button>
      }
    >
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
      <div className="min-h-32 px-2">
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
        {users.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            {keyword ? '未找到匹配的用户' : '输入用户名搜索'}
          </div>
        )}
      </div>
      {error && <div className="px-5 pt-1 text-xs text-danger">{error}</div>}
    </Dialog>
  );
}

/** 群成员面板：搜索 + 成员列表 + 添加成员 */
export default function MembersPanel() {
  const rid = useChat((s) => s.activeRid);
  const loadMembers = useChat((s) => s.loadMembers);
  const cachedMembers = useChat((s) => (s.activeRid ? s.members[s.activeRid] : undefined));
  const [members, setMembers] = useState<RcUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [card, setCard] = useState<UserCardTarget | null>(null);
  const [adding, setAdding] = useState(false);

  // 单一入口拉取（之前两个 effect 都会调用 → 每次打开发两次请求）
  useEffect(() => {
    if (!rid) return;
    if (cachedMembers) {
      setMembers(cachedMembers);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void loadMembers(rid)
      .then((list) => {
        setMembers(list);
        if (list.length === 0) setError(null);
      })
      .catch((err: unknown) => setError(humanError(err, '无法获取成员列表')))
      .finally(() => setLoading(false));
  }, [rid, cachedMembers, loadMembers]);

  const filtered = useMemo(() => {
    const q = keyword.toLowerCase();
    return q
      ? members.filter(
          (m) => m.username.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q),
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
        {loading && <SkeletonList rows={5} avatar={32} />}
        {!loading && error && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <AlertCircle size={22} className="text-danger" />
            <div className="max-w-xs text-xs break-words text-ink-3">{error}</div>
          </div>
        )}
        {!loading &&
          !error &&
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
                        ? 'bg-warning'
                        : m.status === 'busy'
                          ? 'bg-danger'
                          : 'bg-line'
                  }`}
                />
              )}
            </div>
          ))}
        {!loading && !error && filtered.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            {keyword ? '未找到匹配的成员' : '暂无成员'}
          </div>
        )}
      </div>
      {card && <UserCard user={card} onClose={() => setCard(null)} />}
    </PanelShell>
  );
}
