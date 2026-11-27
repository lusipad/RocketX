import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  AtSign,
  Bot,
  ChevronDown,
  Files,
  FolderOpen,
  Info,
  MessageCircle,
  MoreHorizontal,
  ListRestart,
  Pin,
  Search,
  SquareKanban,
  Star,
  Upload,
  Users,
} from 'lucide-react';
import { roomMembershipPolicy, useChat, type RightPanel } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { useSharedAgent } from '../stores/sharedAgent';
import {
  agentRoomSessionKey,
  findEnvironmentByPath,
  useAgentEnvironments,
} from '../stores/agentEnvironments';
import { toast } from '../stores/toast';
import {
  autoHostEnvironmentId,
  roomHostingWorkspaceRoot,
  setRoomHostingWorkspace,
  startRoomAgentHosting,
} from '../lib/agentHosting';
import { runtimeFeatures } from '../lib/runtimeMode';
import { displayName, useAliases } from '../stores/aliases';
import Avatar from './Avatar';
import MessageList from './MessageList';
import Composer from './Composer';
import ContextMenu from './ContextMenu';
import { useKernelContributions } from '../kernel/registry';
import {
  formatAiDiscussionHandoffDraft,
  formatChatMessagesForButlerPrompt,
  formatSharePayloadForChat,
  hasAiParticipantDrag,
  hasButlerShareDrag,
  hasChatToButlerDrag,
  readAiParticipantDrag,
  readButlerShareDrag,
  readChatToButlerDrag,
  writeAiParticipantDrag,
} from '../lib/butlerChatBridge';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import {
  listSelectableProjectWorkspaces,
  useRoomAiParticipants,
} from '../stores/roomAiParticipants';
import {
  forceSynthesizeRoundtableNow,
  skipCurrentRoundtableSeat,
  useRoundtableLiveState,
} from '../agent/roomAiParticipantRuntime';
import { useUI } from '../stores/ui';
import { agentSessionCardSupersedesLocal } from '../agent/card';
import { useT } from '../i18n';

function HeaderButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Pin;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-lg transition ${
        active
          ? 'bg-primary-light text-primary'
          : onClick
            ? 'text-ink-2 hover:bg-fill-hover'
            : 'cursor-not-allowed text-ink-2 opacity-60'
      }`}
    >
      <Icon size={16} />
    </button>
  );
}

export default function ChatArea({
  hasUnread,
  onNextUnread,
}: {
  hasUnread: boolean;
  onNextUnread: () => void;
}) {
  const t = useT();
  const features = runtimeFeatures();
  const activeRid = useChat((s) => s.activeRid);
  const messageScrollTransaction = useChat((s) => s.messageScrollTransaction);
  const rightPanel = useChat((s) => s.rightPanel);
  const registeredPanels = useKernelContributions('panel.right');
  const setPanel = useChat((s) => s.setPanel);
  const openButlerConversation = useUI((state) => state.openButlerConversation);
  const requestUpload = useChat((s) => s.requestUpload);
  const sub = useChat((s) => (s.activeRid ? s.subscriptions[s.activeRid] : undefined));
  const room = useChat((s) => (s.activeRid ? s.rooms[s.activeRid] : undefined));
  const rawName = sub?.fname || sub?.name || room?.fname || room?.name || t('chat.common.conversation');
  // 多人直聊也是「群」：它有成员数，也不该拿某个人的头像和在线状态顶上。
  const dmSize = room?.uids?.length ?? room?.usersCount;
  const isMultiDM = sub?.t === 'd' && (dmSize !== undefined ? dmSize > 2 : rawName.includes(','));
  const avatarUsername = sub?.t === 'd' && !isMultiDM ? sub.name : undefined;
  const peerStatus = useChat((s) =>
    avatarUsername ? s.userStatus[avatarUsername] : undefined,
  );
  const agentSessionKey = activeRid ? agentRoomSessionKey(activeRid) : '';
  const currentAgentProject = useCodexWorkspace((state) => state.workspaceRoot);
  const environments = useAgentEnvironments((state) => state.environments);
  const agentWorkspaces = environments.filter((environment) => environment.enabled);
  const boundAgentWorkspace = activeRid ? roomHostingWorkspaceRoot(activeRid) : undefined;
  const currentEnvironment = findEnvironmentByPath(environments, currentAgentProject);
  const preferredAgentWorkspace = (
    boundAgentWorkspace && findEnvironmentByPath(agentWorkspaces, boundAgentWorkspace)?.path
      ? boundAgentWorkspace
      : currentEnvironment?.enabled
        ? currentAgentProject
        : agentWorkspaces[0]?.path
  );
  const localAgent = useSharedAgent((s) => (agentSessionKey ? s.sessions[agentSessionKey] : undefined));
  const remoteAgent = useSharedAgent((s) => (agentSessionKey ? s.remoteCards[agentSessionKey] : undefined));
  const me = useAuth((s) => s.user);
  const localMode = useAuth((s) => s.localMode);
  const exitLocalMode = useAuth((s) => s.exitLocalMode);
  const setModule = useUI((state) => state.setModule);
  const openRoom = useChat((s) => s.openRoom);
  const joinRoom = useChat((s) => s.joinRoom);
  const parentRoom = useChat((s) => {
    if (!s.activeRid) return undefined;
    const p = s.subscriptions[s.activeRid]?.prid ?? s.rooms[s.activeRid]?.prid;
    return p ? s.rooms[p] : undefined;
  });
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const typingMap = useChat((s) => (s.activeRid ? s.typing[s.activeRid] : undefined));
  const typers = typingMap
    ? Object.entries(typingMap)
        .filter(([, expire]) => expire > Date.now())
        .map(([name]) => name)
    : [];
  const [dragging, setDragging] = useState(false);
  const [draggingShare, setDraggingShare] = useState(false);
  const [draggingAi, setDraggingAi] = useState(false);
  const [draggingLauncher, setDraggingLauncher] = useState(false);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const [agentProjectMenu, setAgentProjectMenu] = useState<{ x: number; y: number } | null>(null);
  const [roomAiMenu, setRoomAiMenu] = useState<{ x: number; y: number } | null>(null);
  const roomAiParticipant = useRoomAiParticipants((s) => (activeRid ? s.participants[activeRid] : undefined));
  const activeRoomAi = roomAiParticipant?.enabled ? roomAiParticipant : undefined;
  const liveRoundtable = useRoundtableLiveState((s) => (activeRid ? s.runs[activeRid] : undefined));
  const butlerPanelOpen = rightPanel?.kind === 'butler';
  const ButlerPanel = registeredPanels.find((candidate) => candidate.id === 'butler')?.render;
  const ActivePanel = rightPanel && !butlerPanelOpen
    ? registeredPanels.find((candidate) => candidate.id === rightPanel.kind)?.render
    : undefined;
  const butlerLauncherRef = useRef<HTMLButtonElement>(null);
  const wasButlerPanelOpen = useRef(butlerPanelOpen);

  useEffect(() => {
    if (!features.sharedAgent || !features.ai) return;
    if (!activeRid) return;
    const sharedAgent = useSharedAgent.getState();
    const sessionKey = agentRoomSessionKey(activeRid);
    const local = sharedAgent.sessions[sessionKey];
    const remote = sharedAgent.remoteCards[sessionKey];
    if (local && local.status !== 'ended') return;
    if (remote && remote.status !== 'ended' && remote.leaseExpiresAt > Date.now()) return;
    const environmentId = autoHostEnvironmentId(activeRid);
    if (!environmentId) return;
    const chat = useChat.getState();
    const currentRoom = chat.rooms[activeRid];
    const currentSubscription = chat.subscriptions[activeRid];
    const title = currentSubscription?.fname || currentSubscription?.name || currentRoom?.fname || currentRoom?.name || t('chat.common.conversation');
    void startRoomAgentHosting(activeRid, title, { preferredEnvironmentId: environmentId }).catch((error) => {
      toast.error(error, t('chat.area.autoHostingFailed'));
    });
  }, [activeRid, features.sharedAgent]);

  useEffect(() => {
    if (!dragging && !draggingShare && !draggingAi && !draggingLauncher) return;
    const clearDragging = () => {
      setDragging(false);
      setDraggingShare(false);
      setDraggingAi(false);
      setDraggingLauncher(false);
    };
    window.addEventListener('blur', clearDragging);
    window.addEventListener('dragend', clearDragging);
    window.addEventListener('drop', clearDragging);
    return () => {
      window.removeEventListener('blur', clearDragging);
      window.removeEventListener('dragend', clearDragging);
      window.removeEventListener('drop', clearDragging);
    };
  }, [dragging, draggingAi, draggingLauncher, draggingShare]);

  useEffect(() => {
    if (wasButlerPanelOpen.current && !butlerPanelOpen) {
      butlerLauncherRef.current?.focus();
    }
    wasButlerPanelOpen.current = butlerPanelOpen;
  }, [butlerPanelOpen]);

  if (!activeRid) {
    if (localMode) {
      return (
        <main className="flex flex-1 flex-col items-center justify-center bg-surface-3 px-6 text-center">
          <div className="flex max-w-lg flex-col items-center gap-4 rounded-2xl border border-line bg-surface-4 px-10 py-9 shadow-card">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-light text-primary shadow-raise">
              <Bot size={32} />
            </div>
            <div>
              <div className="text-base font-semibold text-ink">{t('chat.area.localModeTitle')}</div>
              <p className="mt-1.5 max-w-md text-xs leading-5 text-ink-3">
                {t('chat.area.localModeDesc')}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              {features.butler ? (
                <button
                  type="button"
                  onClick={() => setModule('butler-view')}
                  className="h-9 rounded-xl bg-primary px-4 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
                >
                  {t('chat.area.openButler')}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setModule('todos')}
                className="h-9 rounded-xl border border-line bg-surface-3 px-4 text-xs font-medium text-ink-2 shadow-raise transition hover:bg-fill-hover hover:text-ink"
              >
                {t('chat.area.openTodos')}
              </button>
              <button
                type="button"
                onClick={() => void exitLocalMode()}
                className="h-9 rounded-xl border border-line bg-surface-3 px-4 text-xs font-medium text-primary shadow-raise transition hover:bg-primary-light"
              >
                {t('chat.area.connectRc')}
              </button>
            </div>
          </div>
        </main>
      );
    }
    return (
      <main className="flex flex-1 flex-col items-center justify-center bg-surface-3 p-6">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-line-soft bg-surface-2/60 px-10 py-9 shadow-raise">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line bg-surface-4 shadow-raise">
            <MessageCircle size={30} className="text-primary" />
          </div>
          <div className="text-sm font-medium text-ink-2">{t('chat.area.emptySelect')}</div>
          <div className="flex items-center gap-1.5 text-xs text-ink-3">
            <span>{t('chat.area.emptyTipPrefix')}</span>
            <kbd className="rounded-md border border-line bg-surface-4 px-1.5 py-0.5 font-sans text-2xs font-medium text-ink-2 shadow-raise">Ctrl</kbd>
            <span>+</span>
            <kbd className="rounded-md border border-line bg-surface-4 px-1.5 py-0.5 font-sans text-2xs font-medium text-ink-2 shadow-raise">K</kbd>
            <span>{t('chat.area.emptyTipSuffix')}</span>
          </div>
        </div>
      </main>
    );
  }

  const name = displayName(aliases, { rid: activeRid, name: rawName, avatarUsername }, nameFormat);
  const memberCount = sub?.t !== 'd' || isMultiDM ? room?.usersCount : undefined;
  const prid = sub?.prid ?? room?.prid;
  const { requiresJoin, canCompose } = roomMembershipPolicy(!!sub, room);
  const remoteAgentActive = agentSessionCardSupersedesLocal(localAgent, remoteAgent) ? remoteAgent : undefined;
  const localAgentActive = !remoteAgentActive && localAgent && localAgent.status !== 'ended' ? localAgent : undefined;
  const agentPresence = !features.sharedAgent
    ? undefined
    : localAgentActive
    ? {
        username: me?.username ?? localAgentActive.host.userId,
        environmentName: localAgentActive.environmentName,
        status: localAgentActive.status,
      }
    : remoteAgentActive
      ? {
          username: remoteAgentActive.hostUsername,
          environmentName: remoteAgentActive.environmentName,
          status: remoteAgentActive.status,
        }
      : undefined;
  const agentStatus = agentPresence?.status === 'running'
    ? t('chat.area.agent.running')
    : agentPresence?.status === 'waiting-approval'
      ? t('chat.area.agent.waitingApproval')
      : agentPresence?.status === 'starting'
        ? t('chat.area.agent.starting')
        : agentPresence?.status === 'interrupted'
          ? t('chat.area.agent.interrupted')
          : agentPresence?.status === 'ready'
            ? t('chat.area.agent.ready')
            : t('chat.area.agent.active');
  const agentBusy = ['running', 'starting', 'waiting-approval', 'active'].includes(agentPresence?.status ?? '');

  const togglePanel = (panel: Exclude<RightPanel, null>) => {
    setPanel(rightPanel?.kind === panel.kind ? null : panel);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setDraggingShare(false);
    setDraggingAi(false);
    if (!canCompose) return;
    const aiDrag = readAiParticipantDrag(e.dataTransfer);
    if (aiDrag) {
      useRoomAiParticipants.getState().enrollFromDrag(activeRid, Boolean(prid), aiDrag);
      if (e.shiftKey) {
        useUI.getState().seedComposer(formatAiDiscussionHandoffDraft(aiDrag), 'append');
        toast.success(
          t('chat.aiParticipant.enrolledWithHandoffToast', {
            agent: aiDrag.agentName,
            room: name,
          }),
        );
      } else {
        toast.success(
          t('chat.aiParticipant.enrolledToast', {
            agent: aiDrag.agentName,
            room: name,
          }),
        );
      }
      return;
    }
    const shared = readButlerShareDrag(e.dataTransfer);
    if (shared) {
      const markdown = formatSharePayloadForChat(shared);
      if (e.shiftKey) {
        void useChat
          .getState()
          .send(markdown, { rid: activeRid })
          .then(() => toast.success(t('chat.butlerBridge.sentDirectlyToast')))
          .catch((err) => toast.error(err, t('chat.butlerBridge.sendFailed')));
      } else {
        useUI.getState().seedComposer(markdown, 'append');
        toast.info(t('chat.butlerBridge.draftInsertedToast'));
      }
      return;
    }
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) requestUpload(files);
  };

  return (
    <>
      <main
        className="relative flex min-w-0 flex-1 flex-col bg-surface-3"
        onDragOver={(e) => {
          if (!canCompose) return;
          if (hasAiParticipantDrag(e.dataTransfer)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDraggingAi(true);
            return;
          }
          if (hasButlerShareDrag(e.dataTransfer)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDraggingShare(true);
            return;
          }
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          const nextTarget = e.relatedTarget;
          if (!(nextTarget instanceof Node) || !e.currentTarget.contains(nextTarget)) {
            setDragging(false);
            setDraggingShare(false);
            setDraggingAi(false);
          }
        }}
        onDrop={onDrop}
      >
        <header className="rcx-glass-header flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          {/* 头像点开群信息（飞书就是这个交互） */}
          <button
            onClick={() => togglePanel({ kind: 'info' })}
            className="mr-2.5 shrink-0 rounded-lg transition hover:opacity-80"
            title={t('chat.area.viewRoomInfo')}
          >
            <Avatar
              name={name}
              username={avatarUsername}
              roomId={avatarUsername ? undefined : activeRid}
              size={36}
              status={peerStatus}
            />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <button
                onClick={() => togglePanel({ kind: 'info' })}
                className="min-w-0 truncate text-base font-semibold text-ink transition hover:text-primary"
                title={t('chat.area.viewRoomInfo')}
              >
                {name}
              </button>
              {memberCount ? (
                <button
                  onClick={() => togglePanel({ kind: 'members' })}
                  className={`flex items-center gap-0.5 rounded px-1 text-xs transition hover:bg-fill-hover ${
                    rightPanel?.kind === 'members' ? 'text-primary' : 'text-ink-3'
                  }`}
                  title={t('chat.area.viewMembers')}
                >
                  <Users size={14} />
                  {memberCount}
                </button>
              ) : null}
              {features.sharedAgent && !agentPresence ? (
                <div className="flex h-7 shrink-0 overflow-hidden rounded-full border border-line bg-surface-4 text-xs font-medium text-ink-2 shadow-raise transition hover:border-primary/40">
                  <button
                    aria-label={t('chat.area.configureAiHosting')}
                    title={t('chat.area.configureAiHostingTooltip')}
                    onClick={() => setPanel({ kind: 'agent', tmid: agentSessionKey })}
                    className="flex items-center gap-1.5 px-2.5 transition hover:bg-primary-light hover:text-primary"
                  >
                    <Bot size={14} />
                    {t('chat.area.aiHosting')}
                  </button>
                  <button
                    type="button"
                    aria-label={t('chat.area.selectAiProjectAria')}
                    title={t('chat.area.selectAiProjectTooltip')}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setAgentProjectMenu({ x: rect.right - 180, y: rect.bottom + 4 });
                    }}
                    className="flex w-7 items-center justify-center border-l border-line transition hover:bg-primary-light hover:text-primary"
                  >
                    <ChevronDown size={13} />
                  </button>
                </div>
              ) : null}
              {features.sharedAgent && agentPresence ? (
                <button
                  aria-label={t('chat.area.openAiControlAria')}
                  title={t('chat.area.openAiControlTooltip', {
                    status: agentStatus,
                    env: agentPresence.environmentName ? ` · ${agentPresence.environmentName}` : '',
                    username: agentPresence.username,
                  })}
                  onClick={() => setPanel({ kind: 'agent', tmid: agentSessionKey })}
                  className="flex h-7 max-w-[300px] shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-gradient-to-r from-primary-light to-surface-4 px-2.5 text-xs text-primary shadow-raise transition hover:border-primary/50 hover:from-primary-light/90 hover:to-primary-light/50"
                >
                  <span className="relative flex h-2 w-2 shrink-0">
                    {agentBusy ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-50" /> : null}
                    <span className={`relative inline-flex h-2 w-2 rounded-full ${agentPresence.status === 'interrupted' ? 'bg-ink-3' : agentPresence.status === 'waiting-approval' ? 'bg-warning' : 'bg-primary'}`} />
                  </span>
                  <Bot size={14} className="shrink-0" />
                  <span className="shrink-0 font-semibold">{t('chat.area.aiHosting')}</span>
                  <span className="h-3 w-px shrink-0 bg-primary/25" />
                  <span className="shrink-0 text-xs font-medium">{agentStatus}</span>
                  {agentPresence.environmentName ? (
                    <span className="hidden min-w-0 truncate border-l border-primary/20 pl-1.5 text-xs text-ink-3 2xl:inline">
                      {agentPresence.environmentName}
                    </span>
                  ) : null}
                </button>
              ) : null}
              {activeRoomAi ? (
                <button
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    writeAiParticipantDrag(e.dataTransfer, {
                      source: activeRoomAi.isDiscussion ? 'ai_discussion' : 'butler',
                      mode: activeRoomAi.mode,
                      seats: activeRoomAi.seats,
                      agentKind: activeRoomAi.agentKind,
                      agentId: activeRoomAi.agentId,
                      agentName: activeRoomAi.agentName,
                      discussionRid: activeRid,
                      discussionName: name,
                      threadId: activeRoomAi.threadId,
                      acpSessionKey: activeRoomAi.acpSessionKey,
                      workspaceRoot: activeRoomAi.workspaceRoot,
                      decisionSummary: activeRoomAi.latestDecisionSummary,
                    });
                  }}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setRoomAiMenu({ x: rect.left, y: rect.bottom + 4 });
                  }}
                  title={t('chat.aiParticipant.dragHeaderTooltip', {
                    agent: activeRoomAi.agentName,
                    policy:
                      activeRoomAi.replyPolicy === 'every_message'
                        ? t('chat.aiParticipant.policyEveryMessage')
                        : t('chat.aiParticipant.policyMentionOnly'),
                  })}
                  className="flex h-7 max-w-[280px] shrink-0 cursor-grab items-center gap-1.5 rounded-full border border-primary/30 bg-primary-light/80 px-2.5 text-xs font-medium text-primary shadow-raise transition hover:border-primary/50 hover:bg-primary-light active:cursor-grabbing"
                >
                  <Bot size={13} className="shrink-0" />
                  <span className="truncate">
                    {activeRoomAi.mode === 'roundtable'
                      ? t('chat.aiParticipant.roundtableBadgeSummary', {
                          agent: activeRoomAi.agentName,
                          count: activeRoomAi.seats?.filter((s) => s.enabled).length ?? 4,
                        })
                      : activeRoomAi.agentName}
                  </span>
                  <span className="rounded-full bg-surface-4 px-1.5 py-0.5 text-2xs font-medium text-ink-2">
                    {activeRoomAi.replyPolicy === 'every_message'
                      ? t('chat.aiParticipant.policyEveryMessage')
                      : t('chat.aiParticipant.policyMentionOnly')}
                  </span>
                </button>
              ) : null}
            </div>
            {typers.length > 0 ? (
              <div className="truncate text-xs text-primary">
                {t('chat.area.typing', { names: typers.slice(0, 3).join(t('chat.common.listSep')) })}
              </div>
            ) : prid ? (
              <button
                onClick={() => void openRoom(prid)}
                className="flex items-center gap-1 truncate text-xs text-ink-3 hover:text-primary"
                title={t('chat.area.backToParent')}
              >
                <span className="rounded bg-primary-light px-1 text-xs text-primary">{t('chat.discussion.badge')}</span>
                {t('chat.area.fromParent', {
                  name: parentRoom?.fname || parentRoom?.name || t('chat.area.parentFallback'),
                })}
              </button>
            ) : (
              room?.topic && <div className="truncate text-xs text-ink-3">{room.topic}</div>
            )}
          </div>
          <div className="flex items-center gap-0.5 rounded-xl border border-line-soft bg-surface-2/80 p-0.5">
            {hasUnread ? (
              <HeaderButton
                icon={ListRestart}
                label={t('chat.area.nextUnread')}
                onClick={onNextUnread}
              />
            ) : null}
            <HeaderButton
              icon={Pin}
              label={t('chat.area.pinnedMessages')}
              active={rightPanel?.kind === 'pins'}
              onClick={() => togglePanel({ kind: 'pins' })}
            />
            <HeaderButton
              icon={Search}
              label={t('chat.area.searchMessages')}
              active={rightPanel?.kind === 'search'}
              onClick={() => togglePanel({ kind: 'search' })}
            />
            <HeaderButton
              icon={SquareKanban}
              label={t('chat.kanban.boardTitle')}
              active={rightPanel?.kind === 'kanban'}
              onClick={() => togglePanel({ kind: 'kanban' })}
            />
            <HeaderButton
              icon={MoreHorizontal}
              label={t('chat.area.more')}
              active={rightPanel?.kind === 'starred'}
              onClick={() => {
                setMoreMenu(null);
                const btn = document.activeElement as HTMLElement;
                const rect = btn?.getBoundingClientRect();
                setMoreMenu(rect ? { x: rect.right - 140, y: rect.bottom + 4 } : { x: 0, y: 0 });
              }}
            />
          </div>
        </header>
        {moreMenu && (
          <ContextMenu
            x={moreMenu.x}
            y={moreMenu.y}
            items={[
              {
                label: sub?.t === 'd' && !isMultiDM ? t('chat.area.contactInfo') : t('chat.area.roomInfo'),
                icon: Info,
                onClick: () => togglePanel({ kind: 'info' }),
              },
              {
                label: t('chat.area.members'),
                icon: Users,
                onClick: () => togglePanel({ kind: 'members' }),
              },
              {
                label: t('chat.area.starredMessages'),
                icon: Star,
                onClick: () => togglePanel({ kind: 'starred' }),
              },
              {
                label: t('chat.area.files'),
                icon: Files,
                onClick: () => togglePanel({ kind: 'files' }),
              },
              {
                label: t('chat.area.mentions'),
                icon: AtSign,
                onClick: () => togglePanel({ kind: 'mentions' }),
              },
            ]}
            onClose={() => setMoreMenu(null)}
          />
        )}
        {agentProjectMenu && (
          <ContextMenu
            x={agentProjectMenu.x}
            y={agentProjectMenu.y}
            items={[
              ...agentWorkspaces.map((path) => ({
                label: `${path.name}${path.path === boundAgentWorkspace ? t('chat.area.boundRoomSuffix') : path.path === preferredAgentWorkspace ? t('chat.area.defaultEnvSuffix') : ''} · ${path.path}`,
                icon: FolderOpen,
                onClick: () => {
                  setRoomHostingWorkspace(activeRid, path.path);
                  setPanel({ kind: 'agent', tmid: agentSessionKey });
                },
              })),
              {
                label: t('chat.area.manageProjectsInButler'),
                icon: Bot,
                onClick: openButlerConversation,
              },
            ]}
            onClose={() => setAgentProjectMenu(null)}
          />
        )}
        {roomAiMenu && activeRoomAi && (
          <ContextMenu
            x={roomAiMenu.x}
            y={roomAiMenu.y}
            items={[
              ...(activeRoomAi.mode !== 'roundtable'
                ? [
                    {
                      label: t('chat.aiParticipant.upgradeRoundtableMenu'),
                      icon: Bot,
                      onClick: () => {
                        useRoomAiParticipants.getState().upgradeToRoundtable(activeRid);
                        toast.success(t('chat.aiParticipant.upgradedRoundtableToast'));
                      },
                    },
                  ]
                : (activeRoomAi.seats ?? []).map((seat) => ({
                    label: `${seat.enabled ? '✓ ' : '○ '}${seat.roleTitle}`,
                    icon: Users,
                    onClick: () => {
                      useRoomAiParticipants.getState().toggleSeat(activeRid, seat.seatId);
                    },
                  }))),
              ...listSelectableProjectWorkspaces().slice(0, 4).map((ws) => ({
                label: `${ws.path === activeRoomAi.workspaceRoot ? '✓ ' : ''}${ws.label} · ${ws.path}`,
                icon: FolderOpen,
                onClick: () => {
                  useRoomAiParticipants.getState().updateParticipant(activeRid, { workspaceRoot: ws.path });
                },
              })),
              {
                label:
                  activeRoomAi.replyPolicy === 'every_message'
                    ? t('chat.aiParticipant.switchToMentionOnly')
                    : t('chat.aiParticipant.switchToEveryMessage'),
                icon: AtSign,
                onClick: () => {
                  const nextPolicy =
                    activeRoomAi.replyPolicy === 'every_message'
                      ? 'mention_only'
                      : 'every_message';
                  useRoomAiParticipants
                    .getState()
                    .updateParticipant(activeRid, { replyPolicy: nextPolicy });
                },
              },
              {
                label: t('chat.aiParticipant.removeFromRoom'),
                icon: Bot,
                onClick: () => {
                  useRoomAiParticipants.getState().removeParticipant(activeRid);
                  toast.info(
                    t('chat.aiParticipant.removedToast', { agent: activeRoomAi.agentName }),
                  );
                },
              },
            ]}
            onClose={() => setRoomAiMenu(null)}
          />
        )}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MessageList
            key={`${activeRid}:${messageScrollTransaction?.rid === activeRid ? messageScrollTransaction.generation : 0}`}
            rid={activeRid}
            transaction={messageScrollTransaction?.rid === activeRid ? messageScrollTransaction : null}
          />
          {features.butler && butlerPanelOpen && ButlerPanel ? <ButlerPanel /> : null}
          {features.butler && !butlerPanelOpen ? (
            <button
              ref={butlerLauncherRef}
              id="room-butler-launcher"
              type="button"
              aria-controls="room-butler-panel"
              aria-expanded="false"
              aria-label={t('chat.area.openRoomButler')}
              title={t('chat.area.openRoomButler')}
              onClick={() => togglePanel({ kind: 'butler' })}
              onDragOver={(e) => {
                if (!hasChatToButlerDrag(e.dataTransfer)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                setDraggingLauncher(true);
              }}
              onDragLeave={() => setDraggingLauncher(false)}
              onDrop={(e) => {
                const payload = readChatToButlerDrag(e.dataTransfer);
                setDraggingLauncher(false);
                if (!payload) return;
                e.preventDefault();
                e.stopPropagation();
                setPanel({ kind: 'butler' });
                useUI.getState().seedRoomButler(activeRid, formatChatMessagesForButlerPrompt(payload));
              }}
              className={`group absolute right-4 bottom-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-white shadow-[var(--shadow-pop)] transition duration-150 hover:scale-105 hover:bg-primary-hover active:scale-95 motion-reduce:transition-none ${
                draggingLauncher ? 'scale-110 ring-4 ring-primary/40' : ''
              }`}
            >
              <Bot
                size={21}
                className="transition-transform duration-150 group-hover:-rotate-6 motion-reduce:transition-none"
              />
            </button>
          ) : null}
        </div>
        {/* 从讨论卡片/搜索进来但还没加入的公开房间：给出加入入口（issue #19-6）。
            不加入也能看历史，但收不到通知、不在会话列表里。 */}
        {requiresJoin && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-primary-light/40 px-4 py-2.5">
            <span className="min-w-0 truncate text-sm text-ink-2">
              {prid ? t('chat.area.joinDiscussionPrompt') : t('chat.area.joinChannelPrompt')}
            </span>
            <button
              onClick={() => void joinRoom(activeRid)}
              className="h-7 shrink-0 rounded-lg bg-primary px-3 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
            >
              {prid ? t('chat.area.joinDiscussionBtn') : t('chat.area.joinChannelBtn')}
            </button>
          </div>
        )}
        {liveRoundtable && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-primary/20 bg-primary-light/40 px-4 py-1.5 text-xs">
            <div className="flex min-w-0 items-center gap-2 text-ink">
              <Bot size={13} className="shrink-0 animate-pulse text-primary" />
              <span className="truncate font-medium text-primary">
                {liveRoundtable.currentSeatTitle}
              </span>
              <span className="truncate text-ink-2">
                {liveRoundtable.activityHint} ({liveRoundtable.stepIndex}/{liveRoundtable.totalSteps})
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => skipCurrentRoundtableSeat(activeRid)}
                className="rounded border border-line bg-surface-4 px-2 py-0.5 text-xs text-ink-2 transition hover:border-primary/40 hover:text-primary"
              >
                {t('chat.aiParticipant.stageSkipBtn')}
              </button>
              <button
                type="button"
                onClick={() => forceSynthesizeRoundtableNow(activeRid)}
                className="rounded border border-primary/30 bg-primary-light px-2 py-0.5 text-xs font-medium text-primary transition hover:bg-primary/20"
              >
                {t('chat.aiParticipant.stageSynthesizeBtn')}
              </button>
            </div>
          </div>
        )}
        {canCompose && <Composer />}

        {draggingAi ? (
          <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary-light/70 backdrop-blur-[1px]">
            <Bot size={32} className="text-primary" />
            <span className="text-sm font-medium text-primary">
              {t('chat.aiParticipant.dropOverlayTitle', { room: name })}
            </span>
            <span className="text-xs text-ink-2">{t('chat.aiParticipant.dropOverlayHint')}</span>
          </div>
        ) : draggingShare ? (
          <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary-light/70 backdrop-blur-[1px]">
            <Bot size={32} className="text-primary" />
            <span className="text-sm font-medium text-primary">{t('chat.butlerBridge.dropOverlayTitle')}</span>
            <span className="text-xs text-ink-2">{t('chat.butlerBridge.dropOverlayHint')}</span>
          </div>
        ) : dragging ? (
          <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary-light/60">
            <Upload size={32} className="text-primary" />
            <span className="text-sm font-medium text-primary">{t('chat.area.dropFilesHint')}</span>
          </div>
        ) : null}
      </main>

      {ActivePanel && <ActivePanel />}
    </>
  );
}
