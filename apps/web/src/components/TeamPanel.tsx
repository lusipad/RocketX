import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Hash,
  Loader2,
  Lock,
  Plus,
  Star,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import type { RcTeam, RcTeamMember, RcTeamRoom, RcUser } from '@rcx/rc-client';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { useTeamPanel } from '../stores/teamUi';
import { toast } from '../stores/toast';
import { useUserSearch } from './NewChatDialogs';
import { canManageTeam, roomLabel, sortTeamRooms, teamTypeLabel } from '../lib/teams';
import Avatar from './Avatar';
import Dialog, { ConfirmDialog } from './Dialog';

type Tab = 'rooms' | 'members';

/**
 * 团队管理面板（Team）。
 *
 * Rocket.Chat 的团队是「主频道 + 一组频道」的容器，成员与房间都挂在团队维度上。
 * 此前 RocketX 只能创建团队、在会话列表里看到它，建完就管不了；这里补齐
 * 房间（新建 / 挂载 / 移出 / 设为主频道）与成员（加 / 移出）以及改名、解散、退出。
 */
export default function TeamPanel({ onClose }: { onClose: () => void }) {
  const teamIdProp = useTeamPanel((s) => s.teamId);
  const seed = useTeamPanel((s) => s.seed);
  const me = useAuth((s) => s.user);
  const subscriptions = useChat((s) => s.subscriptions);
  const loadTeamInfo = useChat((s) => s.loadTeamInfo);
  const loadTeamRooms = useChat((s) => s.loadTeamRooms);
  const loadTeamMembers = useChat((s) => s.loadTeamMembers);
  const createTeamRoom = useChat((s) => s.createTeamRoom);

  const [team, setTeam] = useState<RcTeam | undefined>(seed);
  const [rooms, setRooms] = useState<RcTeamRoom[]>([]);
  const [members, setMembers] = useState<RcTeamMember[]>([]);
  const [tab, setTab] = useState<Tab>('rooms');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);

  // 没指定团队时，从会话里找第一个带 teamId 的房间作为默认
  const fallbackTeamId = useMemo(() => {
    const withTeam = Object.values(subscriptions).find((sub) => sub.teamId);
    return withTeam?.teamId ?? null;
  }, [subscriptions]);
  const teamId = teamIdProp ?? fallbackTeamId;

  const refresh = async (): Promise<void> => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [info, roomList, memberList] = await Promise.all([
        loadTeamInfo(teamId).catch(() => seed as RcTeam),
        loadTeamRooms(teamId).catch(() => [] as RcTeamRoom[]),
        loadTeamMembers(teamId).catch(() => [] as RcTeamMember[]),
      ]);
      setTeam(info);
      setRooms(roomList);
      setMembers(memberList);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载团队信息失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // 只按团队 id 重载；refresh 依赖的 store 动作是稳定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  const manageable = canManageTeam(me, team, members);
  const { main, others } = useMemo(() => sortTeamRooms(rooms), [rooms]);

  if (!teamId) {
    return (
      <Dialog title="团队管理" onClose={onClose} width={520}>
        <div className="px-5 py-6 text-sm text-ink-3">
          没有找到可管理的团队。先在左侧「+ → 创建团队」建一个，或从会话列表进入团队房间。
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`团队管理${team?.name ? ` · ${team.name}` : ''}`}
      hint="团队是一组频道的容器：成员与房间都在团队维度上管理。"
      width={560}
      onClose={onClose}
    >
      <div className="px-5 pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
          <span>{teamTypeLabel(team?.type)}</span>
          <span>{rooms.length} 个房间</span>
          <span>{members.length} 名成员</span>
          {team?.createdBy?.username && <span>创建者 {team.createdBy.username}</span>}
          {!manageable && <span className="text-warning">你在这个团队里没有管理权限</span>}
        </div>
        <div className="mt-3 flex gap-1.5">
          {(
            [
              ['rooms', `房间（${rooms.length}）`],
              ['members', `成员（${members.length}）`],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`h-8 rounded-md px-3 text-xs transition ${
                tab === key ? 'bg-primary-light text-primary' : 'text-ink-2 hover:bg-fill-hover'
              }`}
            >
              {label}
            </button>
          ))}
          <div className="ml-auto flex gap-1.5">
            {tab === 'rooms' && manageable && (
              <button
                onClick={() => setNewRoomOpen(true)}
                className="flex h-8 items-center gap-1 rounded-md bg-fill-1 px-2.5 text-xs text-ink-2 hover:bg-fill-hover hover:text-primary"
              >
                <Plus size={12} /> 新建团队频道
              </button>
            )}
            {tab === 'members' && manageable && (
              <button
                onClick={() => setAddMemberOpen(true)}
                className="flex h-8 items-center gap-1 rounded-md bg-fill-1 px-2.5 text-xs text-ink-2 hover:bg-fill-hover hover:text-primary"
              >
                <UserPlus size={12} /> 添加成员
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-h-[52vh] min-h-40 overflow-y-auto border-y border-line">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-3">
            <Loader2 size={14} className="animate-spin" /> 正在加载团队信息…
          </div>
        )}
        {!loading && error && <div className="px-5 py-6 text-sm text-danger">{error}</div>}
        {!loading && !error && tab === 'rooms' && (
          <TeamRoomList
            teamId={teamId}
            main={main}
            others={others}
            manageable={manageable}
            onChanged={() => void refresh()}
          />
        )}
        {!loading && !error && tab === 'members' && (
          <TeamMemberList
            teamId={teamId}
            members={members}
            meId={me?._id}
            manageable={manageable}
            onChanged={() => void refresh()}
          />
        )}
      </div>

      {manageable && (
        <TeamDangerZone teamId={teamId} rooms={rooms} teamName={team?.name ?? ''} onDone={onClose} />
      )}

      {newRoomOpen && (
        <NewTeamRoomDialog
          onCreate={async (name, priv) => {
            await createTeamRoom(teamId, name, priv);
            await refresh();
          }}
          onClose={() => setNewRoomOpen(false)}
        />
      )}
      {addMemberOpen && (
        <AddTeamMembersDialog
          onAdd={async (usernames) => {
            await useChat.getState().addTeamMembers(teamId, usernames);
            await refresh();
          }}
          onClose={() => setAddMemberOpen(false)}
        />
      )}
    </Dialog>
  );
}

/** 挂在应用根部：任何地方 openTeamPanel() 都能唤起 */
export function TeamPanelHost() {
  const open = useTeamPanel((s) => s.open);
  const close = useTeamPanel((s) => s.close);
  if (!open) return null;
  return <TeamPanel onClose={close} />;
}

function TeamRoomList({
  teamId,
  main,
  others,
  manageable,
  onChanged,
}: {
  teamId: string;
  main?: RcTeamRoom;
  others: RcTeamRoom[];
  manageable: boolean;
  onChanged: () => void;
}) {
  const openRoom = useChat((s) => s.openRoom);
  const removeRoomFromTeam = useChat((s) => s.removeRoomFromTeam);
  const setTeamMainRoom = useChat((s) => s.setTeamMainRoom);
  const subscriptions = useChat((s) => s.subscriptions);

  const row = (room: RcTeamRoom, isMain: boolean) => (
    <div key={room._id} className="flex items-center gap-2 border-b border-line px-4 py-2.5 last:border-b-0">
      {room.t === 'p' ? <Lock size={13} className="text-ink-3" /> : <Hash size={13} className="text-ink-3" />}
      <button
        onClick={() => void openRoom(room._id)}
        className="min-w-0 flex-1 truncate text-left text-sm text-ink hover:text-primary"
      >
        {roomLabel(room)}
      </button>
      {isMain && (
        <span className="flex items-center gap-0.5 rounded bg-primary-light px-1.5 py-0.5 text-xs text-primary">
          <Star size={10} /> 主频道
        </span>
      )}
      {!subscriptions[room._id] && <span className="text-xs text-ink-3">未加入</span>}
      {manageable && (
        <>
          {!isMain && (
            <button
              title="设为主频道"
              onClick={() => void setTeamMainRoom(teamId, room._id).then(onChanged)}
              className="text-xs text-ink-3 hover:text-primary"
            >
              设为主频道
            </button>
          )}
          <button
            title="移出团队（房间本身保留）"
            onClick={() => void removeRoomFromTeam(teamId, room._id).then(onChanged)}
            className="text-xs text-ink-3 hover:text-danger"
          >
            移出
          </button>
        </>
      )}
    </div>
  );

  if (!main && others.length === 0) {
    return <div className="px-5 py-6 text-sm text-ink-3">这个团队下还没有房间。</div>;
  }
  return (
    <div>
      {main && row(main, true)}
      {others.map((room) => row(room, false))}
    </div>
  );
}

function TeamMemberList({
  teamId,
  members,
  meId,
  manageable,
  onChanged,
}: {
  teamId: string;
  members: RcTeamMember[];
  meId?: string;
  manageable: boolean;
  onChanged: () => void;
}) {
  const removeTeamMember = useChat((s) => s.removeTeamMember);
  const [confirmTarget, setConfirmTarget] = useState<RcTeamMember | null>(null);

  if (members.length === 0) {
    return <div className="px-5 py-6 text-sm text-ink-3">没有取到团队成员。</div>;
  }
  return (
    <div>
      {members.map((member) => (
        <div key={member._id} className="flex items-center gap-2.5 border-b border-line px-4 py-2.5 last:border-b-0">
          <Avatar name={member.name || member.username} username={member.username} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-ink">{member.name || member.username}</div>
            <div className="truncate text-xs text-ink-3">@{member.username}</div>
          </div>
          {(member.roles ?? []).map((role) => (
            <span key={role} className="rounded bg-fill-1 px-1.5 py-0.5 text-xs text-ink-3">
              {role}
            </span>
          ))}
          {manageable && member._id !== meId && (
            <button
              title="移出团队（会从团队所有房间移除）"
              onClick={() => setConfirmTarget(member)}
              className="text-ink-3 transition hover:text-danger"
            >
              <UserMinus size={14} />
            </button>
          )}
        </div>
      ))}
      {confirmTarget && (
        <ConfirmDialog
          title="移出团队"
          message={`「${confirmTarget.name || confirmTarget.username}」会被移出团队的所有房间。房间里的历史消息不会删除。`}
          confirmLabel="移出"
          onConfirm={() => {
            void removeTeamMember(teamId, confirmTarget._id).then(onChanged);
            setConfirmTarget(null);
          }}
          onClose={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}

/** 改名 / 解散 / 退出。解散时让用户明确选「房间是否一并删除」 */
function TeamDangerZone({
  teamId,
  rooms,
  teamName,
  onDone,
}: {
  teamId: string;
  rooms: RcTeamRoom[];
  teamName: string;
  onDone: () => void;
}) {
  const renameTeam = useChat((s) => s.renameTeam);
  const deleteTeam = useChat((s) => s.deleteTeam);
  const leaveTeam = useChat((s) => s.leaveTeam);
  const [name, setName] = useState(teamName);
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [alsoDeleteRooms, setAlsoDeleteRooms] = useState(false);

  return (
    <div className="space-y-3 px-5 py-3">
      <div className="flex items-end gap-2">
        <label className="flex-1 text-xs text-ink-3">
          团队名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 h-8 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-primary"
          />
        </label>
        <button
          disabled={renaming || !name.trim() || name.trim() === teamName}
          onClick={() => {
            setRenaming(true);
            void renameTeam(teamId, name.trim())
              .catch((error) => toast.error(error, '改名失败'))
              .finally(() => setRenaming(false));
          }}
          className="h-8 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-40"
        >
          保存
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setLeaveOpen(true)}
          className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover"
        >
          <ArrowRightLeft size={12} /> 退出团队
        </button>
        <button
          onClick={() => setDeleteOpen(true)}
          className="flex h-8 items-center gap-1.5 rounded-md border border-danger px-3 text-xs text-danger hover:bg-danger/10"
        >
          <Trash2 size={12} /> 解散团队
        </button>
        <span className="text-xs text-ink-3">
          <Users size={11} className="mr-1 inline" />
          解散后房间可保留为普通房间
        </span>
      </div>

      {leaveOpen && (
        <ConfirmDialog
          title="退出团队"
          message={`退出「${teamName}」后不再接收团队消息，需要重新被邀请才能回来。`}
          confirmLabel="退出"
          onConfirm={() => {
            void leaveTeam(teamId).then(onDone);
            setLeaveOpen(false);
          }}
          onClose={() => setLeaveOpen(false)}
        />
      )}
      {deleteOpen && (
        <ConfirmDialog
          title={`解散团队${teamName ? `「${teamName}」` : ''}`}
          message={
            alsoDeleteRooms
              ? `团队和它的 ${rooms.length} 个房间都会被永久删除，聊天记录一并消失。这个操作无法撤销。`
              : '团队会被解散，房间保留为普通房间，聊天记录不丢。'
          }
          confirmLabel={alsoDeleteRooms ? '永久删除' : '解散团队'}
          onConfirm={() => {
            void deleteTeam(teamId, alsoDeleteRooms ? rooms.map((room) => room._id) : undefined).then(onDone);
            setDeleteOpen(false);
          }}
          onClose={() => setDeleteOpen(false)}
          extra={
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={alsoDeleteRooms}
                onChange={(event) => setAlsoDeleteRooms(event.target.checked)}
                className="accent-danger"
              />
              同时删除团队里的 {rooms.length} 个房间（不可撤销）
            </label>
          }
        />
      )}
    </div>
  );
}

function NewTeamRoomDialog({
  onCreate,
  onClose,
}: {
  onCreate: (name: string, priv: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      title="新建团队频道"
      hint="新频道会直接挂在团队下，团队成员共享。"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            disabled={busy || !name.trim()}
            onClick={() => {
              setBusy(true);
              void onCreate(name.trim(), priv)
                .then(onClose)
                .finally(() => setBusy(false));
            }}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <div className="space-y-3 px-5 pb-4">
        <label className="block text-xs text-ink-3">
          频道名称
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={priv}
            onChange={(event) => setPriv(event.target.checked)}
            className="accent-primary"
          />
          私有频道（仅受邀成员可见）
        </label>
      </div>
    </Dialog>
  );
}

/** 团队加成员：搜索用户 → 解析成 userId（`teams.addMembers` 要 userId） */
function AddTeamMembersDialog({
  onAdd,
  onClose,
}: {
  onAdd: (usernames: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Map<string, RcUser>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { users, warning } = useUserSearch(keyword);

  const toggle = (user: RcUser) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(user._id)) next.delete(user._id);
      else next.set(user._id, user);
      return next;
    });
  };

  return (
    <Dialog
      title="添加团队成员"
      hint="成员会被加入团队的主频道；需要进其他团队频道时，在频道里单独邀请。"
      onClose={busy ? () => {} : onClose}
      footer={
        <button
          disabled={busy || selected.size === 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            void onAdd([...selected.values()].map((user) => user.username))
              .then(onClose)
              .catch((err) => setError(err instanceof Error ? err.message : '添加失败'))
              .finally(() => setBusy(false));
          }}
          className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {busy ? '添加中…' : `添加${selected.size > 0 ? `（${selected.size}）` : ''}`}
        </button>
      }
    >
      <div className="px-5 pb-2">
        <input
          autoFocus
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索用户"
          className="h-8 w-full rounded-md bg-fill-1 px-2.5 text-sm outline-none placeholder:text-ink-3"
        />
      </div>
      {warning && <div className="px-5 pb-1 text-xs text-warning">{warning}</div>}
      <div className="max-h-64 overflow-y-auto px-2 pb-2">
        {users.map((user) => {
          const checked = selected.has(user._id);
          return (
            <button
              key={user._id}
              onClick={() => toggle(user)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-fill-hover"
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-xs ${
                  checked ? 'border-primary bg-primary text-white' : 'border-line bg-surface-4'
                }`}
              >
                {checked ? '✓' : ''}
              </span>
              <Avatar name={user.name || user.username} username={user.username} size={26} />
              <span className="truncate text-sm text-ink">{user.name || user.username}</span>
              <span className="text-xs text-ink-3">@{user.username}</span>
            </button>
          );
        })}
        {users.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            {keyword ? '未找到匹配的用户' : '输入用户名搜索'}
          </div>
        )}
      </div>
      {error && <div className="px-5 pb-2 text-xs text-danger">{error}</div>}
    </Dialog>
  );
}
