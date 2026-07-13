import { useEffect, useMemo, useRef, useState } from 'react';
import type { RcUser } from '@rcx/rc-client';
import { Check, Lock, Search, X } from 'lucide-react';
import { rest } from '../lib/client';
import { pinyinMatch, pinyinScore, usePinyinReady } from '../lib/pinyin';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import Avatar from './Avatar';
import Dialog from './Dialog';

/**
 * 用户搜索（300ms 防抖），排除自己。
 * 走 searchUsers 三级回退：spotlight 在部分服务器上对空关键词返回空，
 * 而发起会话时需要「不输入也能看到人」。
 *
 * 服务端不认拼音，所以先取一页花名册在本地做拼音匹配，再与服务端结果合并——
 * 这样 zs / zhangsan 能找到「张三」，同时首屏之外的人也不会漏。
 */
export function useUserSearch(keyword: string): RcUser[] {
  const [roster, setRoster] = useState<RcUser[]>([]);
  const [remote, setRemote] = useState<RcUser[]>([]);
  const me = useAuth((s) => s.user?.username);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    rest
      .searchUsers('', 100)
      .then((r) => setRoster(r.users.filter((u) => u.username !== me)))
      .catch(() => setRoster([]));
  }, [me]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!keyword.trim()) {
      setRemote([]);
      return;
    }
    timer.current = setTimeout(() => {
      rest
        .searchUsers(keyword, 30)
        .then((r) => setRemote(r.users.filter((u) => u.username !== me)))
        .catch(() => setRemote([]));
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword, me]);

  const pinyinReady = usePinyinReady();
  return useMemo(() => {
    if (!keyword.trim()) return roster;
    const merged = new Map<string, RcUser>();
    for (const u of roster) {
      if (pinyinMatch(keyword, u.name, u.username)) merged.set(u._id, u);
    }
    for (const u of remote) merged.set(u._id, u);
    return [...merged.values()].sort(
      (a, b) =>
        pinyinScore(keyword, a.name || a.username) -
        pinyinScore(keyword, b.name || b.username),
    );
  }, [roster, remote, keyword, pinyinReady]);
}

/** 统一弹窗外壳（含 Esc 关闭） */
const DialogShell = Dialog;

/**
 * 发起聊天。
 *
 * 选一个人 = 私聊；选多个人 = 多人直聊 —— 飞书那种「不用起群名、选完人就能聊」的群聊。
 * Rocket.Chat 的 im.create 本来就支持多人，只是它把这种会话的 t 仍标成 'd'。
 * 真正需要长期存在、有名字有公告的，才去「创建群组」。
 */
export function StartDMDialog({ onClose }: { onClose: () => void }) {
  const startDM = useChat((s) => s.startDM);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Map<string, RcUser>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useUserSearch(keyword);

  // 函数式更新：读闭包里的 selected 的话，同一渲染周期内连点两个人只会剩一个
  const toggle = (u: RcUser) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(u.username)) next.delete(u.username);
      else next.set(u.username, u);
      return next;
    });
    setError(null);
  };

  const open = async (usernames: string[]) => {
    if (busy || usernames.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await startDM(usernames);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起会话失败');
      setBusy(false);
    }
  };

  const count = selected.size;

  return (
    <DialogShell
      title="发起聊天"
      hint="选一个人就是私聊；选多个人直接开群聊，不用起名字。"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-ink-3">
            {count === 0
              ? '点头像选人，或直接点某一行开始私聊'
              : count === 1
                ? '已选 1 人 · 将开始私聊'
                : `已选 ${count} 人 · 将开始多人群聊`}
          </span>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => void open([...selected.keys()])}
            disabled={count === 0 || busy}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '打开中…' : count > 1 ? `开始群聊（${count}）` : '开始聊天'}
          </button>
        </>
      }
    >
      <div className="space-y-2.5 px-5 pb-2">
        {count > 0 && (
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
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索用户，支持拼音（如 zhangsan / zs）"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>

      {error && <div className="px-5 pb-1 text-xs text-danger">{error}</div>}

      <div className="min-h-40 flex-1 overflow-y-auto px-2 pb-3">
        {users.map((u) => {
          const checked = selected.has(u.username);
          return (
            <div
              key={u._id}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-fill-hover ${
                busy ? 'pointer-events-none opacity-60' : ''
              }`}
            >
              {/* 勾选 = 加入多人群聊；点整行 = 直接和这个人私聊（最常用的路径不该多一步） */}
              <button
                onClick={() => toggle(u)}
                className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition ${
                  checked ? 'border-primary bg-primary text-white' : 'border-line bg-surface-4'
                }`}
                title={checked ? '取消选择' : '选中，可多选开群聊'}
              >
                {checked && <Check size={12} strokeWidth={3} />}
              </button>
              <button
                onClick={() => (count > 0 ? toggle(u) : void open([u.username]))}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                title={count > 0 ? '加入/移出本次群聊' : '直接私聊'}
              >
                <Avatar name={u.name || u.username} username={u.username} size={32} />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink">{u.name || u.username}</span>
                  <span className="block truncate text-xs text-ink-3">@{u.username}</span>
                </span>
              </button>
            </div>
          );
        })}
        {users.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            {keyword ? '未找到匹配的用户' : '输入用户名或姓名搜索'}
          </div>
        )}
      </div>
    </DialogShell>
  );
}

/**
 * 创建群组 / 团队。
 * 群组 = 单个频道；团队 = 主频道 + 可挂多个子频道（Rocket.Chat Team）。
 */
export function CreateGroupDialog({
  kind = 'group',
  onClose,
}: {
  kind?: 'group' | 'team';
  onClose: () => void;
}) {
  const createGroup = useChat((s) => s.createGroup);
  const createTeam = useChat((s) => s.createTeam);
  const [name, setName] = useState('');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Map<string, RcUser>>(new Map());
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useUserSearch(keyword);
  const isTeam = kind === 'team';

  const toggle = (u: RcUser) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(u.username)) next.delete(u.username);
      else next.set(u.username, u);
      return next;
    });
  };

  const doCreate = async () => {
    const groupName = name.trim().replace(/\s+/g, '-');
    if (!groupName || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isTeam) await createTeam(groupName, [...selected.keys()], priv);
      else await createGroup(groupName, [...selected.keys()], priv);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
      setBusy(false);
    }
  };

  return (
    <DialogShell title={isTeam ? '创建团队' : '创建群组'} onClose={onClose}>
      {isTeam && (
        <div className="mx-5 mb-2 rounded-md bg-fill-2 px-3 py-2 text-xs leading-relaxed text-ink-3">
          团队是一组频道的集合：创建后可以在团队下继续新建频道，成员共享。
        </div>
      )}
      <div className="space-y-2.5 px-5 pb-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isTeam ? '团队名称（必填）' : '群组名称（必填）'}
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
      <div className="flex items-center justify-between px-5 py-3.5">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={priv}
            onChange={(e) => setPriv(e.target.checked)}
            className="accent-primary"
          />
          <Lock size={12} />
          {isTeam ? '私有团队（仅受邀成员可见）' : '私有群组（仅受邀成员可见）'}
        </label>
        <button
          onClick={() => void doCreate()}
          disabled={!name.trim() || busy}
          className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? '创建中…' : '创建'}
        </button>
      </div>
    </DialogShell>
  );
}
