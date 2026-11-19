import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  CopyPlus,
  Cpu,
  FileCode2,
  FolderGit2,
  GitBranch,
  History,
  Lock,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import {
  bindWorkSessionToCard,
  getSuperAgentRuntimeDrivers,
  openOrResumeWorkSession,
  pauseCardAcpWorkflow,
  parseWorkSessionProviderMeta,
  spawnCardWorkerInWorktree,
  syncLiveSessionsIntoLedger,
} from '../agent/superAgentBridge';
import { evaluateCardCompletionGate } from '../agent/workCoordinator';
import { codexHandoffProfileId, matchesAcpWorkSession } from '../agent/sessionAdapter';
import { buildWorkflowExecutionReport } from '../agent/workflowReport';
import { observeWorkArtifacts } from '../agent/workArtifacts';
import { executePreparedExternalAction, readExternalActionSpec } from '../agent/externalWorkActions';
import { agentDeviceId } from '../agent/device';
import { useAuth } from '../stores/auth';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { workContextPathKey } from '../lib/workContext';
import { isNativeHostSession } from '../lib/nativeWorkOwnership';
import type {
  NativeWorkCard,
  NativeWorkSessionRecord,
  NativeWorkspaceGitSnapshot,
  WorkCardAutonomyMode,
  WorkCardStage,
  WorkEvidenceKind,
  WorkSessionControlMode,
} from '../platform/desktopCommands';
import { useAcpAgents } from '../stores/acpAgents';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import { useWorkLedger } from '../stores/workLedger';
import { absoluteWorkspace, beginWorkInvestigation, chooseStartProfile, eligibleCodexProfiles, isWorkStartPending, useNativeWorkStarts, workStartKey } from '../stores/nativeWorkStarts';
import { isTauriRuntime } from '../lib/http';
import WorkStartProfile from './WorkStartProfile';
import WorkflowReportCard from './WorkflowReportCard';
import WorkMethodReuse from './WorkMethodReuse';
import WorkSessionHistoryPreview from './WorkSessionHistoryPreview';
import NativeCodexWorkScene from './NativeCodexWorkScene';

type PortalTab = 'briefing' | 'sessions' | 'evidence' | 'timeline' | 'report' | 'settings';

const STAGE_ITEMS: { key: WorkCardStage; label: string }[] = [
  { key: 'triage', label: '待整理' },
  { key: 'ready', label: '可执行' },
  { key: 'in_progress', label: '执行中' },
  { key: 'verifying', label: '待验证' },
  { key: 'done', label: '已完成' },
];

const SESSION_STATUS_LABELS: Record<NativeWorkSessionRecord['runtimeStatus'], string> = {
  idle: '当前空闲', running: '执行中', waiting_input: '等待补充', waiting_approval: '等待授权',
  stopped: '已停止', error: '执行出错', ended: '已结束', interrupted: '已中断', unknown: '活动状态未知',
};

const WAIT_STATE_LABELS = {
  none: '没有等待项', waiting_input: '等待补充', waiting_approval: '等待授权',
  waiting_external: '等待外部结果', blocked: '工作受阻', paused: '已暂停跟进', canceled: '已取消跟进',
};

const SESSION_BADGE_MAP: Record<
  WorkSessionControlMode,
  { label: string; className: string }
> = {
  controllable: {
    label: '可实时控制',
    className: 'bg-success/15 text-success border border-success/30',
  },
  resumable: {
    label: '可恢复',
    className: 'bg-primary/15 text-primary border border-primary/30',
  },
  readonly: {
    label: '只读',
    className: 'bg-fill-3 text-ink-3 border border-line',
  },
};

export interface WorkCardPortalProps {
  card: NativeWorkCard;
  onClose: () => void;
  onSelectWork?: (workId: string) => void;
  layout?: 'panel' | 'page' | 'workspace';
  resultTarget?: 'evidence' | 'reply';
  resultTurnId?: string;
  resultSessionId?: string;
  resultRequest?: object;
}

export default function WorkCardPortal({ card, onClose, onSelectWork, layout = 'panel', resultTarget, resultTurnId, resultSessionId, resultRequest }: WorkCardPortalProps) {
  const {
    links,
    sessions,
    evidences,
    events,
    actions,
    updateCard,
    moveCardStage,
    pauseCardAutomation,
    resumeCardAutomation,
    addEvidence,
    acceptWork,
    transitionDispatchAction,
  } = useWorkLedger();

  const acpAgents = useAcpAgents((state) => state.agents);
  const loadingAgents = useAcpAgents((state) => state.loading);
  const acpSessionsMap = useAcpAgents((state) => state.sessions);
  const hydrateAcpAgents = useAcpAgents((state) => state.hydrate);
  const openAcpHub = useUI((state) => state.openAcpHub);

  const entryKey = JSON.stringify([card.id, resultTarget, resultSessionId, resultTurnId]);
  const [navigation, setNavigation] = useState<{ entry: string; request?: object; tab: PortalTab | null }>({ entry: entryKey, request: resultRequest, tab: null });
  const sameEntry = navigation.entry === entryKey && navigation.request === resultRequest;
  if (!sameEntry) setNavigation({ entry: entryKey, request: resultRequest, tab: null });
  const manualTab = sameEntry ? navigation.tab : null;
  const activeTab = manualTab ?? (resultTarget === 'evidence' ? 'evidence' : 'briefing');
  const showRequestedReply = !manualTab && resultTarget === 'reply';
  const moreMenu = useRef<HTMLDetailsElement>(null);
  const contentArea = useRef<HTMLDivElement>(null);
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null);
  const [previewSession, setPreviewSession] = useState<NativeWorkSessionRecord | null>(null);
  const [selectedNativeSessionId, setSelectedNativeSessionId] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const accountScope = useAuth(() => resolveButlerAccountScope());
  const startKey = workStartKey(accountScope, card.id);
  const trial = useNativeWorkStarts(state => state.trials[startKey]);
  const [profileChoice, setProfileChoice] = useState<{ key: string; id: string } | null>(null);
  const [goalDraft, setGoalDraft] = useState(card.state.goal ?? '');
  const [nextStepDraft, setNextStepDraft] = useState(card.state.nextStep ?? '');
  const briefingEdit = useRef({ workId: card.id, dirty: false, version: card.state.requirementsVersion ?? 0 });
  const workIdentity = useRef<{ workId: string } | null>({ workId: card.id });
  if (workIdentity.current?.workId !== card.id) workIdentity.current = { workId: card.id };
  const actionSequence = useRef(0);
  const [newAcceptance, setNewAcceptance] = useState('');
  const [workerInstruction, setWorkerInstruction] = useState('');
  const [selectedAcpId, setSelectedAcpId] = useState('');
  const [spawning, setSpawning] = useState(false);
  const boundWorkspace = sessions.find((session) => session.todoId === card.id && session.workspaceRoot)?.workspaceRoot
    ?? links.find((link) => link.todoId === card.id && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace')?.repo ?? '';
  const [workspaceDraft, setWorkspaceDraft] = useState(boundWorkspace);

  useEffect(() => {
    void hydrateAcpAgents();
  }, [hydrateAcpAgents]);

  useEffect(() => {
    if (!selectedAcpId && acpAgents.length > 0) {
      const enabled = acpAgents.find((a) => a.enabled) || acpAgents[0];
      if (enabled) setSelectedAcpId(enabled.id);
    }
  }, [acpAgents, selectedAcpId]);

  const [evidenceKind, setEvidenceKind] = useState<WorkEvidenceKind>('test_run');
  const [evidenceTitle, setEvidenceTitle] = useState('');
  const [evidenceSource, setEvidenceSource] = useState('');
  const [evidencePassed, setEvidencePassed] = useState(false);
  const [evidenceCriteria, setEvidenceCriteria] = useState<string[]>([]);
  const [acceptedCriteria, setAcceptedCriteria] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [waitReasonDraft, setWaitReasonDraft] = useState(card.state.waitReason ?? '');

  const [gitSnapshot, setGitSnapshot] = useState<NativeWorkspaceGitSnapshot | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const gitRequest = useRef(0);

  useEffect(() => {
    if (!workIdentity.current) workIdentity.current = { workId: card.id };
    return () => { workIdentity.current = null; };
  }, []);
  useEffect(() => {
    actionSequence.current += 1;
    setActionBusy(false);
  }, [card.id]);

  useEffect(() => {
    if (briefingEdit.current.workId === card.id && briefingEdit.current.dirty) return;
    briefingEdit.current = { workId: card.id, dirty: false, version: card.state.requirementsVersion ?? 0 };
    setGoalDraft(card.state.goal ?? '');
    setNextStepDraft(card.state.nextStep ?? '');
  }, [card.id, card.state.goal, card.state.nextStep, card.state.requirementsVersion]);

  useEffect(() => {
    setEvidenceCriteria([]);
    setAcceptedCriteria([]);
    setEvidenceTitle('');
    setEvidenceSource('');
    setEvidencePassed(false);
    setActionError(null);
  }, [card.id, card.state.requirementsVersion, card.state.contentVersion]);

  useEffect(() => setWaitReasonDraft(card.state.waitReason ?? ''), [card.id, card.state.waitReason]);
  useEffect(() => { setPreviewSession(null); setSessionSearch(''); setCandidateId(''); setSelectedNativeSessionId(null); }, [card.id, accountScope]);
  useEffect(() => {
    const ledger = useWorkLedger.getState();
    setWorkspaceDraft(ledger.sessions.find((session) => session.todoId === card.id && session.workspaceRoot)?.workspaceRoot
      ?? ledger.links.find((link) => link.todoId === card.id && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace')?.repo ?? '');
  }, [card.id]);

  const runAction = async (action: () => Promise<unknown>) => {
    if (actionBusy) return;
    const identity = workIdentity.current;
    const request = ++actionSequence.current;
    const isCurrent = () => identity === workIdentity.current && request === actionSequence.current;
    setActionBusy(true);
    setActionError(null);
    try { await action(); } catch (error) {
      if (isCurrent()) setActionError(error instanceof Error ? error.message : String(error));
    } finally { if (isCurrent()) setActionBusy(false); }
  };

  const cardLinks = useMemo(
    () => links.filter((l) => l.todoId === card.id),
    [links, card.id],
  );
  const cardSessions = useMemo(
    () => sessions.filter((s) => s.todoId === card.id),
    [sessions, card.id],
  );
  const cardEvidences = useMemo(
    () => evidences.filter((e) => e.todoId === card.id),
    [evidences, card.id],
  );
  const cardEvents = useMemo(
    () => events.filter((ev) => ev.todoId === card.id),
    [events, card.id],
  );
  const cardActions = useMemo(
    () => actions.filter((a) => a.todoId === card.id),
    [actions, card.id],
  );
  const pendingDecisions = useMemo(() => cardActions.flatMap((action) => {
    if (action.state !== 'awaiting_approval') return [];
    const external = readExternalActionSpec(action);
    if (['ado_state_write', 'rc_report', 'ado_comment'].includes(action.actionKind) && !external) return [];
    try {
      const spec = external ?? JSON.parse(action.specJson);
      if (spec?.requirementsVersion !== (card.state.requirementsVersion ?? 0)
        || ((!external || spec.contentVersion !== undefined) && spec.contentVersion !== (card.state.contentVersion ?? 0))) return [];
      const summary = external?.kind === 'ado_state_write'
        ? `将工作项 #${external.workItemId} 从“${external.expectedState}”更新为“${external.targetState}”`
        : external?.kind === 'rc_report' ? `发送汇报“${external.reportTitle}”`
          : typeof spec.specText === 'string' && spec.specText.trim() ? spec.specText.trim()
            : '继续推进这项工作，需要你确认执行要求。';
      return [{ action, summary }];
    } catch { return []; }
  }).sort((a, b) => b.action.updatedAt - a.action.updatedAt), [cardActions, card.state.requirementsVersion, card.state.contentVersion]);
  const unconfirmedDecisions = cardActions.filter((action) => action.state === 'awaiting_approval'
    && !pendingDecisions.some((decision) => decision.action.id === action.id));

  const completionGate = useMemo(
    () => evaluateCardCompletionGate(card, cardEvidences),
    [card, cardEvidences],
  );
  const requestedSessionId = showRequestedReply ? resultSessionId : undefined;
  const primarySession = requestedSessionId
    ? cardSessions.find((s) => s.id === requestedSessionId && parseWorkSessionProviderMeta(s).provider === 'codex') ?? null
    : cardSessions.find((session) => session.id === selectedNativeSessionId)
      ?? [...cardSessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  const primarySessionMeta = primarySession ? parseWorkSessionProviderMeta(primarySession) : null;
  const preparedWork = !primarySession && card.state.stage === 'ready' && card.state.visibility === 'private'
    && card.state.waitState === 'none' && card.state.autonomyMode !== 'readonly' && Boolean(boundWorkspace.trim())
    && !pendingDecisions.length && !unconfirmedDecisions.length;
  const codexProfiles = useMemo(() => eligibleCodexProfiles(acpAgents), [acpAgents]);
  const startWorkspace = trial?.notStarted ? workspaceDraft.trim() : boundWorkspace;
  const profileChoiceKey = JSON.stringify([startKey, workContextPathKey(startWorkspace)]);
  const startProfile = chooseStartProfile(codexProfiles, startWorkspace, profileChoice?.key === profileChoiceKey ? profileChoice.id : '');
  const projectCandidates = useMemo(() => {
    if (!preparedWork) return [];
    const project = workContextPathKey(boundWorkspace);
    const device = agentDeviceId();
    return sessions.filter((s) => {
      // The desktop ledger normalizes discovered CLI sessions to external_discovered.
      if (s.todoId || !['native_cli', 'external_discovered'].includes(s.origin) || s.visibility !== 'private' || s.accountScope !== accountScope
        || workContextPathKey(s.workspaceRoot) !== project || isNativeHostSession(s)) return false;
      const profileId = codexHandoffProfileId(s, device);
      return codexProfiles.some((agent) => agent.id === profileId && agent.sourceScope === s.sourceScope);
    });
  }, [preparedWork, boundWorkspace, sessions, accountScope, codexProfiles]);
  const candidate = projectCandidates.length === 1 ? projectCandidates[0] : projectCandidates.find((s) => s.id === candidateId);
  const nativePage = layout !== 'panel' && activeTab === 'briefing' && primarySessionMeta?.provider === 'codex';
  useEffect(() => {
    if (primarySession && primarySessionMeta?.provider === 'codex' && selectedNativeSessionId !== primarySession.id
      && (requestedSessionId || !selectedNativeSessionId)) setSelectedNativeSessionId(primarySession.id);
  }, [requestedSessionId, selectedNativeSessionId, primarySession?.id, primarySessionMeta?.provider]);
  const latestEvidence = cardEvidences.filter((evidence) => !evidence.stale
    && (evidence.requirementsVersion ?? 0) === (card.state.requirementsVersion ?? 0)
    && (evidence.contentVersion ?? 0) === (card.state.contentVersion ?? 0))
    .sort((a, b) => b.verifiedAt - a.verifiedAt)[0] ?? null;
  const latestIsVerification = latestEvidence && ['test_run', 'ci_build', 'diff_check', 'manual_ack'].includes(latestEvidence.kind);
  const isFollowed = (card.state.requirementsVersion ?? 0) > 0;
  const canStopExecution = cardSessions.some((session) => session.controlMode === 'controllable' && session.runtimeStatus === 'running');

  const cardAcpSession = useMemo(
    () => Object.values(acpSessionsMap).find((s) => s.linkedTodoId === card.id) ?? null,
    [acpSessionsMap, card.id],
  );

  const cardReport = useMemo(
    () =>
      buildWorkflowExecutionReport({
        card,
        acpSession: cardAcpSession ?? undefined,
        sessions: cardSessions,
        evidences: cardEvidences,
        links: cardLinks,
      }),
    [card, cardAcpSession, cardEvidences, cardLinks, cardSessions],
  );

  const primaryWorkspaceRoot = useMemo(() => {
    const fromSession = primarySession?.workspaceRoot.trim();
    if (fromSession) return fromSession;
    return workspaceDraft.trim();
  }, [primarySession?.workspaceRoot, workspaceDraft]);

  const unboundLocalSessions = useMemo(() => {
    const targetNorm = workContextPathKey(primaryWorkspaceRoot);
    const query = sessionSearch.trim().toLocaleLowerCase();
    return sessions
      .filter((s) => !s.todoId)
      .filter((s) => !query || [s.title, s.workspaceRoot, parseWorkSessionProviderMeta(s).label].some((value) => value?.toLocaleLowerCase().includes(query)))
      .sort((a, b) => {
        const aNorm = workContextPathKey(a.workspaceRoot);
        const bNorm = workContextPathKey(b.workspaceRoot);
        const aMatch = targetNorm && aNorm === targetNorm ? 1 : 0;
        const bMatch = targetNorm && bNorm === targetNorm ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return b.updatedAt - a.updatedAt;
      });
  }, [primaryWorkspaceRoot, sessionSearch, sessions]);

  const refreshGitSnapshot = async () => {
    const requestId = ++gitRequest.current;
    const drivers = getSuperAgentRuntimeDrivers();
    if (!drivers.isDesktop() || !primaryWorkspaceRoot) {
      setGitSnapshot(null);
      return;
    }
    setGitLoading(true);
    setGitError(null);
    try {
      const snap = await drivers.inspectWorkspaceGit(primaryWorkspaceRoot);
      if (requestId !== gitRequest.current) return;
      setGitSnapshot(snap);
    } catch (error) {
      if (requestId !== gitRequest.current) return;
      setGitSnapshot(null);
      setGitError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === gitRequest.current) setGitLoading(false);
    }
  };

  useEffect(() => {
    setGitSnapshot(null);
    void refreshGitSnapshot();
    return () => { gitRequest.current += 1; };
  }, [card.id, primaryWorkspaceRoot]);

  const handleSaveBriefing = async (enroll = false) => {
    const identity = workIdentity.current;
    const draft = briefingEdit.current;
    const updated = await updateCard(card.id, {
      goal: goalDraft.trim() || null,
      nextStep: nextStepDraft.trim() || null,
      expectedRequirementsVersion: draft.version,
      ...(enroll ? { enroll: true } : {}),
    });
    if (identity !== workIdentity.current || draft !== briefingEdit.current) return;
    briefingEdit.current = { workId: card.id, dirty: false, version: updated.state.requirementsVersion ?? 0 };
    toast.success(enroll ? '已纳入管家跟进' : '已保存卡片简报');
  };

  const handleAddAcceptance = async () => {
    const trimmed = newAcceptance.trim();
    if (!trimmed) return;
    await updateCard(card.id, {
      acceptance: [...card.state.acceptance, trimmed],
      expectedRequirementsVersion: card.state.requirementsVersion ?? 0,
    });
    setNewAcceptance('');
    toast.success('已添加验收条件');
  };

  const handleRemoveAcceptance = async (index: number) => {
    await updateCard(card.id, {
      acceptance: card.state.acceptance.filter((_, idx) => idx !== index),
      expectedRequirementsVersion: card.state.requirementsVersion ?? 0,
    });
  };

  const handleSpawnWorker = async (
    isolateWorktree: boolean,
    importFromSessionId?: string | null,
    overrideRuntime?: 'acp',
  ) => {
    setSpawning(true);
    try {
      const res = await spawnCardWorkerInWorktree({
        todoId: card.id,
        instruction: workerInstruction,
        isolateWorktree,
        importFromSessionId,
        runtime: overrideRuntime,
        acpAgentId: overrideRuntime === 'acp' ? selectedAcpId || undefined : undefined,
        repoRootOverride: primaryWorkspaceRoot,
      });
      if (!res.ok) {
        toast.error(res.error || '派工失败');
        return;
      }
      setWorkerInstruction('');
      toast.success(
        overrideRuntime === 'acp'
          ? '已向本地 ACP 客户端派发任务'
          : res.worktree
            ? `已在隔离 Worktree (${res.worktree.branch}) 启动 Worker 会话`
            : '已向受管 Worker 派发任务',
      );
      void refreshGitSnapshot();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSpawning(false);
    }
  };

  const handleMoveStage = async (stage: WorkCardStage) => {
    if (stage === 'done') {
      await observeWorkArtifacts(card.id);
      await updateCard(card.id, { stage, expectedRequirementsVersion: card.state.requirementsVersion ?? 0, expectedContentVersion: card.state.contentVersion ?? 0 });
      toast.success('当前版本验收完成');
      return;
    }
    const res = await moveCardStage(card.id, stage);
    if (!res.ok) {
      toast.error(res.error || '无法流转阶段');
      return;
    }
    toast.success(
      `已流转至「${STAGE_ITEMS.find((s) => s.key === stage)?.label}」`,
    );
  };

  const handleRecordEvidence = async () => {
    if (!evidenceTitle.trim() || !evidenceSource.trim() || !evidenceCriteria.length) return;
    const prLink = cardLinks.find((l) => l.kind === 'ado_pr');
    await addEvidence({
      todoId: card.id,
      sessionId: cardSessions[0]?.id ?? null,
      kind: evidenceKind,
      title: evidenceTitle.trim(),
      summary: evidenceSource.trim(),
      headSha: gitSnapshot?.headSha ?? prLink?.headSha ?? null,
      workspaceRoot: primaryWorkspaceRoot || null,
      webUrl: prLink?.webUrl ?? null,
      passed: evidencePassed,
      criterionIds: evidenceCriteria,
      requirementsVersion: card.state.requirementsVersion ?? 0,
      contentVersion: card.state.contentVersion ?? 0,
    });
    setEvidenceTitle('');
    setEvidenceSource('');
    setEvidenceCriteria([]);
    setEvidencePassed(false);
    toast.success('已登记验证记录');
  };

  const handleAccept = async () => {
    await observeWorkArtifacts(card.id);
    await acceptWork(card.id, {
      actorId: useAuth.getState().user?._id ?? `local:${agentDeviceId()}`,
      criterionIds: acceptedCriteria,
      requirementsVersion: card.state.requirementsVersion ?? 0,
      contentVersion: card.state.contentVersion ?? 0,
    });
    toast.success('已记录人工接受范围并完成工作');
  };

  const handleOpenOrResumeSession = async (session: (typeof sessions)[number], handoffConfirmed = false) => {
    if (parseWorkSessionProviderMeta(session).provider === 'codex') {
      setSelectedNativeSessionId(session.id);
      selectTab('briefing');
      return;
    }
    if (session.controlMode === 'readonly' && !handoffConfirmed) {
      setPreviewSession(session);
      return;
    }
    const identity = workIdentity.current;
    const accountScope = resolveButlerAccountScope();
    setActionError(null);
    setSessionBusyId(session.id);
    try {
      await openOrResumeWorkSession(session, { handoffConfirmed });
      const runtime = handoffConfirmed ? 'acp' : session.runtime;
      if (runtime === 'acp' || runtime === 'pi') requestAnimationFrame(() => requestAnimationFrame(() => {
        if (resolveButlerAccountScope() !== accountScope) return;
        if (runtime === 'acp') {
          const state = useAcpAgents.getState();
          const active = state.activeSessionKey ? state.sessions[state.activeSessionKey] : null;
          if (!active || !matchesAcpWorkSession(session, active, resolveButlerAccountScope())) return;
        }
        const composer = [...document.querySelectorAll<HTMLTextAreaElement>(`textarea[data-work-composer="${runtime}"]`)]
          .find((element) => element.dataset.workSessionId === session.nativeSessionId);
        if (composer && !composer.disabled && composer.getClientRects().length) composer.focus();
      }));
    } catch (error) {
      if (identity === workIdentity.current) setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (identity === workIdentity.current) setSessionBusyId(null);
    }
  };

  const handleBindSessionToThisCard = async (sessionId: string) => {
    setSessionBusyId(sessionId);
    try {
      await bindWorkSessionToCard(sessionId, card.id);
      toast.success('已将该本机会话绑定到当前卡片');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionBusyId(null);
    }
  };

  const handleUnbindSessionFromCard = async (sessionId: string) => {
    setSessionBusyId(sessionId);
    try {
      await bindWorkSessionToCard(sessionId, null);
      toast.success('已解除会话与卡片的绑定');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionBusyId(null);
    }
  };

  const budgetRatio = Math.min(
    100,
    Math.round(
      (card.state.autoTurnsUsed / Math.max(1, card.state.maxAutoTurns)) * 100,
    ),
  );

  const selectTab = (tab: PortalTab) => {
    setNavigation({ entry: entryKey, request: resultRequest, tab });
    if (moreMenu.current) moreMenu.current.open = false;
  };
  const showDecision = (actionId: string) => {
    selectTab('timeline');
    requestAnimationFrame(() => {
      const action = [...(contentArea.current?.querySelectorAll<HTMLElement>('[data-work-action-id]') ?? [])]
        .find((element) => element.dataset.workActionId === actionId);
      action?.scrollIntoView({ block: 'nearest' });
    });
  };

  return (
    <aside aria-label="工作详情" className={`work-first-detail flex min-w-0 flex-col overflow-hidden bg-surface-4 ${nativePage ? 'work-first-detail-native' : ''} ${layout === 'workspace' ? 'work-first-detail-workspace h-full w-full flex-1' : layout === 'page' ? 'work-first-detail-page h-full w-full flex-1' : 'absolute inset-0 z-20 rounded-lg border border-line-strong shadow-raise xl:relative xl:inset-auto xl:w-[480px] xl:shrink-0'}`}>
      {/* Portal 顶部标题栏 */}
      <div className={`work-first-detail-header border-b border-line ${nativePage ? '' : 'px-4 py-3'}`}>
        <div className={`work-first-detail-topline flex items-center justify-between gap-3 ${nativePage ? 'mb-1.5' : 'mb-4'}`}>
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 rounded text-sm text-ink-3 hover:text-ink"><ArrowLeft size={16} />返回我的工作</button>
          <details ref={moreMenu} className="work-first-detail-more relative" onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }}>
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded px-2 py-1 text-sm text-ink-3 hover:bg-fill-hover"><MoreHorizontal size={18} />更多</summary>
            <div className="absolute right-0 z-30 mt-1 w-44 space-y-1 rounded-lg border border-line bg-surface-2 p-2 shadow-raise">
              {([
                { key: 'sessions', label: `会话 (${cardSessions.length})` },
                { key: 'timeline', label: `动态 (${cardEvents.length + cardActions.length})` },
                { key: 'report', label: '汇报' },
                { key: 'settings', label: '工作设置' },
              ] as const).map((item) => <button key={item.key} type="button" onClick={() => selectTab(item.key)} className="block w-full rounded px-2 py-2 text-left text-sm text-ink-2 hover:bg-fill-hover">{item.label}</button>)}
            </div>
          </details>
        </div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="work-first-detail-meta flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
              <span className="inline-flex items-center gap-0.5 rounded bg-fill-2 px-1.5 py-0.5">
                {card.state.visibility === 'private' ? (
                  <>
                    <Lock size={10} /> 个人工作
                  </>
                ) : (
                  <>
                    <Users size={10} /> 房间共享
                  </>
                )}
              </span>
              {card.adoWorkItemId && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  WI #{card.adoWorkItemId}
                </span>
              )}
              {primarySessionMeta && <span>{primarySessionMeta.label}</span>}
              <details className="work-control-location"><summary>工作位置 · 本机</summary><p>{primaryWorkspaceRoot || '尚未绑定工作目录，不能开始写入。'}</p></details>
            </div>
            <h3 className={`work-first-detail-title font-semibold text-ink break-words ${nativePage ? 'mt-1 text-base' : 'mt-2 text-xl'} ${preparedWork ? 'line-clamp-2' : ''}`}>
              {card.title}
            </h3>
          </div>

        </div>

        {(!nativePage || card.state.waitState !== 'none') && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          {!nativePage && <span className="rounded bg-fill-2 px-2 py-0.5 text-ink-2">{preparedWork ? '待开始' : primarySessionMeta?.provider === 'codex' ? 'Codex 原会话' : primarySession?.controlMode === 'readonly' ? '仅查看记录' : STAGE_ITEMS.find((stage) => stage.key === card.state.stage)?.label ?? '工作阶段未知'}</span>}
          {card.state.waitState !== 'none' && <span>{WAIT_STATE_LABELS[card.state.waitState] ?? '等待状态未知'}</span>}
          {primarySession && primarySessionMeta?.provider !== 'codex' && <span>{primarySession.controlMode === 'readonly' && primarySession.runtimeStatus === 'unknown' ? '进展待确认' : SESSION_STATUS_LABELS[primarySession.runtimeStatus] ?? '活动状态未知'}</span>}
        </div>}
      </div>

      {/* Portal 导航栏 */}
      <div className={`work-first-detail-actions flex flex-wrap items-center gap-5 border-b border-line text-sm ${nativePage ? 'px-5' : 'px-4'}`}>
        {(
          [
            { key: 'briefing', label: '这项工作' },
            { key: 'evidence', label: `${primarySessionMeta?.provider === 'codex' ? '验证记录' : '成果与验证'} (${cardEvidences.length})` },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            onClick={() => selectTab(item.key)}
            className={`border-b-2 py-2 text-center font-medium transition ${
              activeTab === item.key
                ? 'border-primary text-primary'
                : 'border-transparent text-ink-3 hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
        {!['briefing', 'evidence'].includes(activeTab) && <span className="py-2 text-primary">{{ sessions: '关联会话', timeline: '工作动态', report: '工作汇报', settings: '工作设置' }[activeTab as 'sessions' | 'timeline' | 'report' | 'settings']}</span>}
      </div>

      {/* Portal 内容滚动区 */}
      <div ref={contentArea} className={`work-first-detail-body flex-1 text-xs ${nativePage ? '' : 'space-y-4 overflow-y-auto p-4'}`}>
        {actionError && <div role="alert" className="rounded border border-danger/30 bg-danger/10 p-2 text-danger">{actionError}</div>}
        {activeTab === 'briefing' && trial && !requestedSessionId && !(trial.notStarted && primarySession) ? <section aria-label="调查启动状态" className="space-y-3 rounded-lg border border-line p-4 text-sm">
          <h4 className="font-semibold text-ink">{isWorkStartPending(startKey) ? '正在提交调查' : trial.notStarted ? '调查未开始' : '开工状态待核对'}</h4>
          {trial.error && <p role="status" className="break-words text-ink-2">{trial.error}</p>}
          {trial.notStarted ? <>
            <label className="work-control-field">工作目录<input value={workspaceDraft} onChange={event => setWorkspaceDraft(event.target.value)} /></label>
            <WorkStartProfile profiles={codexProfiles} value={startProfile?.id} onChange={id => setProfileChoice({ key: profileChoiceKey, id })} />
            {codexProfiles.length ? <button type="button" disabled={actionBusy || !startProfile || !absoluteWorkspace(startWorkspace)}
              className="rounded-lg bg-primary px-4 py-2 text-white disabled:opacity-50" onClick={() => {
                if (startProfile) void runAction(() => beginWorkInvestigation(card, startWorkspace, startProfile.id));
              }}>开始调查</button> : <button type="button" onClick={() => openAcpHub(null)} className="text-primary">打开执行器设置</button>}
          </> : <><p className="break-all text-xs text-ink-2">{trial.input.workspaceRoot}</p>
            {!isWorkStartPending(startKey) && <button type="button" disabled={actionBusy} className="text-primary"
              onClick={() => void runAction(() => beginWorkInvestigation(card, trial.input.workspaceRoot, trial.input.executionProfileId))}>核对并重试</button>}</>}
        </section> : activeTab === 'briefing' && requestedSessionId && !primarySession ? <p role="status" className="text-sm text-ink-2">这条回复的原会话已不在这项工作中。请返回看板查看最新结果。</p>
        : nativePage && primarySession ? <NativeCodexWorkScene key={primarySession.id} card={card} session={primarySession} resultRequest={resultRequest} resultTurnId={showRequestedReply ? resultTurnId ?? '' : undefined} fillHeight onViewHistory={() => setPreviewSession(primarySession)} onViewResults={() => selectTab('evidence')}
          requirements={<details className="native-work-requirements"><summary>工作要求</summary><div className="mt-2 space-y-2 text-sm text-ink-2"><p className="whitespace-pre-wrap break-words">{card.state.goal || '还没有单独整理目标，可先核对原会话中的要求。'}</p><button type="button" onClick={() => selectTab('settings')} className="text-xs text-primary hover:underline">编辑工作要求</button></div></details>} /> : activeTab === 'briefing' && (
          <>
            <section className="work-first-detail-overview space-y-6 text-sm leading-relaxed">
              {!preparedWork && <div className="work-first-detail-goal">
                <h4 className="font-semibold text-ink">工作目标</h4>
                <p className="mt-2 whitespace-pre-wrap break-words text-ink-2">{card.state.goal || '还没有单独整理目标。先查看已有记录，确认这次希望继续的内容。'}</p>
              </div>}
              {pendingDecisions.length > 0 && <section aria-label="待你决定" className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                <h4 className="font-semibold text-ink">有 {pendingDecisions.length} 件事需要你决定</h4>
                <p className="mt-2 whitespace-pre-wrap break-words text-ink-2">{pendingDecisions[0].summary.length > 180 ? `${pendingDecisions[0].summary.slice(0, 180)}…` : pendingDecisions[0].summary}</p>
                <p className="mt-1 text-xs text-ink-3">查看具体要求后，可以批准或取消。打开详情不会执行这项操作。</p>
                <button type="button" onClick={() => showDecision(pendingDecisions[0].action.id)} className="mt-3 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover">查看待决定事项</button>
              </section>}
              {unconfirmedDecisions.length > 0 && <section aria-label="旧请求待核对" className="rounded-xl border border-line p-4">
                <h4 className="font-semibold text-ink">有 {unconfirmedDecisions.length} 条旧请求需要核对</h4>
                <p className="mt-2 text-ink-2">请求版本已过期或信息不完整，不能直接批准。可以查看原记录或取消请求。</p>
                <button type="button" onClick={() => showDecision(unconfirmedDecisions[0].id)} className={`mt-3 rounded-lg px-4 py-2.5 text-sm font-medium ${pendingDecisions.length ? 'border border-line text-ink-2 hover:bg-fill-hover' : 'bg-primary text-white hover:bg-primary-hover'}`}>核对旧请求</button>
              </section>}
              {primarySessionMeta?.provider !== 'codex' && (!preparedWork || latestEvidence) && (latestEvidence ? <div className="work-first-detail-progress rounded-xl border border-line bg-surface-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="font-semibold text-ink">{latestIsVerification ? '最近验证' : latestEvidence.kind === 'agent_report' ? '执行者说明 · 未核验' : '参考记录 · 未核验'}</h4>
                  {latestIsVerification && <span className={`rounded px-1.5 py-0.5 text-xs ${latestEvidence.passed ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>{latestEvidence.passed ? '通过' : '未通过'}</span>}
                </div>
                <p className="mt-1 break-words text-ink-2">{latestEvidence.title}</p>
                {latestEvidence.summary && <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">{latestEvidence.summary}</p>}
                <button type="button" onClick={() => selectTab('evidence')} className="mt-1 text-xs text-primary hover:underline">查看记录来源 · {new Date(latestEvidence.verifiedAt).toLocaleString('zh-CN')}</button>
              </div> : primarySessionMeta?.preview ? <div className="work-first-detail-progress rounded-xl border border-line bg-surface-3 p-4">
                <h4 className="font-semibold text-ink">会话摘要</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">{primarySessionMeta.preview}</p>
                <p className="mt-1 text-xs text-ink-3">来自 {primarySessionMeta.label} 的会话记录，尚未核对后续进展。</p>
              </div> : <div className="work-first-detail-progress rounded-xl border border-line bg-surface-3 p-4"><h4 className="font-semibold text-ink">最近进展</h4><p className="mt-2 text-ink-3">还没有可核对的执行结果。{primarySession ? '可以打开原对话查看已发生的工作。' : '这项工作尚未关联执行会话。'}</p></div>)}
              {primarySessionMeta?.provider !== 'codex' && (card.state.waitReason || card.state.nextStep || !preparedWork && primarySession?.controlMode !== 'readonly') && <div className="work-first-detail-next">
                <h4 className="font-semibold text-ink">{card.state.waitReason ? '当前阻碍' : '下一步'}</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">{card.state.waitReason || card.state.nextStep || '可先查看已有对话；明确后续要求后再继续。'}</p>
              </div>}
              {primarySession && primarySessionMeta?.provider === 'codex' ? <NativeCodexWorkScene key={primarySession.id} card={card} session={primarySession} resultRequest={resultRequest} resultTurnId={showRequestedReply ? resultTurnId ?? '' : undefined} onViewHistory={() => setPreviewSession(primarySession)} onViewResults={() => selectTab('evidence')} /> : primarySession ? <div className="work-first-detail-primary border-t border-line pt-4">
                <p className="work-first-detail-resume-note text-sm text-ink-2">{primarySession.controlMode === 'readonly' ? card.state.waitReason || card.state.nextStep ? '当前连接仅支持查看记录，不能从这里发送要求。' : '查看原对话，确认当前进展；当前仅支持查看记录。' : `将打开 ${primarySessionMeta?.label ?? '执行者'} 原对话，在那里继续补充要求。`}</p>
                <button type="button" disabled={sessionBusyId === primarySession.id} onClick={() => void handleOpenOrResumeSession(primarySession)}
                  className={`mt-3 inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50 ${pendingDecisions.length || unconfirmedDecisions.length ? 'border border-line text-ink-2 hover:bg-fill-hover' : 'bg-primary text-white hover:bg-primary-hover'}`}>
                  {sessionBusyId === primarySession.id ? '正在打开…' : primarySession.controlMode === 'readonly' ? '查看对话' : '继续这项工作'}<ArrowUpRight size={16} />
                </button>
              </div> : preparedWork ? <section aria-label="连接项目会话" className="work-first-detail-primary order-first min-w-0 space-y-3">
                <p className="truncate text-sm text-ink-2" title={boundWorkspace}>项目 · {card.state.projectKey || boundWorkspace.split(/[\\/]/).filter(Boolean).at(-1) || boundWorkspace}</p>
                {projectCandidates.length ? <>
                  {projectCandidates.length === 1 ? <p className="line-clamp-2 break-words text-base font-semibold text-ink" title={candidate?.title || candidate?.nativeSessionId}>{candidate?.title || candidate?.nativeSessionId}</p>
                    : <select aria-label="本项目的 Codex 会话" value={candidate?.id ?? ''} onChange={(event) => setCandidateId(event.target.value)} className="w-full rounded border border-line bg-surface-3 p-2 text-ink">
                      <option value="">选择原会话</option>{projectCandidates.map((s) => <option key={s.id} value={s.id}>{s.title || s.nativeSessionId}</option>)}
                    </select>}
                  <button type="button" disabled={actionBusy || !candidate} onClick={() => void runAction(async () => {
                    if (!candidate || resolveButlerAccountScope() !== accountScope) return;
                    const current = useWorkLedger.getState().sessions.find((s) => s.id === candidate.id);
                    if (current !== candidate || current.todoId) throw new Error('会话记录已更新，请重新选择。');
                    if (!await bindWorkSessionToCard(candidate.id, card.id)) throw new Error('会话已不可用，请刷新项目会话。');
                  })} className="rounded-lg bg-primary px-4 py-2 text-white hover:bg-primary-hover disabled:opacity-50">继续这个 Codex 会话</button>
                  <p className="text-xs text-ink-2">下一步核对原会话，确认原窗口已停止后再接续。</p>
                </> : loadingAgents ? <p role="status" className="text-ink-2">正在查找本机执行器…</p>
                : !codexProfiles.length ? <><p className="text-ink-2">先接入本机的 Codex，就可以关联这个目录里的原会话。</p>
                  <button type="button" onClick={() => openAcpHub(null)} className="rounded-lg border border-line px-3 py-2 text-primary">打开执行器设置</button>
                </> : <>{isTauriRuntime() && <>
                  <WorkStartProfile profiles={codexProfiles} value={startProfile?.id} onChange={id => setProfileChoice({ key: profileChoiceKey, id })} />
                  <button type="button" disabled={actionBusy || !startProfile || !card.state.goal?.trim()} onClick={() => {
                    if (startProfile) void runAction(() => beginWorkInvestigation(card, boundWorkspace, startProfile.id));
                  }} className="rounded-lg bg-primary px-4 py-2 text-white hover:bg-primary-hover disabled:opacity-50">开始调查</button>
                </>}
                  <p className="text-xs text-ink-2">要接续已有会话，请在原窗口停止执行后刷新。</p>
                  <button type="button" disabled={actionBusy} onClick={() => void runAction(() => syncLiveSessionsIntoLedger({ limit: 300 }))} className="text-sm text-primary disabled:opacity-50">{actionBusy ? '正在查找…' : '刷新项目会话'}</button>
                </>}
                <details className="text-sm text-ink-2"><summary className="cursor-pointer text-xs text-ink-3">工作要求与设置</summary>
                  <p className="mt-2 whitespace-pre-wrap break-words">{card.state.goal || card.title}</p>
                  <button type="button" onClick={() => selectTab('settings')} className="mt-2 text-primary hover:underline">设置执行方式</button>
                </details>
              </section> : pendingDecisions.length || unconfirmedDecisions.length ? null : <div className="work-first-detail-primary border-t border-line pt-4"><p className="text-ink-2">这项工作还没有连接执行者。可以关联已有对话，保留原工作上下文。</p><button type="button" onClick={() => selectTab('sessions')} className="mt-3 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover">关联已有对话</button><button type="button" onClick={() => selectTab('settings')} className="ml-3 mt-3 text-sm text-ink-3 hover:text-primary">设置执行方式</button></div>}
              <div className="work-first-detail-secondary flex flex-wrap gap-5 border-t border-line pt-4 text-sm">
                <button type="button" onClick={() => selectTab('report')} className="text-ink-3 hover:text-primary">查看工作汇报</button>
                <button type="button" onClick={() => selectTab('settings')} className="text-ink-3 hover:text-primary">编辑工作要求</button>
              </div>
            </section>
          </>
        )}
        {activeTab === 'settings' && (
          <>
            <section className="space-y-2 rounded-md border border-line bg-surface-3 p-3">
              <h4 className="font-medium text-ink-2">验收条件</h4>
              {card.state.acceptance.length ? <ul className="list-disc space-y-1 pl-4 text-sm leading-relaxed text-ink-2">{card.state.acceptance.map((item, index) => <li key={`${index}-${item}`} className="break-words">{item}</li>)}</ul>
                : <p className="text-ink-3">尚未设置验收条件。</p>}
            </section>

            {cardSessions.length === 0 && <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-primary">开始执行</summary>
              <div className="mt-3 space-y-2">
                {!isFollowed && <p className="text-ink-3">补充目标与验收条件并纳入管家跟进后，可启动执行。</p>}
                <label className="block text-ink-3">执行目录
                  <input aria-label="执行目录" value={workspaceDraft} onChange={(e) => setWorkspaceDraft(e.target.value)} placeholder="填写该工作的本地项目路径" className="mt-1 w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
                </label>
                <input value={workerInstruction} onChange={(e) => setWorkerInstruction(e.target.value)} placeholder="输入推进要求（留空则按卡片下一步自动生成规格）…" className="w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
                <div className="flex flex-wrap gap-2">
                  <button disabled={spawning || !isFollowed} onClick={() => void handleSpawnWorker(true)} className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-white hover:bg-primary-hover disabled:opacity-50"><FolderGit2 size={12} />隔离 Worktree 派工</button>
                  <button disabled={spawning || !isFollowed} onClick={() => void handleSpawnWorker(false)} className="rounded bg-fill-2 px-2.5 py-1 text-ink-2 hover:bg-fill-hover disabled:opacity-50">当前目录派工</button>
                </div>
                {acpAgents.length > 0 ? <div className="flex gap-2">
                  <select aria-label="执行客户端" value={selectedAcpId} onChange={(e) => setSelectedAcpId(e.target.value)} className="min-w-0 flex-1 rounded border border-line bg-surface-4 px-2 py-1 text-ink">
                    {acpAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} ({agent.preset})</option>)}
                  </select>
                  <button type="button" disabled={spawning || !selectedAcpId || !isFollowed} onClick={() => void handleSpawnWorker(false, null, 'acp')} className="rounded bg-primary/10 px-2 py-1 text-primary disabled:opacity-50">派发 ACP 客户端</button>
                </div> : <button type="button" onClick={() => openAcpHub()} className="text-ink-3 hover:text-primary">配置并接入本地 ACP 客户端</button>}
              </div>
            </details>}

            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">编辑目标与下一步</summary>
              <div className="mt-3 space-y-2">
                <div className="font-medium text-ink-2">工作目标</div>
                <textarea rows={3} value={goalDraft} onChange={(e) => { briefingEdit.current = { ...briefingEdit.current, dirty: true }; setGoalDraft(e.target.value); }} placeholder="明确这张卡片最终要收敛的交付目标…" className="w-full rounded border border-line bg-surface-4 p-2 text-sm text-ink" />
                <div className="font-medium text-ink-2">下一步</div>
                {briefingEdit.current.dirty && briefingEdit.current.version !== (card.state.requirementsVersion ?? 0) && <div className="space-y-1 rounded border border-warning/30 p-2 text-warning">
                  <div>已保存目标更新为 v{card.state.requirementsVersion}：{card.state.goal}</div>
                  <div>你的输入已保留。核对上方当前目标后，可基于此版本继续编辑并保存。</div>
                  <button type="button" className="text-primary hover:underline" onClick={() => { briefingEdit.current = { ...briefingEdit.current, version: card.state.requirementsVersion ?? 0 }; setActionError(null); }}>基于当前版本继续编辑</button>
                </div>}
                <input value={nextStepDraft} onChange={(e) => { briefingEdit.current = { ...briefingEdit.current, dirty: true }; setNextStepDraft(e.target.value); }} placeholder="例如：修复 CI 编译告警并补充回归测试" className="w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
                <div className="flex justify-end"><button onClick={() => void runAction(handleSaveBriefing)} className="rounded bg-primary px-2.5 py-1 text-white hover:bg-primary-hover">保存简报</button></div>
              </div>
            </details>

            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">管理跟进与阶段</summary>
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-1">{STAGE_ITEMS.map((stage) => <button key={stage.key} disabled={actionBusy || card.state.stage === stage.key} onClick={() => void runAction(() => handleMoveStage(stage.key))} className={`rounded px-2 py-1 ${card.state.stage === stage.key ? 'bg-primary text-white' : 'bg-fill-2 text-ink-2 hover:bg-fill-hover'}`}>{stage.label}</button>)}</div>
                {isFollowed && <button type="button" disabled={actionBusy} onClick={() => void runAction(() => card.state.waitState === 'paused' ? resumeCardAutomation(card.id) : pauseCardAutomation(card.id))} className="inline-flex items-center gap-1 text-primary disabled:opacity-50">
                  {card.state.waitState === 'paused' ? <><PlayCircle size={12} />恢复自动跟进</> : <><PauseCircle size={12} />暂停自动跟进</>}
                </button>}
                {canStopExecution && <div className="space-y-2 text-ink-3"><p>正在执行的轮次仍按原要求运行；可打开原会话追加要求。</p><button type="button" disabled={actionBusy} className="text-warning hover:underline disabled:opacity-50" onClick={() => void runAction(async () => { await pauseCardAcpWorkflow(card.id, '用户接管工作'); toast.success('后续跟进已暂停，当前执行状态见工作现场'); })}>接管并停止本轮</button></div>}
            <WorkMethodReuse workId={card.id} projectKey={card.state.projectKey} workspaceRoot={primaryWorkspaceRoot} onSelectWork={onSelectWork} />
            {/* 分级自主与轮次预算 */}
            <div className="rounded-md border border-line bg-surface-3 p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink-2">自主级别与轮次预算</span>
                <select
                  value={card.state.autonomyMode}
                  onChange={(e) =>
                    void updateCard(card.id, {
                      autonomyMode: e.target.value as WorkCardAutonomyMode,
                    }).then(() => toast.success('已更新自主模式'))
                  }
                  className="rounded border border-line bg-surface-4 px-2 py-0.5 text-xs text-ink"
                >
                  <option value="readonly">仅观察</option>
                  <option value="confirm">建议确认</option>
                  <option value="autonomous">受控自动跟进</option>
                </select>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-ink-3">
                <span>
                  自动推进已用 {card.state.autoTurnsUsed} / {card.state.maxAutoTurns} 轮
                </span>
                {card.state.autoTurnsUsed > 0 && (
                  <button
                    onClick={() =>
                      void updateCard(card.id, {
                        autoTurnsUsed: 0,
                        consecutiveFailures: 0,
                      }).then(() => toast.success('已重置轮次预算'))
                    }
                    className="text-primary hover:underline"
                  >
                    重置额度
                  </button>
                )}
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-fill-2">
                <div
                  className={`h-full transition-all ${
                    budgetRatio >= 100 ? 'bg-warning' : 'bg-primary'
                  }`}
                  style={{ width: `${budgetRatio}%` }}
                />
              </div>
              <label className="mt-2 block text-ink-3">最多自动轮次
                <input aria-label="最多自动轮次" type="number" min={1} max={20} value={card.state.maxAutoTurns}
                  onChange={(e) => { const count = Number(e.target.value); if (Number.isInteger(count) && count >= 1 && count <= 20) void runAction(() => updateCard(card.id, { maxAutoTurns: count })); }}
                  className="ml-2 w-16 rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
              </label>
              <label className="mt-2 block text-ink-3">自动跟进截止时间
                <input aria-label="自动跟进截止时间" type="datetime-local"
                  value={card.state.deadlineAt ? new Date(card.state.deadlineAt - new Date(card.state.deadlineAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''}
                  onChange={(e) => void runAction(() => updateCard(card.id, { deadlineAt: e.target.value ? new Date(e.target.value).getTime() : null }))}
                  className="mt-1 block w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
              </label>
              <p className="mt-2 text-ink-3">运行进程存活时持续跟进；退出或休眠后在下次启动时核对恢复。预算耗尽或截止后停止新派发。</p>
            </div>
              </div>
            </details>

            {/* 验收清单 */}
            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">编辑验收条件</summary>
              <div className="mt-3 space-y-2">
              <div className="font-medium text-ink-2">
                验收条件（修改范围将使旧完成证据自动过期）
              </div>
              <div className="space-y-1">
                {card.state.acceptance.map((item, idx) => (
                  <div
                    key={`${idx}-${item}`}
                    className="flex items-center justify-between gap-2 rounded bg-surface-4 px-2 py-1"
                  >
                    <span className="text-ink">• {item}</span>
                    <button
                      disabled={card.state.acceptance.length === 1 && (card.state.requirementsVersion ?? 0) > 0}
                      onClick={() => void runAction(() => handleRemoveAcceptance(idx))}
                      className="text-ink-3 hover:text-danger"
                    >
                      移除
                    </button>
                  </div>
                ))}
                {card.state.acceptance.length === 0 && (
                  <div className="text-ink-3">尚未设置显式验收标准</div>
                )}
              </div>
              <div className="flex gap-1.5">
                <input
                  value={newAcceptance}
                  onChange={(e) => setNewAcceptance(e.target.value)}
                  placeholder="新增一条验收标准…"
                  className="flex-1 rounded border border-line bg-surface-4 px-2 py-1 text-xs text-ink"
                />
                <button
                  onClick={() => void runAction(handleAddAcceptance)}
                  className="inline-flex items-center gap-0.5 rounded bg-fill-2 px-2 py-1 text-ink-2 hover:bg-fill-hover"
                >
                  <Plus size={12} /> 添加
                </button>
              </div>
              {(card.state.requirementsVersion ?? 0) === 0 && <button type="button"
                disabled={actionBusy || !goalDraft.trim() || !card.state.acceptance.length}
                onClick={() => void runAction(() => handleSaveBriefing(true))}
                className="rounded bg-primary px-2 py-1 text-white disabled:opacity-50">纳入管家跟进</button>}
            </div>
            </details>

            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">等待与复查</summary>
              <div className="mt-3 space-y-2">
              <div className="text-ink-3">当前：{WAIT_STATE_LABELS[card.state.waitState] ?? '等待状态未知'}{card.state.waitReason ? ` · ${card.state.waitReason}` : ''}</div>
              <input aria-label="等待原因" value={waitReasonDraft} onChange={(e) => setWaitReasonDraft(e.target.value)} placeholder="需要谁提供什么，或正在等待的外部结果" className="w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={actionBusy || !waitReasonDraft.trim()} onClick={() => void runAction(() => updateCard(card.id, { waitState: 'waiting_input', waitReason: waitReasonDraft.trim() }))}>等待补充</button>
                <button type="button" disabled={actionBusy || !waitReasonDraft.trim()} onClick={() => void runAction(() => updateCard(card.id, { waitState: 'waiting_external', waitReason: waitReasonDraft.trim() }))}>等待外部结果</button>
                <button type="button" disabled={actionBusy || card.state.waitState === 'none'} onClick={() => void runAction(() => updateCard(card.id, { waitState: 'none', waitReason: null }))}>已处理等待</button>
                <button type="button" disabled={actionBusy || card.state.waitState === 'canceled'} onClick={() => void runAction(() => updateCard(card.id, { waitState: 'canceled', waitReason: '用户取消后续跟进', nextCheckAt: null }))}>取消后续跟进</button>
              </div>
              <label className="block text-ink-3">下次复查
                <input aria-label="下次复查" type="datetime-local" value={card.state.nextCheckAt ? new Date(card.state.nextCheckAt - new Date(card.state.nextCheckAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''}
                  onChange={(e) => void runAction(() => updateCard(card.id, { nextCheckAt: e.target.value ? new Date(e.target.value).getTime() : null }))}
                  className="mt-1 block w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
              </label>
            </div>
            </details>

            {/* 实时 Git 工作区 / Worktree 状态 */}
            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">工作区 Git 快照</summary>
              <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1 font-medium text-ink-2">
                  <FileCode2 size={13} />
                  工作区 Git 实时快照
                </span>
                <button
                  onClick={() => void refreshGitSnapshot()}
                  className="inline-flex items-center gap-0.5 text-ink-3 hover:text-primary"
                >
                  <RefreshCw size={11} className={gitLoading ? 'animate-spin' : ''} />
                  刷新
                </button>
              </div>

              {gitLoading ? <div role="status" className="text-ink-3">正在读取工作区…</div> : gitError ? <div role="alert" className="text-warning">读取失败：{gitError}。可刷新重试。</div> : gitSnapshot ? (
                <div className="space-y-1.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded px-1.5 py-0.5 font-medium ${
                        gitSnapshot.isWorktree
                          ? 'bg-success/15 text-success'
                          : 'bg-fill-2 text-ink-2'
                      }`}
                    >
                      {gitSnapshot.isWorktree ? '隔离 Worktree' : '主工作区'}
                    </span>
                    {gitSnapshot.branch && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-fill-2 px-1.5 py-0.5 text-ink">
                        <GitBranch size={10} />
                        {gitSnapshot.branch}
                      </span>
                    )}
                    {gitSnapshot.headSha && (
                      <span className="rounded bg-fill-2 px-1.5 py-0.5 font-mono text-ink-3">
                        @{gitSnapshot.headSha.slice(0, 8)}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-ink-3" title={gitSnapshot.workspaceRoot}>
                    路径：{gitSnapshot.workspaceRoot}
                  </div>
                  {gitSnapshot.diffStat && (
                    <pre className="max-h-24 overflow-auto rounded bg-surface-4 p-2 font-mono text-xs text-ink-2">
                      {gitSnapshot.diffStat}
                    </pre>
                  )}
                  <div className="text-ink-3">
                    未提交变更：{gitSnapshot.dirtyFiles.length} 个文件
                  </div>
                </div>
              ) : (
                <div className="text-ink-3">
                  关联 Worker 会话或选择桌面本地 Git 工作区后展示实时分支与 Diff 摘要
                </div>
              )}
            </div>
            </details>
          </>
        )}

        {activeTab === 'sessions' && (
          <div className="space-y-3">
            {cardSessions.map((session) => {
              const badge = SESSION_BADGE_MAP[session.controlMode];
              const meta = parseWorkSessionProviderMeta(session);
              const busy = sessionBusyId === session.id;
              return (
                <div
                  key={session.id}
                  className="space-y-2 rounded-md border border-line bg-surface-3 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 font-medium text-ink">
                        {session.runtime === 'acp' ? <Cpu size={13} /> : <Bot size={13} />}
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-semibold text-primary">
                          {meta.label}
                        </span>
                        <span className="truncate">
                          {session.title || session.nativeSessionId.slice(0, 12)}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-ink-3">
                        目录：{session.workspaceRoot || '未知目录'}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${badge.className}`}>
                      {badge.label}
                    </span>
                  </div>

                  <div className="text-xs text-ink-3">状态：{SESSION_STATUS_LABELS[session.runtimeStatus] ?? '活动状态未知'}{session.controlReason ? ` · ${session.controlReason}` : ''}</div>

                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleOpenOrResumeSession(session)}
                      className="inline-flex items-center gap-1 rounded bg-primary/15 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
                    >
                      <PlayCircle size={11} />
                      {session.controlMode === 'readonly' ? '查看对话' : '打开会话'}
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleUnbindSessionFromCard(session.id)}
                      className="inline-flex items-center gap-1 rounded bg-fill-2 px-2 py-1 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink disabled:opacity-50"
                    >
                      <X size={11} />
                      解除绑定
                    </button>

                    {session.controlMode === 'readonly' && <details className="w-full">
                      <summary className="cursor-pointer text-ink-3">创建独立执行会话</summary>
                      <p className="my-2 text-xs text-ink-3">新会话只引用来源信息，不会接管原会话，也不代表完整历史已经迁移。</p>
                      <button
                        disabled={spawning}
                        onClick={() => void handleSpawnWorker(true, session.id)}
                        className="inline-flex items-center gap-1 rounded bg-primary/15 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/25"
                      >
                        <CopyPlus size={11} />
                        引用来源创建独立会话
                      </button>
                    </details>}
                  </div>
                </div>
              );
            })}

            {cardSessions.length === 0 && (
              <div className="rounded-md border border-dashed border-line p-5 text-center text-ink-3">
                当前工作尚未关联会话。可以关联下方已有对话，或在工作设置中选择执行方式。
              </div>
            )}

            <details open={cardSessions.length === 0 || undefined} className="space-y-2 border-t border-line pt-3">
              <summary className="cursor-pointer text-xs font-medium text-ink-2"><History size={12} className="mr-1 inline" />关联其他已有会话</summary>
              <input aria-label="搜索可关联的会话" value={sessionSearch} onChange={(e) => setSessionSearch(e.target.value)} placeholder="按标题、项目目录或来源搜索" className="w-full rounded border border-line bg-surface-4 px-2 py-1.5 text-ink" />
              <div className="text-ink-3">{unboundLocalSessions.length} 个匹配会话</div>
              {unboundLocalSessions.length === 0 ? (
                <div className="rounded-md border border-dashed border-line p-3 text-center text-xs text-ink-3">
                  {sessionSearch.trim() ? '没有匹配的会话，请调整关键词。' : '暂无未关联工作的本机会话。'}
                </div>
              ) : (
                <div className="max-h-80 space-y-1.5 overflow-y-auto">
                  {unboundLocalSessions.map((s) => {
                    const meta = parseWorkSessionProviderMeta(s);
                    const busy = sessionBusyId === s.id;
                    return (
                      <div
                        key={s.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface-3 px-2.5 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="rounded-full bg-fill-2 px-1.5 py-0.5 text-2xs font-medium text-ink-2">
                              {meta.label}
                            </span>
                            <span className="truncate text-xs font-medium text-ink">
                              {s.title || s.nativeSessionId.slice(0, 12)}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate font-mono text-xs text-ink-3">
                            {s.workspaceRoot || '未知目录'}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleBindSessionToThisCard(s.id)}
                          className="shrink-0 rounded bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                        >
                          绑定到此卡
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </details>
          </div>
        )}

        {activeTab === 'evidence' && (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-ink-3">查看这项工作的实际记录与验证结果。执行者说明仅供参考；修改要求后的旧记录不代表当前成果已经通过验证。</p>
            {cardEvidences.length === 0 && <div className="rounded-xl border border-dashed border-line p-6 text-sm text-ink-3">还没有成果或验证记录。已有对话中的内容可从「这项工作」继续查看。</div>}
            <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-sm text-ink-3">验收与验证管理</summary>
              <div className="mt-3 space-y-3">
            <div
              className={`rounded-md border p-3 ${
                completionGate.canMarkDone
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-warning/30 bg-warning/10 text-warning'
              }`}
            >
              <div className="inline-flex items-center gap-1 font-medium">
                {completionGate.canMarkDone ? (
                  <ShieldCheck size={14} />
                ) : (
                  <ShieldAlert size={14} />
                )}
                完成门禁判定
              </div>
              <div className="mt-1 text-xs">{completionGate.reason}</div>
              <div className="mt-2 text-ink-2">人工接受将记录当前账号与明确选择的条件，修改要求或返工后需要重新验收。</div>
              <fieldset className="mt-2 space-y-1" disabled={actionBusy || card.state.stage === 'done'}>
                <legend className="font-medium">人工接受范围</legend>
                {card.state.acceptance.map((criterion) => <label key={criterion} className="flex items-start gap-2 text-ink">
                  <input type="checkbox" aria-label={`接受条件：${criterion}`} checked={acceptedCriteria.includes(criterion)}
                    onChange={(e) => setAcceptedCriteria((current) => e.target.checked ? [...current, criterion] : current.filter((item) => item !== criterion))} />
                  {criterion}
                </label>)}
              </fieldset>
              {card.state.stage !== 'done' && <button type="button"
                disabled={actionBusy || !card.state.acceptance.length || card.state.waitState !== 'none' || !card.state.acceptance.every((criterion) => acceptedCriteria.includes(criterion) || completionGate.validEvidences.some((e) => e.criterionIds?.includes(criterion))) || !acceptedCriteria.length}
                onClick={() => void runAction(handleAccept)}
                className="mt-2 inline-flex items-center gap-1 rounded bg-surface-4 px-2.5 py-1 text-ink disabled:opacity-50">
                <CheckCircle2 size={12} />接受所选条件并完成
              </button>}
              <button type="button" disabled={actionBusy || (card.state.requirementsVersion ?? 0) === 0}
                onClick={() => void runAction(async () => { await updateCard(card.id, { rework: true, stage: 'in_progress', waitState: 'none', waitReason: null, expectedRequirementsVersion: card.state.requirementsVersion ?? 0, expectedContentVersion: card.state.contentVersion ?? 0 }); toast.success('已在原工作上返工，旧证据已过期'); })}
                className="mt-2 block text-primary hover:underline disabled:opacity-50">在本工作上返工</button>
            </div>

            <div className="space-y-2 rounded-md border border-line bg-surface-3 p-3">
              <div className="font-medium text-ink-2">登记新验证证据</div>
              <div className="flex gap-1.5">
                <select
                  value={evidenceKind}
                  onChange={(e) => setEvidenceKind(e.target.value as WorkEvidenceKind)}
                  className="rounded border border-line bg-surface-4 px-2 py-1 text-xs text-ink"
                >
                  <option value="test_run">测试运行</option>
                  <option value="ci_build">CI 构建</option>
                  <option value="pr_status">PR 状态</option>
                  <option value="diff_check">Diff 核验</option>
                  <option value="manual_note">人工核验</option>
                </select>
                <input
                  value={evidenceTitle}
                  onChange={(e) => setEvidenceTitle(e.target.value)}
                  aria-label="证据摘要"
                  placeholder="实际验证结果摘要"
                  className="min-w-0 flex-1 rounded border border-line bg-surface-4 px-2 py-1 text-xs text-ink"
                />
              </div>
              <textarea aria-label="证据来源或日志" value={evidenceSource} onChange={(e) => setEvidenceSource(e.target.value)} rows={3}
                placeholder="填写命令与日志、CI 链接或手工验证过程，说明依据"
                className="w-full rounded border border-line bg-surface-4 p-2 text-ink" />
              <fieldset className="space-y-1">
                <legend className="text-ink-2">此记录覆盖的验收条件</legend>
                {card.state.acceptance.map((criterion) => <label key={criterion} className="flex items-start gap-2 text-ink">
                  <input type="checkbox" aria-label={`证据覆盖：${criterion}`} checked={evidenceCriteria.includes(criterion)}
                    onChange={(e) => setEvidenceCriteria((current) => e.target.checked ? [...current, criterion] : current.filter((item) => item !== criterion))} />
                  {criterion}
                </label>)}
              </fieldset>
              <label className="flex items-center gap-2 text-ink"><input type="checkbox" checked={evidencePassed} onChange={(e) => setEvidencePassed(e.target.checked)} />我已核查该记录，结果通过</label>
              <div className="flex justify-end">
                <button
                  disabled={actionBusy || !evidenceTitle.trim() || !evidenceSource.trim() || !evidenceCriteria.length}
                  onClick={() => void runAction(handleRecordEvidence)}
                  className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  <Plus size={12} /> 登记验证记录
                </button>
              </div>
            </div>
              </div>
            </details>

            <div className="space-y-1.5">
              {cardEvidences.map((ev) => (
                <div
                  key={ev.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface-3 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className={ev.stale ? 'line-through text-ink-3' : 'font-medium text-ink'}>
                      {ev.title}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-3">
                      类型：{ev.kind}
                      {` · 要求 v${ev.requirementsVersion ?? '?'} / 成果 v${ev.contentVersion ?? '?'}`}
                      {ev.headSha ? ` · SHA @${ev.headSha.slice(0, 7)}` : ''}
                    </div>
                    {ev.summary && <div className="mt-1 whitespace-pre-wrap text-ink-3">{ev.summary}</div>}
                    {!!ev.criterionIds?.length && <div className="mt-1 text-ink-3">覆盖：{ev.criterionIds.join('、')}</div>}
                    {ev.acceptedBy && <div className="mt-1 text-ink-3">接受人：{ev.acceptedBy}</div>}
                  </div>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                      ev.stale
                        ? 'bg-warning/15 text-warning'
                        : ev.passed
                          ? 'bg-success/15 text-success'
                          : 'bg-danger/15 text-danger'
                    }`}
                  >
                    {ev.stale ? `已过期 (${ev.staleReason})` : ev.kind === 'manual_note' || ev.kind === 'agent_report' ? '参考记录' : ev.passed ? '通过' : '未通过'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'timeline' && (
          <div className="space-y-2.5">
            {[...cardActions].sort((a, b) => Number(pendingDecisions.some((item) => item.action.id === b.id)) - Number(pendingDecisions.some((item) => item.action.id === a.id)) || b.updatedAt - a.updatedAt).map((act) => {
              const external = readExternalActionSpec(act);
              const isExternal = ['ado_state_write', 'rc_report', 'ado_comment'].includes(act.actionKind);
              const decision = pendingDecisions.find((item) => item.action.id === act.id);
              return (
              <div
                key={act.id}
                data-work-action-id={act.id}
                className="space-y-1.5 rounded-md border border-line bg-surface-3 p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 font-medium text-ink">
                    <Rocket size={12} />
                    {isExternal ? '同步与投递' : '执行动作'} · {act.actionKind}
                  </span>
                  <span className="rounded bg-fill-2 px-1.5 py-0.5 text-xs text-ink-2">
                    {act.state}
                  </span>
                </div>
                {decision && <p className="whitespace-pre-wrap break-words text-sm text-ink">{decision.summary}</p>}
                {act.state === 'awaiting_approval' && !decision && <p className="text-sm text-warning">请求版本已过期或信息不完整，不能直接批准。可取消旧请求后，按当前工作要求重新提出。</p>}
                {act.receiptRef && (
                  <div className="text-xs text-success">回执：{act.receiptRef}</div>
                )}
                {act.errorMessage && (
                  <div className="text-xs text-danger">错误：{act.errorMessage}</div>
                )}
                {external && <details className="text-xs text-ink-3">
                  <summary className="cursor-pointer">查看提交时快照（要求 v{external.requirementsVersion}）</summary>
                  <div className="mt-1">操作者：{external.actor.userId} · {external.actor.server}</div>
                  {external.kind === 'ado_state_write'
                    ? <div>工作项 #{external.workItemId} · rev {external.expectedRevision} · {external.expectedState} → {external.targetState}</div>
                    : <><div>目标讨论室：{external.rid}</div><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{external.parts.map((part) => part.text).join('\n\n')}</pre></>}
                </details>}
                {isExternal && ['dispatched', 'verifying_delivery'].includes(act.state) && <button type="button" disabled={actionBusy}
                  onClick={() => void runAction(() => executePreparedExternalAction(act.id))}
                  className="text-primary hover:underline disabled:opacity-50">核对送达结果</button>}
                {act.state === 'awaiting_approval' && (
                  <div className="flex items-center gap-1.5 pt-1">
                    <button
                      disabled={actionBusy || !decision || (isExternal && !external)}
                      onClick={() => void runAction(async () => {
                        if (isExternal) {
                          await executePreparedExternalAction(act.id, true);
                        } else {
                          await transitionDispatchAction({ id: act.id, state: 'prepared', expectedState: 'awaiting_approval' });
                          toast.success('已批准并加入执行队列');
                        }
                      })}
                      className="rounded bg-primary px-2 py-0.5 text-xs text-white hover:bg-primary-hover"
                    >
                      批准并执行
                    </button>
                    <button
                      disabled={actionBusy}
                      onClick={() => void runAction(() => transitionDispatchAction({
                          id: act.id,
                          state: 'canceled',
                          expectedState: 'awaiting_approval',
                          errorMessage: '用户在 Portal 取消',
                        }))}
                      className="rounded bg-fill-2 px-2 py-0.5 text-xs text-ink-3 hover:bg-fill-hover"
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            ); })}

            {cardEvents.map((ev) => (
              <div
                key={ev.id}
                className="space-y-1 rounded-md border border-line bg-surface-3 p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 font-medium text-ink-2">
                    <Activity size={12} />
                    {ev.eventType}
                  </span>
                  <span className="text-xs text-ink-3">
                    {ev.correlationTier} · {ev.status}
                  </span>
                </div>
                <div className="truncate text-xs text-ink-3">
                  资源：{ev.resourceKey} (v{ev.resourceVersion})
                </div>
                {ev.statusDetail && (
                  <div className="text-xs text-ink-3">{ev.statusDetail}</div>
                )}
              </div>
            ))}

            {cardActions.length === 0 && cardEvents.length === 0 && (
              <div className="rounded-md border border-dashed border-line p-6 text-center text-ink-3">
                暂无外部事件或派发审计记录
              </div>
            )}
          </div>
        )}

        {activeTab === 'report' && (
          <div className="space-y-3">
            <WorkflowReportCard
              report={cardReport}
              compact
            />
          </div>
        )}
      </div>
      {previewSession && <WorkSessionHistoryPreview key={previewSession.id} session={previewSession} onClose={() => setPreviewSession(null)} />}
    </aside>
  );
}
