import { useEffect, useMemo, useRef, useState } from 'react';
import { tsMs, type RcRoomRole } from '@rcx/rc-client';
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Bell,
  BellOff,
  CalendarClock,
  Copy,
  Files,
  Hash,
  Loader2,
  Lock,
  LogOut,
  Megaphone,
  MessageSquareOff,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Tag,
  Trash2,
  Type,
  Users,
  UsersRound,
  X,
} from 'lucide-react';
import { useAuth } from '../stores/auth';
import { buildConversations, useChat } from '../stores/chat';
import { displayName, useAliases } from '../stores/aliases';
import { canManageRoom, canTransferOwnership } from '../lib/roomAdmin';
import { useI18n, useT } from '../i18n';
import { formatDate } from '../i18n/format';
import AliasDialog from './AliasDialog';
import Avatar from './Avatar';
import { ConfirmDialog, default as Dialog } from './Dialog';
import CreateRoomDiscussionDialog from './CreateRoomDiscussionDialog';
import { openHistoryCopy } from '../stores/historyCopyUi';
import { openTeamPanel } from '../stores/teamUi';
import PanelShell from './PanelShell';
import { SkeletonList } from './Skeleton';

/** 稳定的空数组（不能在选择器里现造，见下方 roomRoles 的注释） */
const NO_ROLES: RcRoomRole[] = [];

/**
 * 可就地编辑的一行（群名/话题/公告/描述）。
 *
 * `readOnly` 时不显示铅笔按钮 —— 以前是所有人都能点开编辑框，普通成员改完保存，
 * 服务端一个 unauthorized 打回来，内容回退、弹个「保存失败」。一个必然失败的入口，
 * 不如根本不给。
 */
function EditableField({
  label,
  icon: Icon,
  value,
  placeholder,
  multiline,
  readOnly,
  onSave,
}: {
  label: string;
  icon: typeof Megaphone;
  value?: string;
  placeholder: string;
  multiline?: boolean;
  readOnly?: boolean;
  onSave: (next: string) => Promise<void>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const composing = useRef(false);

  useEffect(() => setDraft(value ?? ''), [value]);

  const save = async () => {
    if (saving.current || composing.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch {
      setDraft(value ?? ''); // 没权限就退回去，不要留着假状态
    } finally {
      saving.current = false;
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
        {!editing && !readOnly && (
          <button
            onClick={() => setEditing(true)}
            className="text-ink-3 transition hover:text-primary"
            title={t('panels.roomInfo.editFieldTitle', { label })}
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
              aria-label={label}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
              onKeyDown={(e) => {
                if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) {
                  // 选词时的 Escape 也不能冒泡到全局快捷键并关闭群信息面板。
                  e.stopPropagation();
                  return;
                }
                if (busy) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                }
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(false);
                }
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
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void save()}
              disabled={busy}
              className="h-7 rounded bg-primary px-2.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? t('panels.roomInfo.saving') : t('common.save')}
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
      <Icon size={14} className={danger ? '' : 'text-ink-2'} />
      {label}
    </button>
  );
}

/**
 * 群信息（飞书的「群设置」）：头像、名称、公告、话题、成员、免打扰/收藏/退出。
 * 单聊显示对方资料，其余显示群资料。
 */
export default function RoomInfoPanel() {
  const { t, tp, locale } = useI18n();
  const rid = useChat((s) => s.activeRid);
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const setPanel = useChat((s) => s.setPanel);
  const loadMembers = useChat((s) => s.loadMembers);
  const refreshMembers = useChat((s) => s.refreshMembers);
  const loadRoomRoles = useChat((s) => s.loadRoomRoles);
  const refreshRoomInfo = useChat((s) => s.refreshRoomInfo);
  const saveRoomSettings = useChat((s) => s.saveRoomSettings);
  const toggleFavorite = useChat((s) => s.toggleFavorite);
  const toggleMute = useChat((s) => s.toggleMute);
  const leaveConv = useChat((s) => s.leaveConv);
  const setRoomReadOnly = useChat((s) => s.setRoomReadOnly);
  const archiveConv = useChat((s) => s.archiveConv);
  const deleteConv = useChat((s) => s.deleteConv);
  const discussionsEnabled = useChat((s) => s.discussionsEnabled);
  const convertRoomToTeam = useChat((s) => s.convertRoomToTeam);
  // `?? NO_ROLES` 不能写进选择器里：那样每次调用都返回新数组，
  // useSyncExternalStore 会判定状态一直在变 → 无限循环 → 白屏
  const roomRoles = useChat((s) => (s.activeRid ? s.roomRoles[s.activeRid] : undefined)) ?? NO_ROLES;
  const me = useAuth((s) => s.user);

  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const setUserAlias = useAliases((s) => s.setUserAlias);
  const setRoomAlias = useAliases((s) => s.setRoomAlias);

  // 成员数直接读 store，不留本地快照：拉人成功后 store 里的成员列表和房间人数
  // 会一起更新，本地快照只会停在打开面板那一刻（issue #375：群人数变了、群信息
  // 里还是一个人）。
  const memberList = useChat((s) => (s.activeRid ? s.members[s.activeRid] : undefined));
  const memberError = useChat((s) => (s.activeRid ? s.memberErrors[s.activeRid] : undefined));
  const [loading, setLoading] = useState(true);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 在房间里创建讨论（Rocket.Chat 允许不带来源消息）
  const [discussionOpen, setDiscussionOpen] = useState(false);
  // 把当前频道/群组升级为团队
  const [convertTeamOpen, setConvertTeamOpen] = useState(false);

  const conv = useMemo(
    () => buildConversations(subscriptions, rooms).find((c) => c.rid === rid),
    [subscriptions, rooms, rid],
  );
  // 房间详情直接读 store（rooms.info 的结果由 refreshRoomInfo 并回去），
  // 这样成员面板改了禁言名单、这里的归档/只读状态都能立刻跟着变
  const info = rid ? rooms[rid] : undefined;

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    // rooms.info 的字段比订阅全（公告、描述、创建者、只读、归档、禁言名单）。
    // 只在切换会话时拉一次——依赖里放 rooms 的话，每来一条新消息 rooms 引用就变，
    // 会话越活跃请求越多。
    void refreshRoomInfo(rid).finally(() => setLoading(false));
    void loadRoomRoles(rid);
    void loadMembers(rid);
  }, [rid, loadMembers, loadRoomRoles, refreshRoomInfo]);

  // 房间人数变了（自己拉了人，或别人在其它端加/退），成员缓存不会自己失效，
  // 这里按人数差异补一次强制刷新，避免面板停在旧成员列表上（issue #375）。
  const roomUsersCount = rid ? rooms[rid]?.usersCount : undefined;
  useEffect(() => {
    if (!rid || roomUsersCount === undefined) return;
    const cached = useChat.getState().members[rid];
    if (cached && cached.length !== roomUsersCount) void refreshMembers(rid);
  }, [rid, roomUsersCount, refreshMembers]);

  if (!rid || !conv) return null;

  const shownName = displayName(aliases, conv, nameFormat);
  const aliasIsUser = !!conv.avatarUsername;
  const currentAlias = aliasIsUser
    ? aliases[`u:${conv.avatarUsername}`]
    : aliases[`r:${conv.rid}`];

  const isDM = conv.type === 'd';
  // 成员接口失败时 store 里留的是旧缓存/空数组；这种情况回退 rooms.info 的人数，
  // 否则一次失败就把群显示成 0 人。
  const count = (memberError ? undefined : memberList?.length) ?? info?.usersCount ?? undefined;
  // 多人聊天在 RC 里仍是 DM（t='d'），没有频道那套管理能力 ——
  // 这个判断在 canManageRoom 里按房间类型做掉了，这里不用再写 !isDM
  const canManage = canManageRoom(me, roomRoles, conv.type);
  const canDelete = canTransferOwnership(me, roomRoles, conv.type);
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
    <PanelShell
      title={
        isDM && !conv.isMultiDM ? t('panels.roomInfo.contactTitle') : t('panels.roomInfo.roomTitle')
      }
    >
      <div className="flex-1 overflow-y-auto">
        {/* 头部：头像 + 名称 */}
        <div className="flex flex-col items-center gap-2 border-b border-line px-4 py-5">
          <Avatar
            name={shownName}
            username={conv.avatarUsername}
            roomId={conv.avatarUsername ? undefined : conv.rid}
            size={64}
          />
          <div className="text-center">
            <div className="flex items-center justify-center gap-1.5 text-base font-semibold text-ink">
              <TypeIcon size={14} className="text-ink-3" />
              {shownName}
            </div>
            {currentAlias && nameFormat === 'alias' && (
              <div className="mt-0.5 text-xs text-ink-3">
                {t('panels.roomInfo.originalName', { name: conv.name })}
              </div>
            )}
            {count !== undefined && !(isDM && !conv.isMultiDM) && (
              <button
                onClick={() => setPanel({ kind: 'members' })}
                className="mt-1 text-xs text-primary hover:underline"
              >
                {tp(count, 'panels.roomInfo.memberCountArrow.one', 'panels.roomInfo.memberCountArrow.other')}
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
                {canManage && (
                  <EditableField
                    label={t('panels.roomInfo.field.name')}
                    icon={Type}
                    value={info?.fname ?? info?.name}
                    placeholder={t('panels.roomInfo.field.namePlaceholder')}
                    onSave={(v) => saveRoomSettings(rid, { name: v })}
                  />
                )}
                {/* 公告/话题/介绍：普通成员看得见，但改不了（服务端也只让管理员改） */}
                <EditableField
                  label={t('panels.roomInfo.field.announcement')}
                  icon={Megaphone}
                  value={info?.announcement}
                  placeholder={t('panels.roomInfo.field.announcementPlaceholder')}
                  multiline
                  readOnly={!canManage}
                  onSave={(v) => saveRoomSettings(rid, { announcement: v })}
                />
                <EditableField
                  label={t('panels.roomInfo.field.topic')}
                  icon={Tag}
                  value={info?.topic}
                  placeholder={t('panels.roomInfo.field.topicPlaceholder')}
                  readOnly={!canManage}
                  onSave={(v) => saveRoomSettings(rid, { topic: v })}
                />
                <EditableField
                  label={t('panels.roomInfo.field.description')}
                  icon={Pencil}
                  value={info?.description}
                  placeholder={t('panels.roomInfo.field.descriptionPlaceholder')}
                  multiline
                  readOnly={!canManage}
                  onSave={(v) => saveRoomSettings(rid, { description: v })}
                />
              </>
            )}

            {/* 当前状态：只读 / 已归档，是「这个群怎么不能发消息了」的答案 */}
            {(info?.ro || info?.archived) && (
              <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2.5">
                {info?.ro && (
                  <span className="flex items-center gap-1 rounded bg-fill-1 px-1.5 py-0.5 text-xs text-ink-2">
                    <MessageSquareOff size={12} />
                    {t('panels.roomInfo.readOnlyBadge')}
                  </span>
                )}
                {info?.archived && (
                  <span className="flex items-center gap-1 rounded bg-fill-1 px-1.5 py-0.5 text-xs text-ink-2">
                    <Archive size={12} />
                    {t('panels.roomInfo.archivedBadge')}
                  </span>
                )}
              </div>
            )}

            {info?.u && (() => {
              const createdMs = info.ts ? tsMs(info.ts) : 0;
              return (
                <div className="border-b border-line px-4 py-3 text-xs text-ink-3">
                  {t('panels.roomInfo.createdBy', { name: info.u.name || info.u.username })}
                  {createdMs ? ` · ${formatDate(createdMs, { year: 'numeric', month: 'short', day: 'numeric' }, locale)}` : ''}
                </div>
              );
            })()}

            {/* 操作 */}
            <ActionRow
              icon={Tag}
              label={currentAlias ? t('panels.roomInfo.editAlias') : t('panels.roomInfo.setAlias')}
              onClick={() => setAliasOpen(true)}
            />
            <ActionRow
              icon={conv.favorite ? PinOff : Pin}
              label={conv.favorite ? t('panels.roomInfo.unfavorite') : t('panels.roomInfo.favorite')}
              onClick={() => void toggleFavorite(conv)}
            />
            <ActionRow
              icon={conv.muted ? Bell : BellOff}
              label={conv.muted ? t('panels.roomInfo.unmute') : t('panels.roomInfo.mute')}
              onClick={() => void toggleMute(conv)}
            />
            {!(isDM && !conv.isMultiDM) && (
              <ActionRow
                icon={Users}
                label={t('panels.roomInfo.viewMembers')}
                onClick={() => setPanel({ kind: 'members' })}
              />
            )}
            <ActionRow
              icon={Files}
              label={t('panels.roomInfo.viewFiles')}
              onClick={() => setPanel({ kind: 'files' })}
            />
            {/* 私聊「加人」会新建一个空会话，历史留在原处（RC 没有搬迁消息的接口），
                所以给一个把记录带到别的会话去的入口 */}
            <ActionRow
              icon={Copy}
              label={t('panels.roomInfo.copyHistory')}
              onClick={() => openHistoryCopy({ sourceRid: rid })}
            />

            {/* 讨论相关。
                Rocket.Chat 拒绝嵌套讨论（`error-nested-discussion`），所以讨论里不给
                「再建讨论」；而「讨论 → 频道」在 RC 里没有 REST 端点（8.6 实测
                `channels/groups.convertToChannel` 都是 404），需要自建频道并搬迁消息，
                属于独立工作项，这里不放假按钮。 */}
            {discussionsEnabled && (conv.type === 'c' || conv.type === 'p') && !conv.isDiscussion && (
              <>
                <div className="border-b border-line bg-fill-1 px-4 py-1.5 text-xs text-ink-3">
                  {t('panels.roomInfo.sectionDiscussions')}
                </div>
                <ActionRow
                  icon={MessagesSquare}
                  label={t('panels.roomInfo.createDiscussion')}
                  onClick={() => setDiscussionOpen(true)}
                />
              </>
            )}

            {/* 团队：当前房间属于某个团队时，进入团队维度的管理（成员 / 房间 / 解散）。
                不是团队房间时，允许把这个频道/群组升级成团队（RC 的频道 → 团队）。 */}
            {(conv.type === 'c' || conv.type === 'p') && (
              <>
                <div className="border-b border-line bg-fill-1 px-4 py-1.5 text-xs text-ink-3">
                  {t('panels.roomInfo.sectionTeam')}
                </div>
                {conv.teamId ? (
                  <ActionRow
                    icon={Users}
                    label={t('panels.roomInfo.manageTeam')}
                    onClick={() => openTeamPanel({ teamId: conv.teamId })}
                  />
                ) : (
                  <ActionRow
                    icon={ArrowUpRight}
                    label={t('panels.roomInfo.convertToTeam')}
                    onClick={() => setConvertTeamOpen(true)}
                  />
                )}
              </>
            )}

            {/* 管理操作：只有群主 / 管理员 / 系统管理员看得见 */}
            {canManage && (
              <>
                <div className="border-b border-line bg-fill-1 px-4 py-1.5 text-xs text-ink-3">
                  {t('panels.roomInfo.sectionAdmin')}
                </div>
                <ActionRow
                  icon={MessageSquareOff}
                  label={info?.ro ? t('panels.roomInfo.disableReadOnly') : t('panels.roomInfo.enableReadOnly')}
                  onClick={() => void setRoomReadOnly(rid, !info?.ro)}
                />
                <ActionRow
                  icon={info?.archived ? ArchiveRestore : Archive}
                  label={info?.archived ? t('panels.roomInfo.unarchive') : t('panels.roomInfo.archive')}
                  onClick={() => void archiveConv(rid, !info?.archived)}
                />
                {canDelete && (
                  <ActionRow
                    icon={Trash2}
                    label={t('panels.roomInfo.deleteRoom')}
                    danger
                    onClick={() => setConfirmDelete(true)}
                  />
                )}
              </>
            )}

            {!isDM && (
              <ActionRow
                icon={CalendarClock}
                label={t('panels.roomInfo.oncallSchedule')}
                onClick={() => setPanel({ kind: 'oncall' })}
              />
            )}

            <ActionRow
              icon={isDM ? X : LogOut}
              label={isDM ? t('panels.roomInfo.hideChat') : t('panels.roomInfo.leaveRoom')}
              danger
              onClick={() => setConfirmLeave(true)}
            />
          </>
        )}
      </div>

      {aliasOpen && (
        <AliasDialog
          title={aliasIsUser ? t('panels.roomInfo.setContactAliasTitle') : t('panels.roomInfo.setRoomAliasTitle')}
          originalName={conv.name}
          current={currentAlias}
          onSubmit={(alias) =>
            aliasIsUser ? setUserAlias(conv.avatarUsername!, alias) : setRoomAlias(rid, alias)
          }
          onClose={() => setAliasOpen(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('panels.roomInfo.deleteRoom')}
          message={t('panels.roomInfo.deleteConfirmMessage', { name: shownName })}
          confirmLabel={t('panels.roomInfo.deleteConfirmLabel')}
          onConfirm={() => void deleteConv(rid)}
          onClose={() => setConfirmDelete(false)}
        />
      )}
      {confirmLeave && (
        <ConfirmDialog
          title={isDM ? t('panels.roomInfo.hideChat') : t('panels.roomInfo.leaveRoom')}
          message={
            isDM
              ? t('panels.roomInfo.hideConfirmMessage', { name: shownName })
              : t('panels.roomInfo.leaveConfirmMessage', { name: shownName })
          }
          confirmLabel={isDM ? t('panels.roomInfo.hideConfirmLabel') : t('panels.roomInfo.leaveConfirmLabel')}
          onConfirm={() => void leaveConv(conv)}
          onClose={() => setConfirmLeave(false)}
        />
      )}
      {discussionOpen && (
        <CreateRoomDiscussionDialog rid={rid} onClose={() => setDiscussionOpen(false)} />
      )}
      {convertTeamOpen && (
        <ConvertToTeamDialog
          defaultName={info?.fname || info?.name || shownName}
          onSubmit={async () => {
            await convertRoomToTeam(rid, conv.type, info?.fname || info?.name || shownName);
            setConvertTeamOpen(false);
          }}
          onClose={() => setConvertTeamOpen(false)}
        />
      )}
    </PanelShell>
  );
}

/** 频道 / 群组 → 团队（RC 的 convertToTeam，会新建同名团队并把本房间作为主频道） */
function ConvertToTeamDialog({
  defaultName,
  onSubmit,
  onClose,
}: {
  defaultName: string;
  onSubmit: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message?: string } | null>(null);
  const errorMessage = error ? (error.message ?? t('panels.roomInfo.convertTeamFailed')) : null;

  return (
    <Dialog
      title={t('panels.roomInfo.convertTeamDialogTitle')}
      hint={t('panels.roomInfo.convertTeamDialogHint')}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onSubmit()
                .then(onClose)
                .catch((err) => setError(err instanceof Error ? { message: err.message } : {}))
                .finally(() => setBusy(false));
            }}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />}
            {busy ? t('panels.roomInfo.converting') : t('panels.roomInfo.convertTeamDialogTitle')}
          </button>
        </>
      }
    >
      <div className="space-y-3 px-5 pb-4">
        <div className="text-sm text-ink-2">
          {t('panels.roomInfo.convertingTarget')}<span className="text-ink">{defaultName}</span>
        </div>
        <div className="text-xs leading-relaxed text-ink-3">
          {t('panels.roomInfo.convertTeamNameNote', { name: defaultName })}
        </div>
        {errorMessage && <div className="text-xs text-danger">{errorMessage}</div>}
      </div>
    </Dialog>
  );
}
