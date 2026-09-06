import { useEffect, useMemo, useState } from 'react';
import type { RcRoom, RcSubscription, RcUser } from '@rcx/rc-client';
import { Check, Hash, Lock, Plus, Search, X } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { useCommandUi, type CommandDialog } from '../stores/commandUi';
import { useUI } from '../stores/ui';
import { humanError, toast } from '../stores/toast';
import { composerCommands } from '../kernel/dispatch';
import { commandDesc, commandParams } from '../lib/slash';
import { personName, useAliases } from '../stores/aliases';
import { isMuted } from '../lib/roomAdmin';
import { POLL_MAX_OPTIONS } from '../lib/poll';
import Dialog, { ConfirmDialog } from './Dialog';
import Avatar from './Avatar';
import { AddMembersDialog } from './MembersPanel';
import { CreateGroupDialog, StartDMDialog } from './NewChatDialogs';

/**
 * 斜杠命令与功能入口共用的对话框集。
 *
 * runSlash / NavRail / Composer 等入口把要打开的对话框写进 commandUi store，
 * MainPage 挂载的这里负责渲染。每个对话框只做「选择 + 确认」，真正的动作
 * 复用 chat store 的既有实现（和 GUI 按钮走同一条路）。
 */

/** 当前会话名，确认框文案用 */
function roomName(rid: string): string {
  const sub = useChat.getState().subscriptions[rid];
  const room = useChat.getState().rooms[rid];
  return sub?.fname || sub?.name || room?.name || '当前会话';
}

function roomType(rid: string): RcSubscription['t'] {
  const s = useChat.getState();
  return s.subscriptions[rid]?.t ?? s.rooms[rid]?.t ?? 'c';
}

/** 话题编辑（/topic 与房间信息面板的 EditableField 走同一个 saveRoomSettings） */
function TopicDialog({ rid, prefill, onClose }: { rid: string; prefill: string; onClose: () => void }) {
  const current = useChat((s) => s.rooms[rid]?.topic) ?? '';
  const saveRoomSettings = useChat((s) => s.saveRoomSettings);
  const [value, setValue] = useState(prefill || current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doSave = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveRoomSettings(rid, { topic: value.trim() });
      toast.success('话题已更新');
      onClose();
    } catch (err) {
      setError(humanError(err, '保存失败，可能你没有编辑频道的权限'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="设置频道话题"
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => void doSave()}
            disabled={busy}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="px-5 pb-3">
        <textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          maxLength={120}
          placeholder="这个频道是做什么的？"
          className="w-full resize-none rounded-md border border-line px-3 py-2 text-sm leading-relaxed outline-none transition focus:border-primary"
        />
        {error && <div className="pt-1 text-xs text-danger">{error}</div>}
      </div>
    </Dialog>
  );
}

const PRESENCES: { value: string; label: string; dot: string }[] = [
  { value: 'online', label: '在线', dot: 'bg-success' },
  { value: 'away', label: '离开', dot: 'bg-warning' },
  { value: 'busy', label: '忙碌', dot: 'bg-danger' },
  { value: 'offline', label: '隐身', dot: 'bg-line' },
];

/** 状态编辑（/status；presence 与状态文案一次设置） */
function StatusDialog({ prefill, onClose }: { prefill: string; onClose: () => void }) {
  const user = useAuth((s) => s.user);
  const [presence, setPresence] = useState(user?.status ?? 'online');
  const [text, setText] = useState(prefill);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 状态文案不在订阅流上，打开时尽力回显一次，失败就留空
  useEffect(() => {
    if (!user?._id || prefill) return;
    let current = true;
    void rest
      .getUserInfoById(user._id)
      .then((info) => {
        if (!current) return;
        if (info.statusText) setText(info.statusText);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSave = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rest.setStatus(presence, text.trim() || undefined);
      if (user) useAuth.setState({ user: { ...user, status: presence } });
      toast.success('状态已更新');
      onClose();
    } catch (err) {
      setError(humanError(err, '状态设置失败'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="设置状态"
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => void doSave()}
            disabled={busy}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="space-y-3 px-5 pb-3">
        <div className="grid grid-cols-4 gap-1.5">
          {PRESENCES.map((p) => (
            <button
              key={p.value}
              onClick={() => setPresence(p.value)}
              className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-sm transition ${
                presence === p.value
                  ? 'border-primary bg-primary-light text-ink'
                  : 'border-line text-ink-2 hover:bg-fill-hover'
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${p.dot}`} />
              {p.label}
            </button>
          ))}
        </div>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={120}
          placeholder="状态文案，例如：开会中，下午回复"
          className="h-9 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary"
        />
        {error && <div className="text-xs text-danger">{error}</div>}
      </div>
    </Dialog>
  );
}

/** 搜索并加入公开频道（/join；未加入的加入并跳转，已加入的直接打开） */
function JoinChannelDialog({ prefill, onClose }: { prefill: string; onClose: () => void }) {
  const [keyword, setKeyword] = useState(prefill);
  const [result, setResult] = useState<{ query: string; list: { rid: string; name: string; topic: string; joined: boolean; priv: boolean }[] }>({ query: '', list: [] });
  const [searching, setSearching] = useState(false);
  const [busyRid, setBusyRid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 目录浏览（空关键词）：directory 有 total 可分页，spotlight 只能搜
  const [browse, setBrowse] = useState<{ list: typeof result.list; total: number; loading: boolean; failed: boolean }>({
    list: [],
    total: 0,
    loading: true,
    failed: false,
  });

  const loadBrowse = (offset: number) => {
    setBrowse((prev) => ({ ...prev, loading: true }));
    void rest
      .directory('channels', '', 30, offset)
      .then(({ result: rooms, total }) => {
        setBrowse((prev) => {
          const s = useChat.getState();
          const page = rooms.map((r) => ({
            rid: r._id,
            name: r.fname || r.name || r._id,
            topic: r.topic ?? '',
            joined: !!s.subscriptions[r._id],
            priv: r.t === 'p',
          }));
          return {
            list: offset === 0 ? page : [...prev.list, ...page.filter((p) => !prev.list.some((x) => x.rid === p.rid))],
            total,
            loading: false,
            failed: false,
          };
        });
      })
      .catch(() => {
        // 目录可能因权限不可用（view-outside-room），退化为「请搜索」
        setBrowse((prev) => ({ ...prev, loading: false, failed: true, list: offset === 0 ? [] : prev.list }));
      });
  };

  // 空关键词进浏览模式；有关键词走 spotlight 搜索
  useEffect(() => {
    const q = keyword.trim().replace(/^#/, '');
    if (!q) {
      setResult({ query: '', list: [] });
      setSearching(false);
      setError(null);
      loadBrowse(0);
      return;
    }
    let current = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void rest
        .spotlight(q)
        .then(({ rooms: found }) => {
          if (!current) return;
          const s = useChat.getState();
          setResult({
            query: q,
            list: found
              .filter((r) => r.t !== 'd')
              .map((r) => ({
                rid: r._id,
                name: r.fname || r.name || r._id,
                topic: r.topic ?? '',
                joined: !!s.subscriptions[r._id],
                priv: r.t === 'p',
              })),
          });
          setSearching(false);
        })
        .catch((err) => {
          if (!current) return;
          setError(humanError(err, '搜索频道失败'));
          setSearching(false);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  const open = async (target: { rid: string; joined: boolean }) => {
    if (busyRid) return;
    setBusyRid(target.rid);
    setError(null);
    try {
      if (target.joined) await useChat.getState().openRoom(target.rid);
      else await useChat.getState().joinRoom(target.rid);
      onClose();
    } catch (err) {
      setError(humanError(err, '打开失败'));
      setBusyRid(null);
    }
  };

  return (
    <Dialog title="加入频道" onClose={onClose}>
      <div className="px-5 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-md bg-fill-1 px-2.5">
          <Search size={14} className="text-ink-3" />
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索公开频道，支持 # 或直接输入名字"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>
      {error && <div className="px-5 pb-1 text-xs text-danger">{error}</div>}
      <div className="min-h-40 flex-1 overflow-y-auto px-2 pb-3">
        {(keyword.trim() ? result.list : browse.list).map((r) => (
          <button
            key={r.rid}
            onClick={() => void open(r)}
            disabled={busyRid !== null}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-fill-hover disabled:opacity-60"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-fill-1 text-ink-2">
              {r.priv ? <Lock size={14} /> : <Hash size={14} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{r.name}</span>
              {r.topic && <span className="block truncate text-xs text-ink-3">{r.topic}</span>}
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                r.joined ? 'bg-fill-1 text-ink-3' : 'bg-primary-light text-primary'
              }`}
            >
              {busyRid === r.rid ? '打开中…' : r.joined ? '已加入 · 打开' : '加入'}
            </span>
          </button>
        ))}
        {!keyword.trim() && !browse.loading && browse.list.length < browse.total && (
          <button
            onClick={() => loadBrowse(browse.list.length)}
            className="mt-1 w-full rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-2 transition hover:border-primary hover:text-primary"
          >
            加载更多（已显示 {browse.list.length}/{browse.total}）
          </button>
        )}
        {keyword.trim() && !searching && result.query && result.list.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">没有找到匹配的频道</div>
        )}
        {!keyword.trim() && !browse.loading && browse.list.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">
            {browse.failed ? '目录不可浏览，输入关键字搜索频道' : '还没有可加入的频道'}
          </div>
        )}
        {((!keyword.trim() && browse.loading) || (keyword.trim() && searching)) && (
          <div className="py-8 text-center text-sm text-ink-3">加载中…</div>
        )}
      </div>
    </Dialog>
  );
}

const MEMBER_ACTIONS: Record<
  'kick' | 'mute' | 'unmute' | 'ban' | 'unban',
  { title: string; confirm: string; hint: (name: string) => string }
> = {
  kick: {
    title: '移出成员',
    confirm: '移出',
    hint: (name) => `确定把「${name}」移出吗？TA 将不再收到本频道消息，需要重新邀请才能回来。`,
  },
  mute: { title: '禁言成员', confirm: '禁言', hint: (name) => `确定禁言「${name}」吗？TA 将无法在本频道发言。` },
  unmute: { title: '解除禁言', confirm: '解除', hint: (name) => `解除「${name}」的禁言，恢复 TA 在本频道的发言权限。` },
  ban: {
    title: '封禁用户',
    confirm: '封禁',
    hint: (name) => `确定封禁「${name}」吗？这是服务器级操作，TA 将无法再使用这个工作区。`,
  },
  unban: { title: '解除封禁', confirm: '解封', hint: (name) => `解除「${name}」的账号封禁。` },
};

/** 成员选择 + 确认（/kick /mute /unmute /ban /unban 共用） */
function MemberActionDialog({
  rid,
  action,
  prefill,
  onClose,
}: {
  rid: string;
  action: 'kick' | 'mute' | 'unmute' | 'ban' | 'unban';
  prefill: string;
  onClose: () => void;
}) {
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const muted = useChat((s) => s.rooms[rid]?.muted);
  const [members, setMembers] = useState<RcUser[]>(useChat.getState().members[rid] ?? []);
  const [keyword, setKeyword] = useState('');
  const [target, setTarget] = useState<RcUser | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = MEMBER_ACTIONS[action];
  const isDirect = roomType(rid) === 'd';

  useEffect(() => {
    void useChat.getState().loadMembers(rid).then(setMembers);
  }, [rid]);

  // 命令预填：/@用户名/ 直接选中目标
  useEffect(() => {
    const wanted = prefill.replace(/^@/, '').toLowerCase();
    if (!wanted) return;
    const hit = members.find((m) => m.username.toLowerCase() === wanted);
    if (hit) setTarget(hit);
  }, [members, prefill]);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.username.toLowerCase().includes(q) ||
        (m.name ?? '').toLowerCase().includes(q) ||
        (aliases[`u:${m.username}`] ?? '').includes(q),
    );
  }, [members, keyword, aliases]);

  const execute = async (user: RcUser) => {
    setError(null);
    try {
      if (action === 'kick') {
        await useChat.getState().kickMember(rid, user);
      } else if (action === 'mute' || action === 'unmute') {
        const now = isMuted(useChat.getState().rooms[rid]?.muted, user.username);
        if (action === 'mute' && now) {
          toast.info(`「${user.username}」已经被禁言了`);
        } else if (action === 'unmute' && !now) {
          toast.info(`「${user.username}」没有被禁言`);
        } else {
          await useChat.getState().toggleMemberMute(rid, user);
        }
      } else {
        await rest.runCommand(action, rid, user.username);
        toast.success(action === 'ban' ? `已封禁「${user.username}」` : `已解除「${user.username}」的封禁`);
      }
      onClose();
    } catch (err) {
      setConfirming(false);
      setError(humanError(err, '操作失败，可能你没有相应权限'));
    }
  };

  return (
    <>
      <Dialog
        title={meta.title}
        hint={isDirect ? '私聊/多人聊天没有成员管理能力，请先创建频道或群组。' : undefined}
        onClose={onClose}
        footer={
          <button
            onClick={() => target && setConfirming(true)}
            disabled={!target || isDirect}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {meta.confirm}
          </button>
        }
      >
        <div className="px-5 pb-2">
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
        <div className="min-h-40 flex-1 overflow-y-auto px-2 pb-3">
          {filtered.map((m) => {
            const checked = target?._id === m._id;
            const shown = personName(aliases, m.username, m.name || m.username, nameFormat);
            return (
              <button
                key={m._id}
                onClick={() => setTarget(m)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-fill-hover"
              >
                <span
                  className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition ${
                    checked ? 'border-primary bg-primary text-white' : 'border-line bg-surface-4'
                  }`}
                >
                  {checked && <Check size={12} strokeWidth={3} />}
                </span>
                <Avatar name={shown} username={m.username} size={28} />
                <span className="truncate text-sm text-ink">{shown}</span>
                <span className="text-xs text-ink-3">@{m.username}</span>
                {(action === 'mute' || action === 'unmute') && (
                  <span className="ml-auto shrink-0 rounded bg-fill-1 px-1.5 py-0.5 text-xs text-ink-3">
                    {isMuted(muted, m.username) ? '已禁言' : '未禁言'}
                  </span>
                )}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-ink-3">
              {members.length === 0 ? '成员列表加载中…' : '没有匹配的成员'}
            </div>
          )}
        </div>
        {error && <div className="px-5 pb-1 text-xs text-danger">{error}</div>}
      </Dialog>
      {confirming && target && (
        <ConfirmDialog
          title={meta.title}
          message={meta.hint(personName(aliases, target.username, target.name || target.username, nameFormat))}
          confirmLabel={meta.confirm}
          danger={action !== 'unmute' && action !== 'unban'}
          onConfirm={() => void execute(target)}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** 从其他频道把成员整批邀请过来（/invite-all-from /invite-all-to；成员面板按钮共用） */
function RoomPickerDialog({
  rid,
  mode,
  onClose,
}: {
  rid: string;
  mode: 'invite-all-from' | 'invite-all-to';
  onClose: () => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [list, setList] = useState<{ rid: string; name: string; joined: boolean; members: number | null }[]>([]);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<{ rid: string; name: string } | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRid = mode === 'invite-all-from' ? target?.rid ?? null : rid;
  const destRid = mode === 'invite-all-from' ? rid : target?.rid ?? null;

  // 找频道：spotlight 一次搜索；空关键词不请求，等输入再搜
  useEffect(() => {
    let current = true;
    const q = keyword.trim().replace(/^#/, '');
    if (!q) {
      setList([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      const s = useChat.getState();
      void rest
        .spotlight(q)
        .then(({ rooms }) => {
          if (!current) return;
          setList(
            rooms
              .filter((r) => r._id !== rid && r.t !== 'd')
              .map((r) => ({
                rid: r._id,
                name: r.fname || r.name || r._id,
                joined: !!s.subscriptions[r._id],
                members: (r as RcRoom & { usersCount?: number }).usersCount ?? null,
              })),
          );
          setSearching(false);
        })
        .catch(() => {
          if (!current) return;
          setList([]);
          setSearching(false);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [keyword, rid]);

  // 选中后统计「实际会邀请多少人」（剔除目标频道已有的成员）
  useEffect(() => {
    if (!sourceRid || !destRid) return;
    let current = true;
    setCounting(true);
    setCount(null);
    void Promise.all([
      rest.getMembers(sourceRid, roomType(sourceRid)),
      rest.getMembers(destRid, roomType(destRid)).catch(() => [] as RcUser[]),
    ])
      .then(([source, dest]) => {
        if (!current) return;
        const existing = new Set(dest.map((u) => u.username));
        setCount(source.filter((u) => !existing.has(u.username)).length);
        setCounting(false);
      })
      .catch(() => {
        if (!current) return;
        setCount(null);
        setCounting(false);
      });
    return () => {
      current = false;
    };
  }, [sourceRid, destRid]);

  const doInvite = async () => {
    if (!sourceRid || !destRid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const users = await rest.getMembers(sourceRid, roomType(sourceRid));
      const dest = await rest.getMembers(destRid, roomType(destRid)).catch(() => [] as RcUser[]);
      const existing = new Set(dest.map((u) => u.username));
      const pending = users.filter((u) => !existing.has(u.username));
      if (pending.length === 0) {
        toast.info('对方的成员都已经在频道里了，没有需要邀请的人');
        onClose();
        return;
      }
      await useChat.getState().inviteMembers(destRid, pending);
      onClose();
    } catch (err) {
      setError(humanError(err, '批量邀请失败'));
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        title={mode === 'invite-all-from' ? '从其他频道导入成员' : '把成员邀请到其他频道'}
        hint={
          mode === 'invite-all-from'
            ? `选择一个频道，把它的成员（除已在「${roomName(rid)}」里的）批量邀请进来。`
            : `把「${roomName(rid)}」的成员批量邀请到你选的频道。`
        }
        onClose={onClose}
        footer={
          <button
            onClick={() => void doInvite()}
            disabled={!target || counting || busy || count === 0}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy
              ? '邀请中…'
              : count === 0 && target
                ? '没有可邀请的成员'
                : counting
                  ? '统计中…'
                  : `邀请${count !== null ? `（${count} 人）` : ''}`}
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
              placeholder="搜索频道"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
            />
          </div>
        </div>
        <div className="min-h-40 max-h-64 flex-1 overflow-y-auto px-2 pb-3">
          {list.map((r) => {
            const checked = target?.rid === r.rid;
            return (
              <button
                key={r.rid}
                onClick={() => setTarget({ rid: r.rid, name: r.name })}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-fill-hover"
              >
                <span
                  className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition ${
                    checked ? 'border-primary bg-primary text-white' : 'border-line bg-surface-4'
                  }`}
                >
                  {checked && <Check size={12} strokeWidth={3} />}
                </span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-fill-1 text-ink-2">
                  <Hash size={14} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{r.name}</span>
                {r.members !== null && (
                  <span className="shrink-0 text-xs text-ink-3">{r.members} 人</span>
                )}
              </button>
            );
          })}
          {!searching && list.length === 0 && (
            <div className="py-8 text-center text-sm text-ink-3">
              {keyword ? '没有找到匹配的频道' : '输入关键字搜索频道'}
            </div>
          )}
        </div>
        {error && <div className="px-5 pb-1 text-xs text-danger">{error}</div>}
      </Dialog>
    </>
  );
}

/** 归档 / 取消归档确认（/archive /unarchive；与房间信息面板同一动作） */
function ArchiveDialog({
  rid,
  archive,
  onClose,
}: {
  rid: string;
  archive: boolean;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title={archive ? '归档频道' : '取消归档'}
      message={
        archive
          ? `确定归档「${roomName(rid)}」吗？归档后频道保留历史，但不再接收新消息。`
          : `确定取消「${roomName(rid)}」的归档吗？取消后恢复收发消息。`
      }
      confirmLabel={archive ? '归档' : '取消归档'}
      danger={archive}
      onConfirm={() => {
        void useChat.getState().archiveConv(rid, archive);
      }}
      onClose={onClose}
    />
  );
}

/** 退出频道确认（/leave /part；DM 由 leaveConv 自动转隐藏） */
function LeaveDialog({ rid, onClose }: { rid: string; onClose: () => void }) {
  const sub = useChat((s) => s.subscriptions[rid]);
  const priv = roomType(rid) === 'p';
  return (
    <ConfirmDialog
      title="退出频道"
      message={
        priv
          ? `确定退出「${sub?.fname || sub?.name || roomName(rid)}」吗？这是私有群组，退出后需要成员重新邀请才能回来。`
          : `确定退出「${sub?.fname || sub?.name || roomName(rid)}」吗？公开频道之后可以随时再加入。`
      }
      confirmLabel="退出"
      onConfirm={() => {
        if (sub) {
          void useChat
            .getState()
            .leaveConv({ rid: sub.rid, name: sub.fname || sub.name, type: sub.t });
        } else {
          toast.show({ kind: 'error', message: '当前会话状态异常，请刷新后重试' });
        }
      }}
      onClose={onClose}
    />
  );
}

/** 全部斜杠命令参考（/help、Composer「?」按钮；点击插入输入框） */
export function CommandHelpDialog({ onClose }: { onClose: () => void }) {
  const serverCommands = useChat((s) => s.slashCommands);
  const seedComposer = useUI((s) => s.seedComposer);
  const [keyword, setKeyword] = useState('');
  const commands = useMemo(() => {
    const list = composerCommands(serverCommands);
    const q = keyword.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) =>
        c.command.toLowerCase().includes(q) ||
        commandDesc(c).toLowerCase().includes(q),
    );
  }, [serverCommands, keyword]);

  return (
    <Dialog title="斜杠命令" hint="点击命令把它填进输入框，接着补参数即可。" width={460} onClose={onClose}>
      <div className="px-5 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-md bg-fill-1 px-2.5">
          <Search size={14} className="text-ink-3" />
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索命令或说明"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
      </div>
      <div className="min-h-52 max-h-80 flex-1 overflow-y-auto px-2 pb-3">
        {commands.map((c) => {
          const desc = commandDesc(c);
          const params = commandParams(c);
          return (
            <button
              key={c.command}
              onClick={() => {
                seedComposer(`/${c.command} `);
                onClose();
              }}
              className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition hover:bg-fill-hover"
            >
              <span className="flex items-baseline gap-2">
                <span className="font-medium text-ink">/{c.command}</span>
                {params && <span className="truncate text-xs text-ink-3">{params}</span>}
              </span>
              <span className="text-xs text-ink-3">{desc}</span>
            </button>
          );
        })}
        {commands.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-3">没有匹配的命令</div>
        )}
      </div>
    </Dialog>
  );
}

/** 发起投票（/poll、Composer 工具栏按钮共用）；选项行动态增删，票用数字表情计 */
function PollCreatorDialog({ rid, prefill, onClose }: { rid: string; prefill: string; onClose: () => void }) {
  const [question, setQuestion] = useState(prefill);
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validOptions = options.map((o) => o.trim()).filter(Boolean);
  const canSubmit = !!question.trim() && validOptions.length >= 2 && !busy;

  const setOption = (i: number, value: string) =>
    setOptions((prev) => prev.map((o, j) => (j === i ? value : o)));
  const removeOption = (i: number) =>
    setOptions((prev) => (prev.length > 2 ? prev.filter((_, j) => j !== i) : prev));
  const addOption = () =>
    setOptions((prev) => (prev.length < POLL_MAX_OPTIONS ? [...prev, ''] : prev));

  const doCreate = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await useChat
        .getState()
        .sendPoll(rid, { question: question.trim(), options: validOptions, multi });
      onClose();
    } catch (err) {
      setError(humanError(err, '发起投票失败'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="发起投票"
      hint={`成员点击消息里的数字表情计票，官方客户端用表情也能参与（2-${POLL_MAX_OPTIONS} 个选项）。`}
      width={460}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => void doCreate()}
            disabled={!canSubmit}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '发布中…' : '发布投票'}
          </button>
        </>
      }
    >
      <div className="space-y-2.5 px-5 pb-3">
        <input
          autoFocus
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={120}
          placeholder="投票问题，例如：周三团建去哪？"
          className="h-9 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary"
        />
        {options.map((option, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-center text-sm text-ink-3">{i + 1}</span>
            <input
              value={option}
              onChange={(e) => setOption(i, e.target.value)}
              maxLength={80}
              placeholder={`选项 ${i + 1}`}
              className="h-8 min-w-0 flex-1 rounded-md border border-line px-2.5 text-sm outline-none transition focus:border-primary"
            />
            <button
              title="删除选项"
              onClick={() => removeOption(i)}
              disabled={options.length <= 2}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-danger disabled:opacity-30"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {options.length < POLL_MAX_OPTIONS && (
          <button
            onClick={addOption}
            className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-3 text-xs text-ink-2 transition hover:border-primary hover:text-primary"
          >
            <Plus size={13} />
            加一个选项
          </button>
        )}
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={multi}
            onChange={(e) => setMulti(e.target.checked)}
            className="accent-primary"
          />
          允许多选
        </label>
        {error && <div className="text-xs text-danger">{error}</div>}
      </div>
    </Dialog>
  );
}

/** MainPage 挂载的命令对话框宿主：按 pending 渲染对应实现 */
export default function CommandDialogs() {
  const pending = useCommandUi((s) => s.pending);
  const close = useCommandUi((s) => s.close);
  if (!pending) return null;
  const dialog: CommandDialog = pending;

  switch (dialog.kind) {
    case 'topic':
      return <TopicDialog rid={dialog.rid} prefill={dialog.prefill} onClose={close} />;
    case 'status':
      return <StatusDialog prefill={dialog.prefill} onClose={close} />;
    case 'join':
      return <JoinChannelDialog prefill={dialog.prefill} onClose={close} />;
    case 'member':
      return (
        <MemberActionDialog
          rid={dialog.rid}
          action={dialog.action}
          prefill={dialog.prefill}
          onClose={close}
        />
      );
    case 'roomPick':
      return <RoomPickerDialog rid={dialog.rid} mode={dialog.mode} onClose={close} />;
    case 'invite':
      return <AddMembersDialog rid={dialog.rid} prefill={dialog.prefill} onClose={close} />;
    case 'create':
      return (
        <CreateGroupDialog
          initialName={dialog.prefill}
          initialPrivate={dialog.priv}
          onClose={close}
        />
      );
    case 'dm':
      return (
        <StartDMDialog initialKeyword={dialog.prefill} draft={dialog.draft} onClose={close} />
      );
    case 'archive':
      return <ArchiveDialog rid={dialog.rid} archive={dialog.archive} onClose={close} />;
    case 'leave':
      return <LeaveDialog rid={dialog.rid} onClose={close} />;
    case 'poll':
      return <PollCreatorDialog rid={dialog.rid} prefill={dialog.prefill} onClose={close} />;
    case 'help':
      return <CommandHelpDialog onClose={close} />;
    default:
      return null;
  }
}
