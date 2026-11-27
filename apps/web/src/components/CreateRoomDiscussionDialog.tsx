import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, GitPullRequest, Loader2, MessagesSquare, Plus, Settings2, X } from 'lucide-react';
import {
  canUseGitHubIssueRuntime,
  fetchGitHubIssueDetail,
  resolveWorkspaceGitHubRepo,
} from '../agent/githubIssueDelivery';
import {
  buildGitHubIssueBriefPrompt,
  parseGitHubIssueReference,
  type LinkedGitHubIssue,
} from '../lib/githubIssueLoop';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { useAcpAgents } from '../stores/acpAgents';
import {
  createDefaultRoundtableSeats,
  listSelectableProjectWorkspaces,
  resolvePreferredProjectWorkspace,
  useRoomAiParticipants,
  type RoomAiAgentKind,
  type RoomAiMode,
  type RoomAiSeat,
} from '../stores/roomAiParticipants';
import { discussionParents } from './CreateDiscussionDialog';
import Dialog from './Dialog';
import { useI18n } from '../i18n';

/**
 * 在房间里创建讨论（不带来源消息），支持一键开启为「AI 讨论组」。
 *
 * Rocket.Chat 的 `rooms.createDiscussion` 的 `pmid` 是可选的：原生客户端的房间
 * 「+」菜单里就允许不选中任何消息直接开讨论。此前 RocketX 只有「消息右键 → 创建
 * 讨论」一条路径，群里一条消息都没有时（空群/新群）根本开不了讨论。
 *
 * 传 `rid` 就是在当前房间直接开；不传则先选父房间。父房间只能是频道/群组 ——
 * Rocket.Chat 拒绝嵌套讨论（`error-nested-discussion`，8.6 实测）。
 */
export default function CreateRoomDiscussionDialog({
  rid,
  defaultAi = false,
  defaultAgentId = 'pi_butler',
  defaultName = '',
  defaultInitialPrompt = '',
  defaultWorkspaceRoot,
  defaultLinkedGithubIssue = null,
  onCreated,
  onClose,
}: {
  /** 指定父房间（从房间内打开时）；不传则让用户选 */
  rid?: string;
  /** 是否默认作为 AI 讨论组创建（从「创建 AI 讨论组」入口打开时为 true） */
  defaultAi?: boolean;
  /** 默认选中的 AI 助手标识（'pi_butler' 或 ACP Agent id） */
  defaultAgentId?: string;
  /** 预填讨论组标题（如从 GitHub Issue 拉起） */
  defaultName?: string;
  /** 预填首轮提问（如 GitHub Issue 详情） */
  defaultInitialPrompt?: string;
  /** 预选项目工作区根目录 */
  defaultWorkspaceRoot?: string;
  /** 预关联的 GitHub Issue */
  defaultLinkedGithubIssue?: LinkedGitHubIssue | null;
  /** 创建成功后的回调 */
  onCreated?: (createdRid: string) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const rooms = useChat((state) => state.rooms);
  const subscriptions = useChat((state) => state.subscriptions);
  const createDiscussionInRoom = useChat((state) => state.createDiscussionInRoom);
  const acpAgents = useAcpAgents((state) => state.agents);
  const hydrateAcpAgents = useAcpAgents((state) => state.hydrate);

  useEffect(() => {
    void hydrateAcpAgents();
  }, [hydrateAcpAgents]);

  const parents = useMemo(
    () => discussionParents(rooms, subscriptions),
    [rooms, subscriptions, locale],
  );
  const agentOptions = useMemo(() => {
    const base: Array<{ key: string; kind: RoomAiAgentKind; id: string; name: string }> = [
      {
        key: 'pi_butler',
        kind: 'pi_butler',
        id: 'pi_butler',
        name: t('chat.aiParticipant.piButlerName'),
      },
    ];
    for (const agent of acpAgents) {
      if (!agent.enabled) continue;
      base.push({
        key: agent.id,
        kind: 'acp',
        id: agent.id,
        name: agent.name,
      });
    }
    return base;
  }, [acpAgents, t]);

  const [parentRid, setParentRid] = useState(rid ?? parents[0]?.rid ?? '');
  const [name, setName] = useState(defaultName);
  const [aiEnabled, setAiEnabled] = useState(defaultAi);
  const [aiMode, setAiMode] = useState<RoomAiMode>(
    defaultAi && defaultAgentId === 'pi_butler' ? 'roundtable' : 'solo',
  );
  const [selectedAgentKey, setSelectedAgentKey] = useState(defaultAgentId);
  const projectWorkspaces = useMemo(() => listSelectableProjectWorkspaces(), []);
  const [selectedWorkspace, setSelectedWorkspace] = useState(
    () => defaultWorkspaceRoot?.trim() || resolvePreferredProjectWorkspace(),
  );
  const [seats, setSeats] = useState<RoomAiSeat[]>(() => createDefaultRoundtableSeats());
  const [editingSeatId, setEditingSeatId] = useState<string | null>(null);
  const [customRoleName, setCustomRoleName] = useState('');
  const [initialPrompt, setInitialPrompt] = useState(defaultInitialPrompt);
  const [detectedRepo, setDetectedRepo] = useState<{ owner: string; repo: string } | null>(null);
  const [issueRefInput, setIssueRefInput] = useState(
    defaultLinkedGithubIssue ? `#${defaultLinkedGithubIssue.number}` : '',
  );
  const [importingIssue, setImportingIssue] = useState(false);
  const [linkedIssue, setLinkedIssue] = useState<LinkedGitHubIssue | null>(
    defaultLinkedGithubIssue,
  );
  const [busy, setBusy] = useState(false);
  const githubAvailable = canUseGitHubIssueRuntime();

  useEffect(() => {
    if (!githubAvailable || !selectedWorkspace.trim()) {
      setDetectedRepo(null);
      return;
    }
    let canceled = false;
    void resolveWorkspaceGitHubRepo(selectedWorkspace).then((found) => {
      if (canceled) return;
      setDetectedRepo(found ? { owner: found.owner, repo: found.repo } : null);
    });
    return () => {
      canceled = true;
    };
  }, [githubAvailable, selectedWorkspace]);

  const handleImportIssue = async () => {
    if (importingIssue) return;
    const parsed = parseGitHubIssueReference(issueRefInput, detectedRepo);
    if (!parsed) {
      toast.error(t('chat.aiParticipant.githubImportInvalidRef'));
      return;
    }
    setImportingIssue(true);
    try {
      const detail = await fetchGitHubIssueDetail(parsed);
      setLinkedIssue({
        owner: detail.owner,
        repo: detail.repo,
        number: detail.number,
        title: detail.title,
        htmlUrl: detail.htmlUrl,
      });
      if (!name.trim()) {
        setName(`#${detail.number} ${detail.title}`.slice(0, 40));
      }
      setInitialPrompt(buildGitHubIssueBriefPrompt(detail, 'roundtable'));
      toast.success(
        t('chat.aiParticipant.githubImportSuccess', {
          repo: `${detail.owner}/${detail.repo}`,
          number: detail.number,
        }),
      );
    } catch (error) {
      toast.error(error, t('chat.aiParticipant.githubImportFailed'));
    } finally {
      setImportingIssue(false);
    }
  };

  const selectedAgent =
    agentOptions.find((opt) => opt.key === selectedAgentKey) ?? agentOptions[0];
  const editingSeat = seats.find((s) => s.seatId === editingSeatId) ?? null;

  const parent = rooms[parentRid];
  const parentLabel = parent?.fname || parent?.name || '';

  const submit = async () => {
    if (busy || !parentRid) return;
    setBusy(true);
    try {
      await createDiscussionInRoom(parentRid, name.trim() || undefined);
      const createdRid = useChat.getState().activeRid;
      if (aiEnabled && createdRid && selectedAgent) {
        const activeSeats = aiMode === 'roundtable'
          ? seats.map((s) => ({ ...s }))
          : undefined;
        useRoomAiParticipants.getState().enrollRoom({
          rid: createdRid,
          isDiscussion: true,
          mode: aiMode,
          seats: activeSeats,
          agentKind: selectedAgent.kind,
          agentId: selectedAgent.id,
          agentName:
            aiMode === 'roundtable'
              ? t('chat.aiParticipant.roundtableBadgeName')
              : selectedAgent.name,
          replyPolicy: 'every_message',
          workspaceRoot: selectedWorkspace || resolvePreferredProjectWorkspace() || undefined,
          linkedGithubIssue: linkedIssue ?? undefined,
        });
        const trimmedPrompt = initialPrompt.trim();
        if (trimmedPrompt) {
          await useChat.getState().send(trimmedPrompt, { rid: createdRid });
        }
      }
      if (createdRid) {
        onCreated?.(createdRid);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={aiEnabled ? t('chat.aiParticipant.createTitle') : t('chat.discussion.createTitle')}
      hint={aiEnabled ? t('chat.aiParticipant.createHint') : t('chat.discussion.roomDialogHint')}
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
            onClick={() => void submit()}
            disabled={busy || !parentRid}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : aiEnabled ? (
              <Bot size={14} />
            ) : (
              <MessagesSquare size={14} />
            )}
            {busy
              ? t('chat.common.creating')
              : aiEnabled
                ? t('chat.aiParticipant.createTitle')
                : t('chat.discussion.createTitle')}
          </button>
        </>
      }
    >
      <div className="space-y-4 px-5 pb-4">
        {!rid && (
          <label className="block text-xs text-ink-3">
            {t('chat.discussion.parentRoomLabel')}
            <select
              value={parentRid}
              onChange={(event) => setParentRid(event.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
            >
              {parents.length === 0 ? <option value="">{t('chat.discussion.noParentRoomsOption')}</option> : null}
              {parents.map((item) => (
                <option key={item.rid} value={item.rid}>
                  {item.label}
                </option>
              ))}
            </select>
            {parents.length === 0 ? (
              <span className="mt-1 block text-danger">{t('chat.discussion.noParentRoomsError')}</span>
            ) : null}
          </label>
        )}
        {rid && parentLabel && (
          <div className="text-xs text-ink-3">
            {t('chat.discussion.parentRoomLabel')}<span className="mt-1 block text-sm text-ink">{parentLabel}</span>
          </div>
        )}
        <label className="block text-xs text-ink-3">
          {t('chat.discussion.nameLabel')}
          <input
            autoFocus
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            placeholder={
              parentLabel
                ? t('chat.discussion.defaultParentNamePlaceholder', { name: parentLabel })
                : t('chat.discussion.fallbackRoomNamePlaceholder')
            }
            className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
        </label>

        <div className="rounded-lg border border-line bg-surface-3 p-3">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={aiEnabled}
              onChange={(event) => setAiEnabled(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-line text-primary focus:ring-primary"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
                <Bot size={13} className="text-primary" />
                <span>{t('chat.aiParticipant.enableToggle')}</span>
              </div>
              <p className="mt-0.5 text-xs text-ink-3">{t('chat.aiParticipant.enableHint')}</p>
            </div>
          </label>

          {aiEnabled && (
            <div className="mt-3 space-y-3 border-t border-line-soft pt-3">
              <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-line bg-surface p-1">
                <button
                  type="button"
                  onClick={() => setAiMode('solo')}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                    aiMode === 'solo'
                      ? 'bg-primary text-white shadow-sm'
                      : 'text-ink-2 hover:bg-fill-hover'
                  }`}
                >
                  {t('chat.aiParticipant.modeSoloLabel')}
                </button>
                <button
                  type="button"
                  onClick={() => setAiMode('roundtable')}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                    aiMode === 'roundtable'
                      ? 'bg-primary text-white shadow-sm'
                      : 'text-ink-2 hover:bg-fill-hover'
                  }`}
                >
                  {t('chat.aiParticipant.modeRoundtableLabel')}
                </button>
              </div>

              {projectWorkspaces.length > 0 ? (
                <label className="block text-xs text-ink-3">
                  {t('chat.aiParticipant.projectRootLabel')}
                  <select
                    value={selectedWorkspace}
                    onChange={(event) => setSelectedWorkspace(event.target.value)}
                    className="mt-1 h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                  >
                    {projectWorkspaces.map((ws) => (
                      <option key={ws.path} value={ws.path}>
                        {ws.label} ({ws.path})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {aiMode === 'solo' ? (
                <label className="block text-xs text-ink-3">
                  {t('chat.aiParticipant.agentLabel')}
                  <select
                    value={selectedAgent?.key ?? 'pi_butler'}
                    onChange={(event) => setSelectedAgentKey(event.target.value)}
                    className="mt-1 h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                  >
                    {agentOptions.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs text-ink-3">{t('chat.aiParticipant.seatsHint')}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {seats.map((seat) => (
                      <div
                        key={seat.seatId}
                        className={`inline-flex items-center overflow-hidden rounded-full border text-xs transition ${
                          seat.enabled
                            ? 'border-primary/40 bg-primary-light/80 text-primary'
                            : 'border-line bg-surface text-ink-3'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setSeats((curr) =>
                              curr.map((s) =>
                                s.seatId === seat.seatId ? { ...s, enabled: !s.enabled } : s,
                              ),
                            )
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1 font-medium"
                        >
                          {seat.enabled ? <Check size={11} /> : null}
                          <span>{seat.roleTitle}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setEditingSeatId((id) => (id === seat.seatId ? null : seat.seatId))
                          }
                          className="border-l border-current/15 px-1.5 py-1 opacity-70 hover:opacity-100"
                          aria-label={seat.roleTitle}
                        >
                          <Settings2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {editingSeat ? (
                    <div className="space-y-2 rounded-md border border-line bg-surface p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-ink">{editingSeat.roleTitle}</span>
                        <select
                          value={editingSeat.agentId}
                          onChange={(event) => {
                            const chosen = agentOptions.find((a) => a.id === event.target.value);
                            if (!chosen) return;
                            setSeats((curr) =>
                              curr.map((s) =>
                                s.seatId === editingSeat.seatId
                                  ? {
                                      ...s,
                                      agentKind: chosen.kind,
                                      agentId: chosen.id,
                                      agentName: chosen.name,
                                    }
                                  : s,
                              ),
                            );
                          }}
                          className="h-7 rounded border border-line bg-surface-3 px-2 text-xs text-ink outline-none"
                        >
                          {agentOptions.map((option) => (
                            <option key={option.key} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <input
                        value={editingSeat.stancePrompt ?? ''}
                        onChange={(event) =>
                          setSeats((curr) =>
                            curr.map((s) =>
                              s.seatId === editingSeat.seatId
                                ? { ...s, stancePrompt: event.target.value }
                                : s,
                            ),
                          )
                        }
                        placeholder={t('chat.aiParticipant.stancePlaceholder')}
                        className="h-7 w-full rounded border border-line bg-surface-3 px-2 text-xs text-ink outline-none focus:border-primary"
                      />
                    </div>
                  ) : null}

                  <div className="flex items-center gap-1.5">
                    <input
                      value={customRoleName}
                      onChange={(event) => setCustomRoleName(event.target.value)}
                      placeholder={t('chat.aiParticipant.customSeatPlaceholder')}
                      className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      disabled={!customRoleName.trim()}
                      onClick={() => {
                        const title = customRoleName.trim();
                        if (!title) return;
                        const newSeat: RoomAiSeat = {
                          seatId: `seat-custom-${Date.now().toString(36)}`,
                          roleId: 'custom',
                          roleTitle: title,
                          agentKind: selectedAgent.kind,
                          agentId: selectedAgent.id,
                          agentName: selectedAgent.name,
                          enabled: true,
                        };
                        setSeats((curr) => [...curr, newSeat]);
                        setCustomRoleName('');
                        setEditingSeatId(newSeat.seatId);
                      }}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-xs text-ink-2 hover:border-primary/40 hover:text-primary disabled:opacity-40"
                    >
                      <Plus size={11} />
                      <span>{t('chat.aiParticipant.addCustomSeatBtn')}</span>
                    </button>
                  </div>
                </div>
              )}

              {githubAvailable ? (
                <div className="space-y-1.5 rounded-md border border-line bg-surface p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 font-medium text-ink-2">
                      <GitPullRequest size={12} className="text-primary" />
                      {t('chat.aiParticipant.githubImportLabel')}
                    </span>
                    {detectedRepo ? (
                      <span className="font-mono text-xs text-ink-3">
                        {detectedRepo.owner}/{detectedRepo.repo}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      value={issueRefInput}
                      onChange={(event) => setIssueRefInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void handleImportIssue();
                        }
                      }}
                      placeholder={t('chat.aiParticipant.githubImportPlaceholder')}
                      className="h-7 min-w-0 flex-1 rounded border border-line bg-surface-3 px-2 font-mono text-xs text-ink outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      disabled={importingIssue || !issueRefInput.trim()}
                      onClick={() => void handleImportIssue()}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
                    >
                      {importingIssue ? <Loader2 size={11} className="animate-spin" /> : null}
                      <span>{t('chat.aiParticipant.githubImportBtn')}</span>
                    </button>
                  </div>
                  {linkedIssue ? (
                    <div className="flex items-center justify-between gap-2 rounded bg-primary-light/60 px-2 py-1 text-xs text-primary">
                      <span className="truncate font-mono">
                        GitHub {linkedIssue.owner}/{linkedIssue.repo}#{linkedIssue.number} · {linkedIssue.title}
                      </span>
                      <button
                        type="button"
                        onClick={() => setLinkedIssue(null)}
                        className="shrink-0 opacity-75 hover:opacity-100"
                        aria-label={t('common.close')}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <label className="block text-xs text-ink-3">
                {t('chat.aiParticipant.initialPromptLabel')}
                <textarea
                  rows={2}
                  value={initialPrompt}
                  onChange={(event) => setInitialPrompt(event.target.value)}
                  placeholder={t('chat.aiParticipant.initialPromptPlaceholder')}
                  className="mt-1 w-full resize-none rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
                />
              </label>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
