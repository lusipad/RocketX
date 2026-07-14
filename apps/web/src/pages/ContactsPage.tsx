import { useEffect, useMemo, useRef, useState } from 'react';
import { tsMs, type RcRoom, type RcUser } from '@rcx/rc-client';
import { Hash, Lock, MessageCircle, Search, Tag, Users, UsersRound } from 'lucide-react';
import { rest } from '../lib/client';
import { useAliases } from '../stores/aliases';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/toast';
import { pinyinMatch, pinyinScore, usePinyinReady } from '../lib/pinyin';
import AliasDialog from '../components/AliasDialog';
import Avatar from '../components/Avatar';
import UserCard, { type UserCardTarget } from '../components/UserCard';
import { SkeletonList } from '../components/Skeleton';

type Tab = 'members' | 'groups';

/** 成员列表（directory 分页 + 搜索） */
function MembersTab({ onOpenCard }: { onOpenCard: (u: UserCardTarget) => void }) {
  const startDM = useChat((s) => s.startDM);
  const setModule = useUI((s) => s.setModule);
  const seedUserStatus = useChat((s) => s.seedUserStatus);
  const userStatus = useChat((s) => s.userStatus);
  const me = useAuth((s) => s.user?.username);
  const [keyword, setKeyword] = useState('');
  const [roster, setRoster] = useState<RcUser[]>([]);
  const [remote, setRemote] = useState<RcUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [aliasFor, setAliasFor] = useState<RcUser | null>(null);
  const setUserAlias = useAliases((s) => s.setUserAlias);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 首屏花名册：拼音检索只能在本地做（服务端不认 zhangsan/zs），所以先取一页兜底
  useEffect(() => {
    // directory → users.list → spotlight 三级回退，失败时把原因显示出来
    rest
      .searchUsers('', 100)
      .then(({ users, total }) => {
        setRoster(users);
        setTotal(total);
        setError(null);
        seedUserStatus(users); // 用列表快照播种在线状态,之后靠实时流更新
      })
      .catch((err: unknown) => {
        setRoster([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  // 关键词走服务端（能翻出首屏之外的人），与本地拼音结果合并
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!keyword.trim()) {
      setRemote([]);
      return;
    }
    timer.current = setTimeout(() => {
      rest
        .searchUsers(keyword, 50)
        .then(({ users }) => {
          setRemote(users);
          seedUserStatus(users);
        })
        .catch(() => setRemote([]));
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword]);

  const pinyinReady = usePinyinReady();
  const aliases = useAliases((s) => s.aliases);
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
      toast.error(err, '发起会话失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between pb-3">
        <div className="flex h-9 w-72 items-center gap-2 rounded-md bg-fill-1 px-3">
          <Search size={15} className="text-ink-3" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索成员，支持拼音（如 zhangsan / zs）"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
        <span className="text-xs text-ink-3">
          {keyword ? (
            `找到 ${users.length} 人`
          ) : (
            <>
              共 {total} 人
              {total > users.length && (
                <span className="ml-1 text-warning">
                  （显示前 {users.length} 人，搜索可找到更多）
                </span>
              )}
            </>
          )}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto rounded-lg border border-line">
        {loading && <SkeletonList rows={6} avatar={36} />}
        {!loading && error && (
          <div className="px-6 py-10 text-center">
            <div className="text-sm text-danger">无法获取成员列表</div>
            <div className="mx-auto mt-2 max-w-lg text-xs leading-relaxed break-words text-ink-3">
              {error}
            </div>
            <div className="mt-3 text-xs text-ink-3">
              可能是账号缺少查看用户目录的权限，请联系 Rocket.Chat 管理员，
              或在管理后台开启「用户目录」相关设置。
            </div>
          </div>
        )}
        {!loading &&
          !error &&
          users.map((u) => {
            const alias = aliases[`u:${u.username}`];
            const real = u.name || u.username;
            return (
              <div
                key={u._id}
                onClick={() => onOpenCard(u)}
                className="group flex cursor-pointer items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-fill-2"
              >
                <Avatar
                  name={alias || real}
                  username={u.username}
                  size={36}
                  status={userStatus[u._id] ?? u.status}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">
                    {alias || real}
                    {u.username === me && <span className="ml-1 text-xs text-ink-3">（我）</span>}
                  </div>
                  <div className="truncate text-xs text-ink-3">
                    {/* 起了备注就把原名带出来，否则认不出这是谁 */}
                    {alias ? `${real} · @${u.username}` : `@${u.username}`}
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
                      title={alias ? `当前备注：${alias}` : '给这个人起个备注名'}
                    >
                      <Tag size={13} />
                      {alias ? '改备注' : '备注'}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void doDM(u.username);
                      }}
                      className="flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:border-primary hover:bg-primary hover:text-white"
                    >
                      <MessageCircle size={13} />
                      {busy === u.username ? '打开中…' : '发消息'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        {!loading && !error && users.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">未找到匹配的成员</div>
        )}
      </div>
      {aliasFor && (
        <AliasDialog
          title="给联系人设置备注"
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
      <div className="flex items-center justify-between pb-3">
        <div className="flex h-9 w-72 items-center gap-2 rounded-md bg-fill-1 px-3">
          <Search size={15} className="text-ink-3" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索群组，支持拼音"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
        <span className="text-xs text-ink-3">共 {groups.length} 个群组</span>
      </div>
      <div className="flex-1 overflow-y-auto rounded-lg border border-line">
        {groups.map(({ sub, room, name }) => (
          <div
            key={sub.rid}
            onClick={() => open(sub.rid)}
            className="flex cursor-pointer items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-fill-2"
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
                {room?.usersCount ? `${room.usersCount} 名成员` : sub.t === 'p' ? '私有群组' : '公开频道'}
              </div>
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="py-10 text-center text-sm text-ink-3">暂无群组</div>
        )}
      </div>
    </>
  );
}

/** 通讯录模块：成员 / 我的群组 */
export default function ContactsPage() {
  const [tab, setTab] = useState<Tab>('members');
  const [card, setCard] = useState<UserCardTarget | null>(null);

  const TABS: { key: Tab; label: string; icon: typeof Users }[] = [
    { key: 'members', label: '成员', icon: Users },
    { key: 'groups', label: '我的群组', icon: UsersRound },
  ];

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="w-[200px] shrink-0 border-r border-line bg-fill-2 p-3">
        <div className="px-2 py-1.5 text-[15px] font-semibold text-ink">通讯录</div>
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
              tab === key ? 'bg-primary-light text-primary' : 'text-ink-2 hover:bg-fill-hover'
            }`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-surface-3 p-5">
        {tab === 'members' ? <MembersTab onOpenCard={setCard} /> : <GroupsTab />}
      </main>
      {card && <UserCard user={card} onClose={() => setCard(null)} />}
    </div>
  );
}
