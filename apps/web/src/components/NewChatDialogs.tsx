import { useEffect, useRef, useState } from 'react';
import type { RcUser } from '@rcx/rc-client';
import { Check, Lock, Search, X } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import Avatar from './Avatar';

/**
 * 用户搜索（300ms 防抖），排除自己。
 * 走 searchUsers 三级回退：spotlight 在部分服务器上对空关键词返回空，
 * 而发起会话时需要「不输入也能看到人」。
 */
export function useUserSearch(keyword: string): RcUser[] {
  const [users, setUsers] = useState<RcUser[]>([]);
  const me = useAuth((s) => s.user?.username);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      rest
        .searchUsers(keyword, 30)
        .then((r) => setUsers(r.users.filter((u) => u.username !== me)))
        .catch(() => setUsers([]));
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword, me]);

  return users;
}

function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[70vh] w-[420px] flex-col rounded-xl bg-surface-4 shadow-2xl">
        <header className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-[15px] font-semibold text-ink">{title}</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-2 hover:bg-fill-hover"
          >
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** 发起私聊：搜索用户 → 点击直达会话 */
export function StartDMDialog({ onClose }: { onClose: () => void }) {
  const startDM = useChat((s) => s.startDM);
  const [keyword, setKeyword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const users = useUserSearch(keyword);

  const pick = async (username: string) => {
    if (busy) return;
    setBusy(username);
    setError(null);
    try {
      await startDM(username);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起会话失败');
      setBusy(null);
    }
  };

  return (
    <DialogShell title="发起私聊" onClose={onClose}>
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
      {error && <div className="px-5 pb-1 text-xs text-danger">{error}</div>}
      <div className="min-h-40 flex-1 overflow-y-auto px-2 pb-3">
        {users.map((u) => (
          <button
            key={u._id}
            onClick={() => void pick(u.username)}
            disabled={!!busy}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-fill-hover disabled:opacity-60"
          >
            <Avatar name={u.name || u.username} username={u.username} size={32} />
            <div className="min-w-0">
              <div className="truncate text-sm text-ink">{u.name || u.username}</div>
              <div className="truncate text-xs text-ink-3">@{u.username}</div>
            </div>
            {busy === u.username && <span className="ml-auto text-xs text-ink-3">打开中…</span>}
          </button>
        ))}
        {users.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            {keyword ? '未找到匹配的用户' : '输入用户名或姓名搜索'}
          </div>
        )}
      </div>
    </DialogShell>
  );
}

/** 创建群组：群名 + 选成员 + 公开/私有 */
export function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const createGroup = useChat((s) => s.createGroup);
  const [name, setName] = useState('');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Map<string, RcUser>>(new Map());
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useUserSearch(keyword);

  const toggle = (u: RcUser) => {
    const next = new Map(selected);
    if (next.has(u.username)) next.delete(u.username);
    else next.set(u.username, u);
    setSelected(next);
  };

  const doCreate = async () => {
    const groupName = name.trim().replace(/\s+/g, '-');
    if (!groupName || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createGroup(groupName, [...selected.keys()], priv);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
      setBusy(false);
    }
  };

  return (
    <DialogShell title="创建群组" onClose={onClose}>
      <div className="space-y-2.5 px-5 pb-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="群组名称（必填）"
          className="h-9 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary"
        />
        {selected.size > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {[...selected.values()].map((u) => (
              <span
                key={u.username}
                className="flex items-center gap-1 rounded-full bg-primary-light px-2 py-0.5 text-xs text-primary"
              >
                {u.name || u.username}
                <button onClick={() => toggle(u)} className="hover:text-danger">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex h-8 items-center gap-2 rounded-md bg-fill-1 px-2.5">
          <Search size={14} className="text-ink-3" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索并添加成员"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>
      <div className="min-h-32 flex-1 overflow-y-auto px-2">
        {users.map((u) => {
          const checked = selected.has(u.username);
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
      <footer className="flex items-center justify-between px-5 py-3.5">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={priv}
            onChange={(e) => setPriv(e.target.checked)}
            className="accent-primary"
          />
          <Lock size={12} />
          私有群组（仅受邀成员可见）
        </label>
        <button
          onClick={() => void doCreate()}
          disabled={!name.trim() || busy}
          className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? '创建中…' : '创建'}
        </button>
      </footer>
    </DialogShell>
  );
}
