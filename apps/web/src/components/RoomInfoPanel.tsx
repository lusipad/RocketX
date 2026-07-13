import { useEffect, useMemo, useState } from 'react';
import type { RcRoom } from '@rcx/rc-client';
import {
  Bell,
  BellOff,
  Hash,
  Lock,
  LogOut,
  Megaphone,
  Pencil,
  Pin,
  PinOff,
  Tag,
  Users,
  UsersRound,
  X,
} from 'lucide-react';
import { rest } from '../lib/client';
import { buildConversations, useChat } from '../stores/chat';
import { displayName, useAliases } from '../stores/aliases';
import { fmtDayDivider } from '../lib/format';
import AliasDialog from './AliasDialog';
import Avatar from './Avatar';
import { ConfirmDialog } from './Dialog';
import PanelShell from './PanelShell';
import { SkeletonList } from './Skeleton';

/** 可就地编辑的一行（话题/公告/描述）。无权限时只读，保存失败会退回原值。 */
function EditableField({
  label,
  icon: Icon,
  value,
  placeholder,
  multiline,
  onSave,
}: {
  label: string;
  icon: typeof Megaphone;
  value?: string;
  placeholder: string;
  multiline?: boolean;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(value ?? ''), [value]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch {
      setDraft(value ?? ''); // 没权限就退回去，不要留着假状态
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-ink-3">
          <Icon size={12} />
          {label}
        </span>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-ink-3 transition hover:text-primary"
            title={`编辑${label}`}
          >
            <Pencil size={12} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          {multiline ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-primary px-2 py-1.5 text-sm outline-none"
            />
          ) : (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="h-8 w-full rounded-md border border-primary px-2 text-sm outline-none"
            />
          )}
          <div className="flex justify-end gap-1.5">
            <button
              onClick={() => {
                setDraft(value ?? '');
                setEditing(false);
              }}
              className="h-7 rounded border border-line px-2.5 text-xs text-ink-2 hover:bg-fill-hover"
            >
              取消
            </button>
            <button
              onClick={() => void save()}
              disabled={busy}
              className="h-7 rounded bg-primary px-2.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      ) : (
        <div className={`text-sm break-words ${value ? 'text-ink' : 'text-ink-3'}`}>
          {value || placeholder}
        </div>
      )}
    </div>
  );
}

/** 一个操作条目 */
function ActionRow({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: typeof Bell;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 border-b border-line px-4 py-2.5 text-left text-sm transition last:border-b-0 hover:bg-fill-hover ${
        danger ? 'text-danger' : 'text-ink'
      }`}
    >
      <Icon size={15} className={danger ? '' : 'text-ink-2'} />
      {label}
    </button>
  );
}

/**
 * 群信息（飞书的「群设置」）：头像、名称、公告、话题、成员、免打扰/收藏/退出。
 * 单聊显示对方资料，其余显示群资料。
 */
export default function RoomInfoPanel() {
  const rid = useChat((s) => s.activeRid);
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const setPanel = useChat((s) => s.setPanel);
  const loadMembers = useChat((s) => s.loadMembers);
  const saveRoomSettings = useChat((s) => s.saveRoomSettings);
  const toggleFavorite = useChat((s) => s.toggleFavorite);
  const toggleMute = useChat((s) => s.toggleMute);
  const leaveConv = useChat((s) => s.leaveConv);

  const aliases = useAliases((s) => s.aliases);
  const setUserAlias = useAliases((s) => s.setUserAlias);
  const setRoomAlias = useAliases((s) => s.setRoomAlias);

  const [info, setInfo] = useState<RcRoom | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const conv = useMemo(
    () => buildConversations(subscriptions, rooms).find((c) => c.rid === rid),
    [subscriptions, rooms, rid],
  );

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    setInfo(null);
    // rooms.info 拿到的字段比订阅全（公告、描述、创建者、创建时间）
    void rest
      .getRoomInfo(rid)
      .then(setInfo)
      .catch(() => setInfo(rooms[rid] ?? null))
      .finally(() => setLoading(false));
    void loadMembers(rid).then((m) => setMemberCount(m.length));
  }, [rid, loadMembers, rooms]);

  if (!rid || !conv) return null;

  const shownName = displayName(aliases, conv);
  const aliasIsUser = !!conv.avatarUsername;
  const currentAlias = aliasIsUser
    ? aliases[`u:${conv.avatarUsername}`]
    : aliases[`r:${conv.rid}`];

  const isDM = conv.type === 'd';
  const count = info?.usersCount ?? memberCount ?? undefined;
  const TypeIcon = conv.isTeam
    ? Users
    : conv.isMultiDM
      ? UsersRound
      : conv.type === 'p'
        ? Lock
        : conv.type === 'c'
          ? Hash
          : UsersRound;

  return (
    <PanelShell title={isDM && !conv.isMultiDM ? '联系人信息' : '群信息'}>
      <div className="flex-1 overflow-y-auto">
        {/* 头部：头像 + 名称 */}
        <div className="flex flex-col items-center gap-2 border-b border-line px-4 py-5">
          <Avatar name={shownName} username={conv.avatarUsername} size={64} />
          <div className="text-center">
            <div className="flex items-center justify-center gap-1.5 text-[15px] font-semibold text-ink">
              <TypeIcon size={14} className="text-ink-3" />
              {shownName}
            </div>
            {currentAlias && <div className="mt-0.5 text-xs text-ink-3">原名：{conv.name}</div>}
            {count !== undefined && !(isDM && !conv.isMultiDM) && (
              <button
                onClick={() => setPanel({ kind: 'members' })}
                className="mt-1 text-xs text-primary hover:underline"
              >
                {count} 名成员 →
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <SkeletonList rows={3} />
        ) : (
          <>
            {/* 群资料：单聊没有这些字段 */}
            {!isDM && (
              <>
                <EditableField
                  label="群公告"
                  icon={Megaphone}
                  value={info?.announcement}
                  placeholder="未设置公告"
                  multiline
                  onSave={(v) => saveRoomSettings(rid, { announcement: v })}
                />
                <EditableField
                  label="群话题"
                  icon={Tag}
                  value={info?.topic}
                  placeholder="未设置话题（显示在聊天窗顶部）"
                  onSave={(v) => saveRoomSettings(rid, { topic: v })}
                />
                <EditableField
                  label="群介绍"
                  icon={Pencil}
                  value={info?.description}
                  placeholder="未填写介绍"
                  multiline
                  onSave={(v) => saveRoomSettings(rid, { description: v })}
                />
              </>
            )}

            {info?.u && (
              <div className="border-b border-line px-4 py-3 text-xs text-ink-3">
                由 {info.u.name || info.u.username} 创建
                {info.ts ? ` · ${fmtDayDivider(new Date(info.ts as string).getTime())}` : ''}
              </div>
            )}

            {/* 操作 */}
            <ActionRow
              icon={Tag}
              label={currentAlias ? '修改备注名' : '设置备注名'}
              onClick={() => setAliasOpen(true)}
            />
            <ActionRow
              icon={conv.favorite ? PinOff : Pin}
              label={conv.favorite ? '取消收藏' : '收藏会话'}
              onClick={() => void toggleFavorite(conv)}
            />
            <ActionRow
              icon={conv.muted ? Bell : BellOff}
              label={conv.muted ? '取消免打扰' : '消息免打扰'}
              onClick={() => void toggleMute(conv)}
            />
            {!(isDM && !conv.isMultiDM) && (
              <ActionRow
                icon={Users}
                label="查看群成员"
                onClick={() => setPanel({ kind: 'members' })}
              />
            )}
            <ActionRow
              icon={isDM ? X : LogOut}
              label={isDM ? '隐藏会话' : '退出群组'}
              danger
              onClick={() => setConfirmLeave(true)}
            />
          </>
        )}
      </div>

      {aliasOpen && (
        <AliasDialog
          title={aliasIsUser ? '给联系人设置备注' : '给会话设置备注'}
          originalName={conv.name}
          current={currentAlias}
          onSubmit={(alias) =>
            aliasIsUser ? setUserAlias(conv.avatarUsername!, alias) : setRoomAlias(rid, alias)
          }
          onClose={() => setAliasOpen(false)}
        />
      )}
      {confirmLeave && (
        <ConfirmDialog
          title={isDM ? '隐藏会话' : '退出群组'}
          message={
            isDM
              ? `「${shownName}」会从列表消失，收到新消息时会自动回来，聊天记录不会丢。`
              : `退出「${shownName}」后将不再接收该群消息，需要重新被邀请才能回来。`
          }
          confirmLabel={isDM ? '隐藏' : '退出'}
          onConfirm={() => void leaveConv(conv)}
          onClose={() => setConfirmLeave(false)}
        />
      )}
    </PanelShell>
  );
}
