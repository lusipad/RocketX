import { useEffect, useMemo, useState } from 'react';
import type { RcRoomRole, RcUser, RoomType } from '@rcx/rc-client';
import {
  AlertCircle,
  Check,
  Crown,
  MicOff,
  MoreHorizontal,
  Search,
  Shield,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { humanError } from '../stores/toast';
import {
  ROLE_LABELS,
  canActOn,
  canTransferOwnership,
  isMuted,
  rolesOf,
  sortMembers,
} from '../lib/roomAdmin';
import Avatar from './Avatar';
import PanelShell from './PanelShell';
import Dialog, { ConfirmDialog } from './Dialog';
import UserCard, { type UserCardTarget } from './UserCard';
import { useUserSearch } from './NewChatDialogs';
import { SkeletonList } from './Skeleton';

/**
 * 「没有角色」的稳定空数组。
 *
 * 千万别在 zustand 的选择器里写 `s.roomRoles[rid] ?? []` —— 那个 `[]` 每次调用都是
 * 一个新数组，useSyncExternalStore 会认为状态一直在变，直接进入无限循环并把组件搞崩
 * （React 的报错是「The result of getSnapshot should be cached」，表现就是白屏）。
 * 角色还没拉回来、或者这是个 DM（根本不拉角色）时，命中的就是这条路径。
 */
const NO_ROLES: RcRoomRole[] = [];

/** 添加成员弹窗 */
function AddMembersDialog({ onClose }: { onClose: () => void }) {
  const rid = useChat((s) => s.activeRid);
  const inviteMembers = useChat((s) => s.inviteMembers);
  // 多人聊天（RC 里 t 仍是 'd'）没法直接加人，会新建一个包含所有人的会话 ——
  // 这跟「往群里加人」是两种结果，得先讲清楚，不能让用户点完才发现换了个会话
  const isDirect = useChat((s) => (s.activeRid ? s.subscriptions[s.activeRid]?.t === 'd' : false));
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Map<string, RcUser>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useUserSearch(keyword);

  // 必须用函数式更新：直接读闭包里的 selected，同一渲染周期内的连续两次勾选
  // 会基于同一份旧 Map 计算，后一次把前一次覆盖掉，只剩一个人被选中
  const toggle = (u: RcUser) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(u._id)) next.delete(u._id);
      else next.set(u._id, u);
      return next;
    });
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
      title={isDirect ? '拉人进来聊' : '添加成员'}
      hint={
        isDirect
          ? 'Rocket.Chat 不支持往已有的多人聊天里加人，会新建一个包含所有人的会话；原会话和它的历史消息都还在。'
          : undefined
      }
      width={400}
      onClose={onClose}
      footer={
        <button
          onClick={() => void doInvite()}
          disabled={selected.size === 0 || busy}
          className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy
            ? isDirect
              ? '新建会话中…'
              : '邀请中…'
            : `${isDirect ? '新建会话' : '添加'}${selected.size > 0 ? `（${selected.size}）` : ''}`}
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

/** 成员的管理菜单：设/撤管理员、禁言、移出。只有能管这个群的人看得见 */
function MemberMenu({
  rid,
  type,
  member,
  onClose,
}: {
  rid: string;
  type: RoomType;
  member: RcUser;
  onClose: () => void;
}) {
  // `?? NO_ROLES` 必须在选择器**外面**做，见 NO_ROLES 的注释
  const roomRoles = useChat((s) => s.roomRoles[rid]) ?? NO_ROLES;
  const muted = useChat((s) => s.rooms[rid]?.muted);
  const me = useAuth((s) => s.user);
  const setMemberRole = useChat((s) => s.setMemberRole);
  const toggleMemberMute = useChat((s) => s.toggleMemberMute);
  const kickMember = useChat((s) => s.kickMember);
  const [confirmKick, setConfirmKick] = useState(false);

  const memberRoles = rolesOf(roomRoles, member._id);
  const isOwner = memberRoles.includes('owner');
  const isMod = memberRoles.includes('moderator');
  const nowMuted = isMuted(muted, member.username);
  const canOwner = canTransferOwnership(me, roomRoles, type);

  const item =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink transition hover:bg-fill-hover';

  const run = (fn: () => Promise<void>) => {
    onClose();
    void fn();
  };

  return (
    <>
      {/* 点外面收起来 */}
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute top-full right-0 z-40 mt-0.5 w-44 overflow-hidden rounded-lg border border-line bg-surface-4 py-1 shadow-[0_4px_16px_rgba(31,35,41,0.12)]">
        {canOwner && (
          <button
            className={item}
            onClick={() => run(() => setMemberRole(rid, member, 'owner', !isOwner))}
          >
            <Crown size={14} className="text-ink-2" />
            {isOwner ? '取消群主' : '设为群主'}
          </button>
        )}
        <button
          className={item}
          onClick={() => run(() => setMemberRole(rid, member, 'moderator', !isMod))}
        >
          <Shield size={14} className="text-ink-2" />
          {isMod ? '取消管理员' : '设为管理员'}
        </button>
        <button className={item} onClick={() => run(() => toggleMemberMute(rid, member))}>
          <MicOff size={14} className="text-ink-2" />
          {nowMuted ? '解除禁言' : '禁言'}
        </button>
        <button
          className={`${item} text-danger`}
          onClick={() => setConfirmKick(true)}
        >
          <UserMinus size={14} />
          移出群聊
        </button>
      </div>
      {confirmKick && (
        <ConfirmDialog
          title="移出群聊"
          message={`确定把「${member.name || member.username}」移出群聊吗？他将不再收到该群消息，需要重新邀请才能回来。`}
          confirmLabel="移出"
          onConfirm={() => {
            onClose();
            void kickMember(rid, member);
          }}
          onClose={() => setConfirmKick(false)}
        />
      )}
    </>
  );
}

/** 群成员面板：搜索 + 成员列表（带角色）+ 添加成员 + 管理操作 */
export default function MembersPanel() {
  const rid = useChat((s) => s.activeRid);
  const loadMembers = useChat((s) => s.loadMembers);
  const loadRoomRoles = useChat((s) => s.loadRoomRoles);
  const cachedMembers = useChat((s) => (s.activeRid ? s.members[s.activeRid] : undefined));
  const roomRoles = useChat((s) => (s.activeRid ? s.roomRoles[s.activeRid] : undefined)) ?? NO_ROLES;
  const muted = useChat((s) => (s.activeRid ? s.rooms[s.activeRid]?.muted : undefined));
  const seedUserStatus = useChat((s) => s.seedUserStatus);
  const userStatus = useChat((s) => s.userStatus);
  const me = useAuth((s) => s.user);
  // 多人聊天在 RC 里也是 t='d'，它没有频道那套管理能力（踢人/角色/禁言全是 400）
  const type = useChat((s) =>
    s.activeRid ? (s.subscriptions[s.activeRid]?.t ?? s.rooms[s.activeRid]?.t ?? 'c') : 'c',
  );

  const [members, setMembers] = useState<RcUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [card, setCard] = useState<UserCardTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  // 角色单独一个 effect：跟成员列表无关，不能跟着 cachedMembers 一起重跑
  // （成员一变——比如踢完人——就会再打一次 channels.roles）
  useEffect(() => {
    if (rid) void loadRoomRoles(rid);
  }, [rid, loadRoomRoles]);

  // 单一入口拉取（之前两个 effect 都会调用 → 每次打开发两次请求）
  useEffect(() => {
    if (!rid) return;
    if (cachedMembers) {
      setMembers(cachedMembers);
      setLoading(false);
      setError(null);
      seedUserStatus(cachedMembers);
      return;
    }
    setLoading(true);
    setError(null);
    void loadMembers(rid)
      .then((list) => {
        setMembers(list);
        seedUserStatus(list);
        if (list.length === 0) setError(null);
      })
      .catch((err: unknown) => setError(humanError(err, '无法获取成员列表')))
      .finally(() => setLoading(false));
  }, [rid, cachedMembers, loadMembers]);

  const filtered = useMemo(() => {
    const q = keyword.toLowerCase();
    const list = q
      ? members.filter(
          (m) => m.username.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q),
        )
      : members;
    // 群主排最前：一屏看不完的大群里，谁说了算得一眼看到
    return sortMembers(list, roomRoles);
  }, [members, keyword, roomRoles]);

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
          filtered.map((m) => {
            const roles = rolesOf(roomRoles, m._id);
            const manageable = !!rid && canActOn(me, m, roomRoles, type);
            return (
              <div
                key={m._id}
                onClick={() => setCard(m)}
                className="group relative flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-fill-hover"
              >
                <Avatar
                  name={m.name || m.username}
                  username={m.username}
                  size={32}
                  status={userStatus[m._id] ?? m.status}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-ink">{m.name || m.username}</span>
                    {roles[0] && (
                      <span className="shrink-0 rounded bg-primary-light px-1 py-px text-2xs text-primary">
                        {ROLE_LABELS[roles[0]]}
                      </span>
                    )}
                    {isMuted(muted, m.username) && (
                      <span className="flex shrink-0 items-center gap-0.5 rounded bg-fill-1 px-1 py-px text-2xs text-ink-3">
                        <MicOff size={9} />
                        已禁言
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-ink-3">@{m.username}</div>
                </div>
                {m.status && (
                  <span
                    title={m.status}
                    className={`h-2 w-2 shrink-0 rounded-full ${
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
                {manageable && (
                  <div className="relative shrink-0">
                    <button
                      title="管理成员"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(menuFor === m._id ? null : m._id);
                      }}
                      className={`flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-2 hover:text-ink ${
                        menuFor === m._id ? '' : 'opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      <MoreHorizontal size={15} />
                    </button>
                    {menuFor === m._id && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <MemberMenu
                          rid={rid}
                          type={type}
                          member={m}
                          onClose={() => setMenuFor(null)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
