import { useEffect, useMemo, useRef, useState } from 'react';
import { tsMs, type RcRoom, type RcUser } from '@rcx/rc-client';
import { Hash, Lock, MessageCircle, Search, Tag, Users, UsersRound } from 'lucide-react';
import { rest } from '../lib/client';
import { personName, useAliases } from '../stores/aliases';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/toast';
import { pinyinMatch, pinyinScore, usePinyinReady } from '../lib/pinyin';
import { collectUserDirectory } from '../lib/userDirectory';
import { settleScopedResult } from '../lib/scopedResult';
import AliasDialog from '../components/AliasDialog';
import Avatar from '../components/Avatar';
import UserCard, { type UserCardTarget } from '../components/UserCard';
import { SkeletonList } from '../components/Skeleton';
import { useI18n, useT, type MessageKey } from '../i18n';

type Tab = 'members' | 'groups';

const TABS: { key: Tab; labelKey: MessageKey; icon: typeof Users }[] = [
  { key: 'members', labelKey: 'pages.contacts.tab.members', icon: Users },
  { key: 'groups', labelKey: 'pages.contacts.tab.groups', icon: UsersRound },
];

/** 成员列表（directory 分页 + 搜索） */
function MembersTab({ onOpenCard }: { onOpenCard: (u: UserCardTarget) => void }) {
  const { t, tp } = useI18n();
  const startDM = useChat((s) => s.startDM);
  const setModule = useUI((s) => s.setModule);
  const seedUserStatus = useChat((s) => s.seedUserStatus);
  const userStatus = useChat((s) => s.userStatus);
  const me = useAuth((s) => s.user?.username);
  const [keyword, setKeyword] = useState('');
  const [roster, setRoster] = useState<RcUser[]>([]);
  const [remoteResult, setRemoteResult] = useState<{ query: string; users: RcUser[] }>({
    query: '',
    users: [],
  });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [aliasFor, setAliasFor] = useState<RcUser | null>(null);
  const setUserAlias = useAliases((s) => s.setUserAlias);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 拼音检索只能在本地做（服务端不认 zhangsan/zs），所以在安全上限内分页加载花名册。
  // 超出上限的人仍可尝试按准确姓名或用户名走服务端搜索。
  useEffect(() => {
    let cancelled = false;
    const PAGE = 100;
    (async () => {
      try {
        const first = await rest.searchUsers('', PAGE, 0);
        if (cancelled) return;
        setTotal(Math.max(first.users.length, Number.isFinite(first.total) ? first.total : 0));
        setError(null);
        setWarning(null);
        const acc = new Map(first.users.map((user) => [user._id, user]));
        setRoster([...acc.values()]);
        seedUserStatus(first.users);
        setLoading(false);
        const result = await collectUserDirectory(
          first,
          (offset) => rest.searchUsers('', PAGE, offset),
          { pageSize: PAGE, isCurrent: () => !cancelled },
        );
        if (cancelled) return;
        setTotal(result.total);
        setWarning(result.warning ?? null);
        setRoster(result.users);
        seedUserStatus(result.users);
      } catch (err: unknown) {
        if (cancelled) return;
        setRoster([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 关键词走服务端（能翻出首屏之外的人），与本地拼音结果合并
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
        () => rest.searchUsers(q, 50),
        {
          success: ({ users }) => {
            setRemoteResult({ query: q, users });
            seedUserStatus(users);
          },
          error: () => setRemoteResult({ query: q, users: [] }),
        },
        () => current,
      );
    }, 300);
    return () => {
      current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword]);

  const pinyinReady = usePinyinReady();
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const remote = remoteResult.query === keyword.trim() ? remoteResult.users : [];
  const users = useMemo(() => {
    if (!keyword.trim()) return roster;
    const merged = new Map<string, RcUser>();
    for (const u of roster) {
      // 备注名也参与匹配，否则起了备注反而搜不到人
      if (pinyinMatch(keyword, aliases[`u:${u.username}`], u.name, u.username)) {
        merged.set(u._id, u);
      }
    }
    for (const u of remote) merged.set(u._id, u);
    return [...merged.values()].sort(
      (a, b) =>
        pinyinScore(keyword, aliases[`u:${a.username}`] || a.name || a.username) -
        pinyinScore(keyword, aliases[`u:${b.username}`] || b.name || b.username),
    );
  }, [roster, remote, keyword, aliases, pinyinReady]);

  const doDM = async (username: string) => {
    if (busy) return;
    setBusy(username);
    try {
      await startDM(username);
      setModule('messages');
    } catch (err) {
      toast.error(err, t('pages.contacts.startDmFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between pb-4">
        <div className="flex h-9 w-80 items-center gap-2 rounded-xl border border-line bg-surface-4 px-3 shadow-raise transition focus-within:border-primary/70 focus-within:ring-2 focus-within:ring-primary/15">
          <Search size={14} className="shrink-0 text-ink-3" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('pages.contacts.searchMembersPlaceholder')}
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
        <span className="rounded-full border border-line-soft bg-surface-2 px-2.5 py-0.5 text-xs text-ink-3">
          {keyword ? (
            tp(users.length, 'pages.contacts.foundMembersOne', 'pages.contacts.foundMembersOther')
          ) : (
            <>
              {tp(total, 'pages.contacts.totalMembersOne', 'pages.contacts.totalMembersOther')}
              {total > users.length && (
                <span className="ml-1 text-warning">
                  {t('pages.contacts.partialRosterHint', { count: users.length })}
                </span>
              )}
            </>
          )}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto rounded-2xl border border-line bg-surface-4 shadow-card">
        {loading && <SkeletonList rows={6} avatar={36} />}
        {!loading && warning && (
          <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
            {warning}
          </div>
        )}
        {!loading && error && (
          <div className="px-6 py-10 text-center">
            <div className="text-sm text-danger">{t('pages.contacts.loadMembersFailed')}</div>
            <div className="mx-auto mt-2 max-w-lg text-xs leading-relaxed break-words text-ink-3">
              {error}
            </div>
            <div className="mt-3 text-xs text-ink-3">
              {t('pages.contacts.loadMembersPermissionHint')}
            </div>
          </div>
        )}
        {!loading &&
          !error &&
          users.map((u) => {
            const alias = aliases[`u:${u.username}`];
            const real = u.name || u.username;
            const shownName = personName(aliases, u.username, real, nameFormat);
            return (
              <div
                key={u._id}
                onClick={() => onOpenCard(u)}
                className="group flex cursor-pointer items-center gap-3 border-b border-line-soft px-4 py-3 transition [contain-intrinsic-size:auto_57px] [content-visibility:auto] last:border-b-0 hover:bg-fill-2/75"
              >
                <Avatar
                  name={shownName}
                  username={u.username}
                  size={36}
                  status={userStatus[u.username] ?? u.status}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">
                    {shownName}
                    {u.username === me && <span className="ml-1 text-xs text-ink-3">{t('pages.contacts.meTag')}</span>}
                  </div>
                  <div className="truncate text-xs text-ink-3">
                    @{u.username}
                  </div>
                </div>
                {u.username !== me && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setAliasFor(u);
                      }}
                      className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-primary hover:text-primary"
                      title={alias ? t('pages.contacts.currentAliasTitle', { alias }) : t('pages.contacts.setAliasTitle')}
                    >
                      <Tag size={14} />
                      {t(alias ? 'pages.contacts.editAlias' : 'pages.contacts.addAlias')}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void doDM(u.username);
                      }}
                      className="flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:border-primary hover:bg-primary hover:text-white"
                    >
                      <MessageCircle size={14} />
                      {t(busy === u.username ? 'pages.contacts.opening' : 'pages.contacts.sendMessage')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        {!loading && !error && users.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">{t('pages.contacts.noMatchingMembers')}</div>
        )}
      </div>
      {aliasFor && (
        <AliasDialog
          title={t('pages.contacts.aliasDialogTitle')}
          originalName={aliasFor.name || aliasFor.username}
          current={aliases[`u:${aliasFor.username}`]}
          onSubmit={(alias) => setUserAlias(aliasFor.username, alias)}
          onClose={() => setAliasFor(null)}
        />
      )}
    </>
  );
}

/** 我的群组（来自订阅） */
function GroupsTab() {
  const { t, tp } = useI18n();
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const openRoom = useChat((s) => s.openRoom);
  const setModule = useUI((s) => s.setModule);
  const [keyword, setKeyword] = useState('');

  const pinyinReady = usePinyinReady();
  const groups = useMemo(() => {
    const list = Object.values(subscriptions)
      .filter((s) => s.t === 'c' || s.t === 'p')
      .map((s) => ({
        sub: s,
        room: rooms[s.rid] as RcRoom | undefined,
        name: s.fname || s.name,
      }));
    const filtered = keyword ? list.filter((g) => pinyinMatch(keyword, g.name)) : list;
    return filtered.sort((a, b) =>
      keyword
        ? pinyinScore(keyword, a.name) - pinyinScore(keyword, b.name)
        : tsMs(b.room?.lm) - tsMs(a.room?.lm),
    );
  }, [subscriptions, rooms, keyword, pinyinReady]);

  const open = (rid: string) => {
    void openRoom(rid);
    setModule('messages');
  };

  return (
    <>
      <div className="flex items-center justify-between pb-4">
        <div className="flex h-9 w-80 items-center gap-2 rounded-xl border border-line bg-surface-4 px-3 shadow-raise transition focus-within:border-primary/70 focus-within:ring-2 focus-within:ring-primary/15">
          <Search size={14} className="shrink-0 text-ink-3" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('pages.contacts.searchGroupsPlaceholder')}
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
        <span className="rounded-full border border-line-soft bg-surface-2 px-2.5 py-0.5 text-xs text-ink-3">
          {tp(groups.length, 'pages.contacts.totalGroupsOne', 'pages.contacts.totalGroupsOther')}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto rounded-2xl border border-line bg-surface-4 shadow-card">
        {groups.map(({ sub, room, name }) => (
          <div
            key={sub.rid}
            onClick={() => open(sub.rid)}
            className="flex cursor-pointer items-center gap-3 border-b border-line-soft px-4 py-3 transition last:border-b-0 hover:bg-fill-2/75"
          >
            <Avatar name={name} size={36} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
                {sub.t === 'p' ? (
                  <Lock size={12} className="shrink-0 text-ink-3" />
                ) : (
                  <Hash size={12} className="shrink-0 text-ink-3" />
                )}
                <span className="truncate">{name}</span>
              </div>
              <div className="truncate text-xs text-ink-3">
                {room?.usersCount
                  ? tp(room.usersCount, 'pages.contacts.groupMembersOne', 'pages.contacts.groupMembersOther')
                  : t(sub.t === 'p' ? 'pages.contacts.privateGroup' : 'pages.contacts.publicChannel')}
              </div>
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">{t('pages.contacts.emptyGroups')}</div>
        )}
      </div>
    </>
  );
}

/** 通讯录模块：成员 / 我的群组 */
export default function ContactsPage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('members');
  const localMode = useAuth((s) => s.localMode);
  const exitLocalMode = useAuth((s) => s.exitLocalMode);
  const [card, setCard] = useState<UserCardTarget | null>(null);

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="flex w-[216px] shrink-0 flex-col border-r border-line bg-surface-2 p-3">
        <div className="px-2.5 py-2 text-base font-semibold text-ink">{t('pages.contacts.title')}</div>
        <div className="flex flex-col gap-0.5">
          {TABS.map(({ key, labelKey, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition ${
                tab === key
                  ? 'bg-surface-4 font-medium text-ink shadow-raise ring-1 ring-line/80'
                  : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              }`}
            >
              <Icon size={16} className={tab === key ? 'text-primary' : ''} />
              {t(labelKey)}
            </button>
          ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-surface-3 p-6">
        {localMode ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-line-soft bg-surface-2/60 px-10 py-9 shadow-raise">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-4 text-ink-3 shadow-raise">
                <Users size={26} />
              </span>
              <div className="text-sm font-medium text-ink">{t('pages.contacts.localModeTitle')}</div>
              <p className="max-w-sm text-xs leading-5 text-ink-3">{t('pages.contacts.localModeHint')}</p>
              <button
                type="button"
                onClick={() => void exitLocalMode()}
                className="mt-1 h-9 rounded-xl bg-primary px-4 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
              >
                {t('pages.contacts.connectRocketChat')}
              </button>
            </div>
          </div>
        ) : tab === 'members' ? <MembersTab onOpenCard={setCard} /> : <GroupsTab />}
      </main>
      {card && <UserCard user={card} onClose={() => setCard(null)} />}
    </div>
  );
}
