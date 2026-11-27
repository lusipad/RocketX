import { useEffect, useMemo, useRef, useState } from 'react';
import type { RcUser } from '@rcx/rc-client';
import { Check, Lock, Search, X } from 'lucide-react';
import { getServerBase, rest } from '../lib/client';
import { usePinyinReady } from '../lib/pinyin';
import { loadUserSearchRoster, mergeUserSearchResults } from '../lib/userSearch';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { personName, useAliases } from '../stores/aliases';
import { settleScopedResult } from '../lib/scopedResult';
import Avatar from './Avatar';
import Dialog from './Dialog';
import { useT } from '../i18n';

/**
 * 用户搜索（300ms 防抖），排除自己。
 * 走 searchUsers 三级回退：spotlight 在部分服务器上对空关键词返回空，
 * 而发起会话时需要「不输入也能看到人」。
 *
 * 服务端不认拼音，所以在安全上限内分页缓存花名册并做本地匹配，再与服务端结果合并——
 * 这样 zs / zhangsan 能找到「张三」；目录不完整时会明确提示，不会静默漏人。
 */
export function useUserSearch(keyword: string): { users: RcUser[]; warning: string | null } {
  const [roster, setRoster] = useState<RcUser[]>([]);
  const [rosterWarning, setRosterWarning] = useState<string | null>(null);
  const [remoteResult, setRemoteResult] = useState<{ query: string; users: RcUser[] }>({
    query: '',
    users: [],
  });
  const me = useAuth((s) => s.user?.username);
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let current = true;
    void settleScopedResult(
      () =>
        loadUserSearchRoster(
          (offset) => rest.searchUsers('', 100, offset),
          {
            cacheKey: `${getServerBase()}\0${me ?? ''}`,
            isCurrent: () => current,
            onFirstPage: (users) => {
              setRoster(users.filter((u) => u.username !== me));
            },
          },
        ),
      {
        success: (result) => {
          setRoster(result.users.filter((u) => u.username !== me));
          setRosterWarning(result.warning ?? null);
        },
        error: () => {
          setRoster([]);
          setRosterWarning(null);
        },
      },
      () => current,
    );
    return () => {
      current = false;
    };
  }, [me]);

  useEffect(() => {
    let current = true;
    if (timer.current) clearTimeout(timer.current);
    const q = keyword.trim();
    if (!q) {
      setRemoteResult({ query: '', users: [] });
      return;
    }
    timer.current = setTimeout(() => {
      void settleScopedResult(
        () => rest.searchUsers(q, 30),
        {
          success: (result) =>
            setRemoteResult({
              query: q,
              users: result.users.filter((u) => u.username !== me),
            }),
          error: () => setRemoteResult({ query: q, users: [] }),
        },
        () => current,
      );
    }, 300);
    return () => {
      current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword, me]);

  const pinyinReady = usePinyinReady();
  const remote = remoteResult.query === keyword.trim() ? remoteResult.users : [];
  const users = useMemo(() => {
    if (!keyword.trim()) return roster;
    return mergeUserSearchResults(
      keyword,
      roster,
      remote,
      (user) => personName(aliases, user.username, user.name || user.username, nameFormat),
    );
  }, [roster, remote, keyword, aliases, nameFormat, pinyinReady]);
  return { users, warning: rosterWarning };
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
export function StartDMDialog({
  onClose,
  initialKeyword,
  draft,
  onOpened,
}: {
  onClose: () => void;
  /** 预填的搜索词（/msg @用户名 打开时带上对方） */
  initialKeyword?: string;
  /** 首条消息草稿：会话打开后写进输入框（/msg @用户名 消息内容） */
  draft?: string;
  onOpened?: (rid: string) => void;
}) {
  const t = useT();
  const startDM = useChat((s) => s.startDM);
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const [keyword, setKeyword] = useState(initialKeyword ?? '');
  const [selected, setSelected] = useState<Map<string, RcUser>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { users, warning: userSearchWarning } = useUserSearch(keyword);

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
      const rid = await startDM(usernames);
      if (draft && rid) useChat.getState().setDraft(rid, draft);
      onOpened?.(rid);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('chat.newChat.dmFailed'));
      setBusy(false);
    }
  };

  const count = selected.size;

  return (
    <DialogShell
      title={t('chat.newChat.dmTitle')}
      hint={t('chat.newChat.dmHint')}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-xs text-ink-3">
            {count === 0
              ? t('chat.newChat.dmFooterZero')
              : count === 1
                ? t('chat.newChat.dmFooterOne')
                : t('chat.newChat.dmFooterMulti', { count })}
          </span>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void open([...selected.keys()])}
            disabled={count === 0 || busy}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy
              ? t('chat.common.opening')
              : count > 1
                ? t('chat.newChat.startGroupChatCount', { count })
                : t('chat.newChat.startChatBtn')}
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
                {personName(aliases, u.username, u.name || u.username, nameFormat)}
                <button onClick={() => toggle(u)} className="hover:text-danger">
                  <X size={12} />
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
            placeholder={t('chat.newChat.searchUsersPlaceholder')}
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>

      {error && <div className="px-5 pb-1 text-xs text-danger">{error}</div>}
      {userSearchWarning && (
        <div className="px-5 pb-1 text-xs text-warning">{userSearchWarning}</div>
      )}

      <div className="min-h-40 flex-1 overflow-y-auto px-2 pb-3">
        {users.map((u) => {
          const checked = selected.has(u.username);
          const shownName = personName(aliases, u.username, u.name || u.username, nameFormat);
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
                title={checked ? t('chat.newChat.unselectUser') : t('chat.newChat.selectUserForGroup')}
              >
                {checked && <Check size={12} strokeWidth={3} />}
              </button>
              <button
                onClick={() => (count > 0 ? toggle(u) : void open([u.username]))}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                title={count > 0 ? t('chat.newChat.toggleInGroup') : t('chat.newChat.directChat')}
              >
                <Avatar name={shownName} username={u.username} size={32} />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink">{shownName}</span>
                  <span className="block truncate text-xs text-ink-3">@{u.username}</span>
                </span>
              </button>
            </div>
          );
        })}
        {users.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            {keyword ? t('chat.newChat.noMatchingUsers') : t('chat.newChat.searchPrompt')}
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
  initialName,
  initialPrivate,
}: {
  kind?: 'group' | 'team';
  onClose: () => void;
  /** /create 频道名 预填 */
  initialName?: string;
  /** /create --private 预选 */
  initialPrivate?: boolean;
}) {
  const t = useT();
  const createGroup = useChat((s) => s.createGroup);
  const createTeam = useChat((s) => s.createTeam);
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const [name, setName] = useState(initialName ?? '');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Map<string, RcUser>>(new Map());
  const [priv, setPriv] = useState(initialPrivate ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { users, warning: userSearchWarning } = useUserSearch(keyword);
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
      setError(err instanceof Error ? err.message : t('chat.newChat.createFailed'));
      setBusy(false);
    }
  };

  return (
    <DialogShell title={isTeam ? t('chat.newChat.createTeamTitle') : t('chat.newChat.createGroupTitle')} onClose={onClose}>
      {isTeam && (
        <div className="mx-5 mb-2 rounded-md bg-fill-2 px-3 py-2 text-xs leading-relaxed text-ink-3">
          {t('chat.newChat.teamHint')}
        </div>
      )}
      <div className="space-y-2.5 px-5 pb-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isTeam ? t('chat.newChat.teamNamePlaceholder') : t('chat.newChat.groupNamePlaceholder')}
          className="h-9 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary"
        />
        {selected.size > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {[...selected.values()].map((u) => (
              <span
                key={u.username}
                className="flex items-center gap-1 rounded-full bg-primary-light px-2 py-0.5 text-xs text-primary"
              >
                {personName(aliases, u.username, u.name || u.username, nameFormat)}
                <button onClick={() => toggle(u)} className="hover:text-danger">
                  <X size={12} />
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
            placeholder={t('chat.newChat.searchAddMembers')}
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>
      <div className="min-h-32 flex-1 overflow-y-auto px-2">
        {users.map((u) => {
          const checked = selected.has(u.username);
          const shownName = personName(aliases, u.username, u.name || u.username, nameFormat);
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
              <Avatar name={shownName} username={u.username} size={28} />
              <span className="truncate text-sm text-ink">{shownName}</span>
              <span className="text-xs text-ink-3">@{u.username}</span>
            </button>
          );
        })}
      </div>
      {userSearchWarning && (
        <div className="px-5 pt-1 text-xs text-warning">{userSearchWarning}</div>
      )}
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
          {isTeam ? t('chat.newChat.privateTeam') : t('chat.newChat.privateGroup')}
        </label>
        <button
          onClick={() => void doCreate()}
          disabled={!name.trim() || busy}
          className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? t('chat.common.creating') : t('chat.common.create')}
        </button>
      </div>
    </DialogShell>
  );
}
