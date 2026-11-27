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
  GitCompare,
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
  Terminal,
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
import WorkDiffDrawer from './WorkDiffDrawer';
import ButlerTerminalDrawer from './ButlerTerminalDrawer';
import { useI18n, type MessageKey } from '../i18n';
import { formatDateTime } from '../i18n/format';

type PortalTab = 'briefing' | 'sessions' | 'evidence' | 'timeline' | 'report' | 'settings';

const STAGE_ITEMS: { key: WorkCardStage; labelKey: MessageKey }[] = [
  { key: 'triage', labelKey: 'agent.kanban.stage.triage' },
  { key: 'ready', labelKey: 'agent.kanban.stage.ready' },
  { key: 'in_progress', labelKey: 'agent.kanban.stage.in_progress' },
  { key: 'verifying', labelKey: 'agent.kanban.stage.verifying' },
  { key: 'done', labelKey: 'agent.kanban.stage.done' },
];

const SESSION_STATUS_LABELS: Record<NativeWorkSessionRecord['runtimeStatus'], MessageKey> = {
  idle: 'agent.portal.sessionStatus.idle',
  running: 'agent.portal.sessionStatus.running',
  waiting_input: 'agent.portal.sessionStatus.waiting_input',
  waiting_approval: 'agent.portal.sessionStatus.waiting_approval',
  stopped: 'agent.portal.sessionStatus.stopped',
  error: 'agent.portal.sessionStatus.error',
  ended: 'agent.portal.sessionStatus.ended',
  interrupted: 'agent.portal.sessionStatus.interrupted',
  unknown: 'agent.portal.sessionStatus.unknown',
};

const WAIT_STATE_LABELS: Record<string, MessageKey> = {
  none: 'agent.portal.waitState.none',
  waiting_input: 'agent.portal.waitState.waiting_input',
  waiting_approval: 'agent.portal.waitState.waiting_approval',
  waiting_external: 'agent.portal.waitState.waiting_external',
  blocked: 'agent.portal.waitState.blocked',
  paused: 'agent.portal.waitState.paused',
  canceled: 'agent.portal.waitState.canceled',
};

const SESSION_BADGE_MAP: Record<
  WorkSessionControlMode,
  { labelKey: MessageKey; className: string }
> = {
  controllable: {
    labelKey: 'agent.portal.sessionBadge.controllable',
    className: 'bg-success/15 text-success border border-success/30',
  },
  resumable: {
    labelKey: 'agent.portal.sessionBadge.resumable',
    className: 'bg-primary/15 text-primary border border-primary/30',
  },
  readonly: {
    labelKey: 'agent.portal.sessionBadge.readonly',
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
  const { t, locale } = useI18n();
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
  const [diffOpen, setDiffOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
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
        ? t('agent.portal.pendingDecision.adoState', { id: external.workItemId, expected: external.expectedState, target: external.targetState })
        : external?.kind === 'ado_comment'
          ? t('agent.portal.pendingDecision.adoComment', { id: external.workItemId, preview: external.commentText.slice(0, 80) })
          : external?.kind === 'rc_report' ? t('agent.portal.pendingDecision.rcReport', { title: external.reportTitle })
            : typeof spec.specText === 'string' && spec.specText.trim() ? spec.specText.trim()
              : t('agent.portal.pendingDecision.fallback');
      return [{ action, summary }];
    } catch { return []; }
  }).sort((a, b) => b.action.updatedAt - a.action.updatedAt), [cardActions, card.state.requirementsVersion, card.state.contentVersion, t]);
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
    toast.success(enroll ? t('agent.portal.toast.enrolled') : t('agent.portal.toast.savedBriefing'));
  };

  const handleAddAcceptance = async () => {
    const trimmed = newAcceptance.trim();
    if (!trimmed) return;
    await updateCard(card.id, {
      acceptance: [...card.state.acceptance, trimmed],
      expectedRequirementsVersion: card.state.requirementsVersion ?? 0,
    });
    setNewAcceptance('');
    toast.success(t('agent.portal.toast.addedAcceptance'));
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
        toast.error(res.error || t('agent.portal.toast.spawnFailedFallback'));
        return;
      }
      setWorkerInstruction('');
      toast.success(
        overrideRuntime === 'acp'
          ? t('agent.portal.toast.spawnedAcp')
          : res.worktree
            ? t('agent.portal.toast.spawnedWorktree', { branch: res.worktree.branch })
            : t('agent.portal.toast.spawnedManaged'),
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
      toast.success(t('agent.portal.toast.acceptedVersionDone'));
      return;
    }
    const res = await moveCardStage(card.id, stage);
    if (!res.ok) {
      toast.error(res.error || t('agent.portal.toast.cannotMoveStage'));
      return;
    }
    const stageKey = STAGE_ITEMS.find((s) => s.key === stage)?.labelKey;
    toast.success(
      t('agent.portal.toast.movedStage', { stage: stageKey ? t(stageKey) : stage }),
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
    toast.success(t('agent.portal.toast.recordedEvidence'));
  };

  const handleAccept = async () => {
    await observeWorkArtifacts(card.id);
    await acceptWork(card.id, {
      actorId: useAuth.getState().user?._id ?? `local:${agentDeviceId()}`,
      criterionIds: acceptedCriteria,
      requirementsVersion: card.state.requirementsVersion ?? 0,
      contentVersion: card.state.contentVersion ?? 0,
    });
    toast.success(t('agent.portal.toast.acceptedAndDone'));
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
      toast.success(t('agent.portal.toast.boundSession'));
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
      toast.success(t('agent.portal.toast.unboundSession'));
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

  const stageLabelKey = STAGE_ITEMS.find((stage) => stage.key === card.state.stage)?.labelKey;

  return (
    <aside aria-label={t('agent.portal.detailAria')} className={`work-first-detail flex min-w-0 flex-col overflow-hidden bg-surface-4 ${nativePage ? 'work-first-detail-native' : ''} ${layout === 'workspace' ? 'work-first-detail-workspace h-full w-full flex-1' : layout === 'page' ? 'work-first-detail-page h-full w-full flex-1' : 'absolute inset-0 z-20 rounded-lg border border-line-strong shadow-raise xl:relative xl:inset-auto xl:w-[480px] xl:shrink-0'}`}>
      {/* Portal 顶部标题栏 */}
      <div className={`work-first-detail-header border-b border-line ${nativePage ? '' : 'px-4 py-3'}`}>
        <div className={`work-first-detail-topline flex items-center justify-between gap-3 ${nativePage ? 'mb-1.5' : 'mb-4'}`}>
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 rounded text-sm text-ink-3 hover:text-ink"><ArrowLeft size={16} />{t('agent.portal.backToMyWork')}</button>
          <div className="flex items-center gap-1.5">
            {primaryWorkspaceRoot && getSuperAgentRuntimeDrivers().isDesktop() ? (
              <>
                <button
                  type="button"
                  aria-pressed={terminalOpen}
                  title={t('agent.terminal.buttonTitle')}
                  onClick={() => setTerminalOpen((prev) => !prev)}
                  className="inline-flex items-center gap-1 rounded border border-line bg-surface-3 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover hover:text-ink"
                >
                  <Terminal size={13} aria-hidden="true" />
                  <span>{t('agent.terminal.buttonLabel')}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={diffOpen}
                  title={t('agent.diff.buttonTitle')}
                  onClick={() => setDiffOpen((prev) => !prev)}
                  className="inline-flex items-center gap-1 rounded border border-line bg-surface-3 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover hover:text-ink"
                >
                  <GitCompare size={13} aria-hidden="true" />
                  <span>{t('agent.diff.buttonLabel')}</span>
                  {gitSnapshot && gitSnapshot.dirtyFiles.length > 0 ? (
                    <span className="rounded bg-warning/15 px-1 text-xs text-warning">{gitSnapshot.dirtyFiles.length}</span>
                  ) : null}
                </button>
              </>
            ) : null}
            <details ref={moreMenu} className="work-first-detail-more relative" onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }}>
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded px-2 py-1 text-sm text-ink-3 hover:bg-fill-hover"><MoreHorizontal size={18} />{t('agent.portal.moreBtn')}</summary>
            <div className="absolute right-0 z-30 mt-1 w-44 space-y-1 rounded-lg border border-line bg-surface-2 p-2 shadow-raise">
              {([
                { key: 'sessions', label: t('agent.portal.moreSessions', { count: cardSessions.length }) },
                { key: 'timeline', label: t('agent.portal.moreTimeline', { count: cardEvents.length + cardActions.length }) },
                { key: 'report', label: t('agent.portal.moreReport') },
                { key: 'settings', label: t('agent.portal.moreSettings') },
              ] as const).map((item) => <button key={item.key} type="button" onClick={() => selectTab(item.key)} className="block w-full rounded px-2 py-2 text-left text-sm text-ink-2 hover:bg-fill-hover">{item.label}</button>)}
            </div>
          </details>
          </div>
        </div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="work-first-detail-meta flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
              <span className="inline-flex items-center gap-0.5 rounded bg-fill-2 px-1.5 py-0.5">
                {card.state.visibility === 'private' ? (
                  <>
                    <Lock size={10} /> {t('agent.portal.visibilityPrivate')}
                  </>
                ) : (
                  <>
                    <Users size={10} /> {t('agent.portal.visibilityShared')}
                  </>
                )}
              </span>
              {card.adoWorkItemId && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  WI #{card.adoWorkItemId}
                </span>
              )}
              {primarySessionMeta && <span>{primarySessionMeta.label}</span>}
              <details className="work-control-location"><summary>{t('agent.portal.locationSummary')}</summary><p>{primaryWorkspaceRoot || t('agent.portal.noWorkspaceBound')}</p></details>
            </div>
            <h3 className={`work-first-detail-title font-semibold text-ink break-words ${nativePage ? 'mt-1 text-base' : 'mt-2 text-xl'} ${preparedWork ? 'line-clamp-2' : ''}`}>
              {card.title}
            </h3>
          </div>

        </div>

        {(!nativePage || card.state.waitState !== 'none') && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          {!nativePage && <span className="rounded bg-fill-2 px-2 py-0.5 text-ink-2">{preparedWork ? t('agent.portal.badgeReady') : primarySessionMeta?.provider === 'codex' ? t('agent.portal.badgeCodexNative') : primarySession?.controlMode === 'readonly' ? t('agent.portal.badgeReadonlyOnly') : stageLabelKey ? t(stageLabelKey) : t('agent.portal.badgeUnknownStage')}</span>}
          {card.state.waitState !== 'none' && <span>{t(WAIT_STATE_LABELS[card.state.waitState] ?? 'agent.portal.waitState.unknown')}</span>}
          {primarySession && primarySessionMeta?.provider !== 'codex' && <span>{primarySession.controlMode === 'readonly' && primarySession.runtimeStatus === 'unknown' ? t('agent.portal.statusUnconfirmedProgress') : t(SESSION_STATUS_LABELS[primarySession.runtimeStatus] ?? 'agent.portal.sessionStatus.unknown')}</span>}
        </div>}
      </div>

      {/* Portal 导航栏 */}
      <div className={`work-first-detail-actions flex flex-wrap items-center gap-5 border-b border-line text-sm ${nativePage ? 'px-5' : 'px-4'}`}>
        {(
          [
            { key: 'briefing', label: t('agent.portal.tabBriefing') },
            {
              key: 'evidence',
              label: t('agent.portal.tabEvidenceWithCount', {
                label: primarySessionMeta?.provider === 'codex'
                  ? t('agent.portal.tabEvidenceVerification')
                  : t('agent.portal.tabEvidenceOutcome'),
                count: cardEvidences.length,
              }),
            },
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
        {!['briefing', 'evidence'].includes(activeTab) && <span className="py-2 text-primary">{t({ sessions: 'agent.portal.subtabSessions', timeline: 'agent.portal.subtabTimeline', report: 'agent.portal.subtabReport', settings: 'agent.portal.moreSettings' }[activeTab as 'sessions' | 'timeline' | 'report' | 'settings'] as MessageKey)}</span>}
      </div>

      {/* Portal 内容滚动区 */}
      <div ref={contentArea} className={`work-first-detail-body flex-1 text-xs ${nativePage ? '' : 'space-y-4 overflow-y-auto p-4'}`}>
        {actionError && <div role="alert" className="rounded border border-danger/30 bg-danger/10 p-2 text-danger">{actionError}</div>}
        {activeTab === 'briefing' && trial && !requestedSessionId && !(trial.notStarted && primarySession) ? <section aria-label={t('agent.portal.startTrialAria')} className="space-y-3 rounded-lg border border-line p-4 text-sm">
          <h4 className="font-semibold text-ink">{isWorkStartPending(startKey) ? t('agent.portal.startTrialSubmitting') : trial.notStarted ? t('agent.portal.startTrialNotStarted') : t('agent.portal.startTrialPending')}</h4>
          {trial.error && <p role="status" className="break-words text-ink-2">{trial.error}</p>}
          {trial.notStarted ? <>
            <label className="work-control-field">{t('agent.kanban.workspaceFieldLabel')}<input value={workspaceDraft} onChange={event => setWorkspaceDraft(event.target.value)} /></label>
            <WorkStartProfile profiles={codexProfiles} value={startProfile?.id} onChange={id => setProfileChoice({ key: profileChoiceKey, id })} />
            {codexProfiles.length ? <button type="button" disabled={actionBusy || !startProfile || !absoluteWorkspace(startWorkspace)}
              className="rounded-lg bg-primary px-4 py-2 text-white disabled:opacity-50" onClick={() => {
                if (startProfile) void runAction(() => beginWorkInvestigation(card, startWorkspace, startProfile.id));
              }}>{t('agent.kanban.startInvestigationBtn')}</button> : <button type="button" onClick={() => openAcpHub(null)} className="text-primary">{t('agent.portal.openExecutorSettings')}</button>}
          </> : <><p className="break-all text-xs text-ink-2">{trial.input.workspaceRoot}</p>
            {!isWorkStartPending(startKey) && <button type="button" disabled={actionBusy} className="text-primary"
              onClick={() => void runAction(() => beginWorkInvestigation(card, trial.input.workspaceRoot, trial.input.executionProfileId))}>{t('agent.portal.verifyAndRetry')}</button>}</>}
        </section> : activeTab === 'briefing' && requestedSessionId && !primarySession ? <p role="status" className="text-sm text-ink-2">{t('agent.portal.replySessionMissing')}</p>
        : nativePage && primarySession ? <NativeCodexWorkScene key={primarySession.id} card={card} session={primarySession} resultRequest={resultRequest} resultTurnId={showRequestedReply ? resultTurnId ?? '' : undefined} fillHeight onViewHistory={() => setPreviewSession(primarySession)} onViewResults={() => selectTab('evidence')}
          requirements={<details className="native-work-requirements"><summary>{t('agent.portal.workRequirementsSummary')}</summary><div className="mt-2 space-y-2 text-sm text-ink-2"><p className="whitespace-pre-wrap break-words">{card.state.goal || t('agent.portal.noSeparateGoalShort')}</p><button type="button" onClick={() => selectTab('settings')} className="text-xs text-primary hover:underline">{t('agent.portal.editWorkRequirements')}</button></div></details>} /> : activeTab === 'briefing' && (
          <>
            <section className="work-first-detail-overview space-y-6 text-sm leading-relaxed">
              {!preparedWork && <div className="work-first-detail-goal">
                <h4 className="font-semibold text-ink">{t('agent.portal.workGoalHeading')}</h4>
                <p className="mt-2 whitespace-pre-wrap break-words text-ink-2">{card.state.goal || t('agent.portal.noSeparateGoalFull')}</p>
              </div>}
              {pendingDecisions.length > 0 && <section aria-label={t('agent.portal.pendingDecisionsAria')} className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                <h4 className="font-semibold text-ink">{t('agent.portal.pendingDecisionsCount', { count: pendingDecisions.length })}</h4>
                <p className="mt-2 whitespace-pre-wrap break-words text-ink-2">{pendingDecisions[0].summary.length > 180 ? `${pendingDecisions[0].summary.slice(0, 180)}…` : pendingDecisions[0].summary}</p>
                <p className="mt-1 text-xs text-ink-3">{t('agent.portal.pendingDecisionsHint')}</p>
                <button type="button" onClick={() => showDecision(pendingDecisions[0].action.id)} className="mt-3 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover">{t('agent.portal.viewPendingDecisionBtn')}</button>
              </section>}
              {unconfirmedDecisions.length > 0 && <section aria-label={t('agent.portal.unconfirmedDecisionsAria')} className="rounded-xl border border-line p-4">
                <h4 className="font-semibold text-ink">{t('agent.portal.unconfirmedDecisionsCount', { count: unconfirmedDecisions.length })}</h4>
                <p className="mt-2 text-ink-2">{t('agent.portal.unconfirmedDecisionsHint')}</p>
                <button type="button" onClick={() => showDecision(unconfirmedDecisions[0].id)} className={`mt-3 rounded-lg px-4 py-2.5 text-sm font-medium ${pendingDecisions.length ? 'border border-line text-ink-2 hover:bg-fill-hover' : 'bg-primary text-white hover:bg-primary-hover'}`}>{t('agent.portal.checkOldRequestBtn')}</button>
              </section>}
              {primarySessionMeta?.provider !== 'codex' && (!preparedWork || latestEvidence) && (latestEvidence ? <div className="work-first-detail-progress rounded-xl border border-line bg-surface-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="font-semibold text-ink">{latestIsVerification ? t('agent.portal.recentVerificationHeading') : latestEvidence.kind === 'agent_report' ? t('agent.kanban.evidence.agentNote') : t('agent.portal.referenceRecordHeading')}</h4>
                  {latestIsVerification && <span className={`rounded px-1.5 py-0.5 text-xs ${latestEvidence.passed ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>{latestEvidence.passed ? t('agent.portal.passedLabel') : t('agent.portal.failedLabel')}</span>}
                </div>
                <p className="mt-1 break-words text-ink-2">{latestEvidence.title}</p>
                {latestEvidence.summary && <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">{latestEvidence.summary}</p>}
                <button type="button" onClick={() => selectTab('evidence')} className="mt-1 text-xs text-primary hover:underline">{t('agent.portal.viewEvidenceSource', { time: formatDateTime(latestEvidence.verifiedAt, undefined, locale) })}</button>
              </div> : primarySessionMeta?.preview ? <div className="work-first-detail-progress rounded-xl border border-line bg-surface-3 p-4">
                <h4 className="font-semibold text-ink">{t('agent.portal.sessionSummaryHeading')}</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">{primarySessionMeta.preview}</p>
                <p className="mt-1 text-xs text-ink-3">{t('agent.portal.sessionSummaryFrom', { label: primarySessionMeta.label })}</p>
              </div> : <div className="work-first-detail-progress rounded-xl border border-line bg-surface-3 p-4"><h4 className="font-semibold text-ink">{t('agent.portal.recentProgressHeading')}</h4><p className="mt-2 text-ink-3">{t('agent.portal.noVerifiableResultsBase')}{primarySession ? t('agent.portal.canViewOriginalConversation') : t('agent.portal.noSessionLinkedYet')}</p></div>)}
              {primarySessionMeta?.provider !== 'codex' && (card.state.waitReason || card.state.nextStep || !preparedWork && primarySession?.controlMode !== 'readonly') && <div className="work-first-detail-next">
                <h4 className="font-semibold text-ink">{card.state.waitReason ? t('agent.portal.currentBlockerHeading') : t('agent.portal.nextStepHeading')}</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">{card.state.waitReason || card.state.nextStep || t('agent.portal.defaultNextStepNote')}</p>
              </div>}
              {primarySession && primarySessionMeta?.provider === 'codex' ? <NativeCodexWorkScene key={primarySession.id} card={card} session={primarySession} resultRequest={resultRequest} resultTurnId={showRequestedReply ? resultTurnId ?? '' : undefined} onViewHistory={() => setPreviewSession(primarySession)} onViewResults={() => selectTab('evidence')} /> : primarySession ? <div className="work-first-detail-primary border-t border-line pt-4">
                <p className="work-first-detail-resume-note text-sm text-ink-2">{primarySession.controlMode === 'readonly' ? card.state.waitReason || card.state.nextStep ? t('agent.portal.readonlyWithReasonNote') : t('agent.portal.readonlyNote') : t('agent.portal.openExternalResumeNote', { label: primarySessionMeta?.label ?? t('agent.portal.executorFallback') })}</p>
                <button type="button" disabled={sessionBusyId === primarySession.id} onClick={() => void handleOpenOrResumeSession(primarySession)}
                  className={`mt-3 inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50 ${pendingDecisions.length || unconfirmedDecisions.length ? 'border border-line text-ink-2 hover:bg-fill-hover' : 'bg-primary text-white hover:bg-primary-hover'}`}>
                  {sessionBusyId === primarySession.id ? t('agent.portal.openingBtn') : primarySession.controlMode === 'readonly' ? t('agent.portal.viewConversationBtn') : t('agent.portal.continueWorkBtn')}<ArrowUpRight size={16} />
                </button>
              </div> : preparedWork ? <section aria-label={t('agent.portal.connectProjectSessionAria')} className="work-first-detail-primary order-first min-w-0 space-y-3">
                <p className="truncate text-sm text-ink-2" title={boundWorkspace}>{t('agent.portal.projectLine', { project: card.state.projectKey || boundWorkspace.split(/[\\/]/).filter(Boolean).at(-1) || boundWorkspace })}</p>
                {projectCandidates.length ? <>
                  {projectCandidates.length === 1 ? <p className="line-clamp-2 break-words text-base font-semibold text-ink" title={candidate?.title || candidate?.nativeSessionId}>{candidate?.title || candidate?.nativeSessionId}</p>
                    : <select aria-label={t('agent.portal.codexSessionsAria')} value={candidate?.id ?? ''} onChange={(event) => setCandidateId(event.target.value)} className="w-full rounded border border-line bg-surface-3 p-2 text-ink">
                      <option value="">{t('agent.portal.selectOriginalSessionOption')}</option>{projectCandidates.map((s) => <option key={s.id} value={s.id}>{s.title || s.nativeSessionId}</option>)}
                    </select>}
                  <button type="button" disabled={actionBusy || !candidate} onClick={() => void runAction(async () => {
                    if (!candidate || resolveButlerAccountScope() !== accountScope) return;
                    const current = useWorkLedger.getState().sessions.find((s) => s.id === candidate.id);
                    if (current !== candidate || current.todoId) throw new Error(t('agent.portal.errorSessionUpdated'));
                    if (!await bindWorkSessionToCard(candidate.id, card.id)) throw new Error(t('agent.portal.errorSessionUnavailable'));
                  })} className="rounded-lg bg-primary px-4 py-2 text-white hover:bg-primary-hover disabled:opacity-50">{t('agent.portal.continueThisCodexBtn')}</button>
                  <p className="text-xs text-ink-2">{t('agent.portal.nextStepVerifyStopped')}</p>
                </> : loadingAgents ? <p role="status" className="text-ink-2">{t('agent.portal.searchingLocalExecutors')}</p>
                : !codexProfiles.length ? <><p className="text-ink-2">{t('agent.portal.connectLocalCodexFirst')}</p>
                  <button type="button" onClick={() => openAcpHub(null)} className="rounded-lg border border-line px-3 py-2 text-primary">{t('agent.portal.openExecutorSettings')}</button>
                </> : <>{isTauriRuntime() && <>
                  <WorkStartProfile profiles={codexProfiles} value={startProfile?.id} onChange={id => setProfileChoice({ key: profileChoiceKey, id })} />
                  <button type="button" disabled={actionBusy || !startProfile || !card.state.goal?.trim()} onClick={() => {
                    if (startProfile) void runAction(() => beginWorkInvestigation(card, boundWorkspace, startProfile.id));
                  }} className="rounded-lg bg-primary px-4 py-2 text-white hover:bg-primary-hover disabled:opacity-50">{t('agent.kanban.startInvestigationBtn')}</button>
                </>}
                  <p className="text-xs text-ink-2">{t('agent.portal.stopOriginalThenRefresh')}</p>
                  <button type="button" disabled={actionBusy} onClick={() => void runAction(() => syncLiveSessionsIntoLedger({ limit: 300 }))} className="text-sm text-primary disabled:opacity-50">{actionBusy ? t('agent.portal.searchingBtn') : t('agent.portal.refreshProjectSessionsBtn')}</button>
                </>}
                <details className="text-sm text-ink-2"><summary className="cursor-pointer text-xs text-ink-3">{t('agent.portal.workRequirementsAndSettings')}</summary>
                  <p className="mt-2 whitespace-pre-wrap break-words">{card.state.goal || card.title}</p>
                  <button type="button" onClick={() => selectTab('settings')} className="mt-2 text-primary hover:underline">{t('agent.portal.configureExecutionMethod')}</button>
                </details>
              </section> : pendingDecisions.length || unconfirmedDecisions.length ? null : <div className="work-first-detail-primary border-t border-line pt-4"><p className="text-ink-2">{t('agent.portal.noExecutorConnectedYet')}</p><button type="button" onClick={() => selectTab('sessions')} className="mt-3 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover">{t('agent.portal.linkExistingConversationBtn')}</button><button type="button" onClick={() => selectTab('settings')} className="ml-3 mt-3 text-sm text-ink-3 hover:text-primary">{t('agent.portal.configureExecutionMethod')}</button></div>}
              <div className="work-first-detail-secondary flex flex-wrap gap-5 border-t border-line pt-4 text-sm">
                <button type="button" onClick={() => selectTab('report')} className="text-ink-3 hover:text-primary">{t('agent.portal.viewWorkReportBtn')}</button>
                <button type="button" onClick={() => selectTab('settings')} className="text-ink-3 hover:text-primary">{t('agent.portal.editWorkRequirements')}</button>
              </div>
            </section>
          </>
        )}
        {activeTab === 'settings' && (
          <>
            <section className="space-y-2 rounded-md border border-line bg-surface-3 p-3">
              <h4 className="font-medium text-ink-2">{t('agent.portal.acceptanceHeading')}</h4>
              {card.state.acceptance.length ? <ul className="list-disc space-y-1 pl-4 text-sm leading-relaxed text-ink-2">{card.state.acceptance.map((item, index) => <li key={`${index}-${item}`} className="break-words">{item}</li>)}</ul>
                : <p className="text-ink-3">{t('agent.portal.acceptanceNotSet')}</p>}
            </section>

            {cardSessions.length === 0 && <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-primary">{t('agent.portal.startExecutionSummary')}</summary>
              <div className="mt-3 space-y-2">
                {!isFollowed && <p className="text-ink-3">{t('agent.portal.enrollBeforeExecuteHint')}</p>}
                <label className="block text-ink-3">{t('agent.portal.executionDirLabel')}
                  <input aria-label={t('agent.portal.executionDirAria')} value={workspaceDraft} onChange={(e) => setWorkspaceDraft(e.target.value)} placeholder={t('agent.portal.executionDirPlaceholder')} className="mt-1 w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
                </label>
                <input value={workerInstruction} onChange={(e) => setWorkerInstruction(e.target.value)} placeholder={t('agent.portal.workerInstructionPlaceholder')} className="w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
                <div className="flex flex-wrap gap-2">
                  <button disabled={spawning || !isFollowed} onClick={() => void handleSpawnWorker(true)} className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-white hover:bg-primary-hover disabled:opacity-50"><FolderGit2 size={12} />{t('agent.portal.spawnWorktreeBtn')}</button>
                  <button disabled={spawning || !isFollowed} onClick={() => void handleSpawnWorker(false)} className="rounded bg-fill-2 px-2.5 py-1 text-ink-2 hover:bg-fill-hover disabled:opacity-50">{t('agent.portal.spawnCurrentDirBtn')}</button>
                </div>
                {acpAgents.length > 0 ? <div className="flex gap-2">
                  <select aria-label={t('agent.portal.executorClientAria')} value={selectedAcpId} onChange={(e) => setSelectedAcpId(e.target.value)} className="min-w-0 flex-1 rounded border border-line bg-surface-4 px-2 py-1 text-ink">
                    {acpAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} ({agent.preset})</option>)}
                  </select>
                  <button type="button" disabled={spawning || !selectedAcpId || !isFollowed} onClick={() => void handleSpawnWorker(false, null, 'acp')} className="rounded bg-primary/10 px-2 py-1 text-primary disabled:opacity-50">{t('agent.portal.dispatchAcpClientBtn')}</button>
                </div> : <button type="button" onClick={() => openAcpHub()} className="text-ink-3 hover:text-primary">{t('agent.portal.configureLocalAcpLink')}</button>}
              </div>
            </details>}

            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">{t('agent.portal.editGoalAndNextStepSummary')}</summary>
              <div className="mt-3 space-y-2">
                <div className="font-medium text-ink-2">{t('agent.portal.workGoalHeading')}</div>
                <textarea rows={3} value={goalDraft} onChange={(e) => { briefingEdit.current = { ...briefingEdit.current, dirty: true }; setGoalDraft(e.target.value); }} placeholder={t('agent.portal.goalPlaceholder')} className="w-full rounded border border-line bg-surface-4 p-2 text-sm text-ink" />
                <div className="font-medium text-ink-2">{t('agent.portal.nextStepHeading')}</div>
                {briefingEdit.current.dirty && briefingEdit.current.version !== (card.state.requirementsVersion ?? 0) && <div className="space-y-1 rounded border border-warning/30 p-2 text-warning">
                  <div>{t('agent.portal.goalConflictUpdated', { version: card.state.requirementsVersion ?? 0, goal: card.state.goal ?? '' })}</div>
                  <div>{t('agent.portal.goalConflictHint')}</div>
                  <button type="button" className="text-primary hover:underline" onClick={() => { briefingEdit.current = { ...briefingEdit.current, version: card.state.requirementsVersion ?? 0 }; setActionError(null); }}>{t('agent.portal.continueEditingOnCurrent')}</button>
                </div>}
                <input value={nextStepDraft} onChange={(e) => { briefingEdit.current = { ...briefingEdit.current, dirty: true }; setNextStepDraft(e.target.value); }} placeholder={t('agent.portal.nextStepPlaceholder')} className="w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
                <div className="flex justify-end"><button onClick={() => void runAction(handleSaveBriefing)} className="rounded bg-primary px-2.5 py-1 text-white hover:bg-primary-hover">{t('agent.portal.saveBriefingBtn')}</button></div>
              </div>
            </details>

            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">{t('agent.portal.manageFollowAndStageSummary')}</summary>
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-1">{STAGE_ITEMS.map((stage) => <button key={stage.key} disabled={actionBusy || card.state.stage === stage.key} onClick={() => void runAction(() => handleMoveStage(stage.key))} className={`rounded px-2 py-1 ${card.state.stage === stage.key ? 'bg-primary text-white' : 'bg-fill-2 text-ink-2 hover:bg-fill-hover'}`}>{t(stage.labelKey)}</button>)}</div>
                {isFollowed && <button type="button" disabled={actionBusy} onClick={() => void runAction(() => card.state.waitState === 'paused' ? resumeCardAutomation(card.id) : pauseCardAutomation(card.id))} className="inline-flex items-center gap-1 text-primary disabled:opacity-50">
                  {card.state.waitState === 'paused' ? <><PlayCircle size={12} />{t('agent.portal.resumeAutoFollow')}</> : <><PauseCircle size={12} />{t('agent.portal.pauseAutoFollow')}</>}
                </button>}
                {canStopExecution && <div className="space-y-2 text-ink-3"><p>{t('agent.portal.activeTurnHint')}</p><button type="button" disabled={actionBusy} className="text-warning hover:underline disabled:opacity-50" onClick={() => void runAction(async () => { await pauseCardAcpWorkflow(card.id, t('agent.portal.userTookOverReason')); toast.success(t('agent.portal.handoffPausedToast')); })}>{t('agent.portal.takeOverAndStopBtn')}</button></div>}
            <WorkMethodReuse workId={card.id} projectKey={card.state.projectKey} workspaceRoot={primaryWorkspaceRoot} onSelectWork={onSelectWork} />
            {/* 分级自主与轮次预算 */}
            <div className="rounded-md border border-line bg-surface-3 p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink-2">{t('agent.portal.autonomyAndBudgetHeading')}</span>
                <select
                  value={card.state.autonomyMode}
                  onChange={(e) =>
                    void updateCard(card.id, {
                      autonomyMode: e.target.value as WorkCardAutonomyMode,
                    }).then(() => toast.success(t('agent.portal.toastUpdatedAutonomy')))
                  }
                  className="rounded border border-line bg-surface-4 px-2 py-0.5 text-xs text-ink"
                >
                  <option value="readonly">{t('agent.portal.autonomyReadonlyOption')}</option>
                  <option value="confirm">{t('agent.portal.autonomyConfirmOption')}</option>
                  <option value="autonomous">{t('agent.portal.autonomyAutonomousOption')}</option>
                </select>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-ink-3">
                <span>
                  {t('agent.portal.autoTurnsUsed', { used: card.state.autoTurnsUsed, max: card.state.maxAutoTurns })}
                </span>
                {card.state.autoTurnsUsed > 0 && (
                  <button
                    onClick={() =>
                      void updateCard(card.id, {
                        autoTurnsUsed: 0,
                        consecutiveFailures: 0,
                      }).then(() => toast.success(t('agent.portal.toastResetBudget')))
                    }
                    className="text-primary hover:underline"
                  >
                    {t('agent.portal.resetQuotaBtn')}
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
              <label className="mt-2 block text-ink-3">{t('agent.portal.maxAutoTurnsLabel')}
                <input aria-label={t('agent.portal.maxAutoTurnsLabel')} type="number" min={1} max={20} value={card.state.maxAutoTurns}
                  onChange={(e) => { const count = Number(e.target.value); if (Number.isInteger(count) && count >= 1 && count <= 20) void runAction(() => updateCard(card.id, { maxAutoTurns: count })); }}
                  className="ml-2 w-16 rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
              </label>
              <label className="mt-2 block text-ink-3">{t('agent.portal.deadlineLabel')}
                <input aria-label={t('agent.portal.deadlineLabel')} type="datetime-local"
                  value={card.state.deadlineAt ? new Date(card.state.deadlineAt - new Date(card.state.deadlineAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''}
                  onChange={(e) => void runAction(() => updateCard(card.id, { deadlineAt: e.target.value ? new Date(e.target.value).getTime() : null }))}
                  className="mt-1 block w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
              </label>
              <p className="mt-2 text-ink-3">{t('agent.portal.budgetHint')}</p>
            </div>
              </div>
            </details>

            {/* 验收清单 */}
            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">{t('agent.portal.editAcceptanceSummary')}</summary>
              <div className="mt-3 space-y-2">
              <div className="font-medium text-ink-2">
                {t('agent.portal.acceptanceEditTitle')}
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
                      {t('agent.portal.removeBtn')}
                    </button>
                  </div>
                ))}
                {card.state.acceptance.length === 0 && (
                  <div className="text-ink-3">{t('agent.portal.noExplicitAcceptance')}</div>
                )}
              </div>
              <div className="flex gap-1.5">
                <input
                  value={newAcceptance}
                  onChange={(e) => setNewAcceptance(e.target.value)}
                  placeholder={t('agent.portal.newAcceptancePlaceholder')}
                  className="flex-1 rounded border border-line bg-surface-4 px-2 py-1 text-xs text-ink"
                />
                <button
                  onClick={() => void runAction(handleAddAcceptance)}
                  className="inline-flex items-center gap-0.5 rounded bg-fill-2 px-2 py-1 text-ink-2 hover:bg-fill-hover"
                >
                  <Plus size={12} /> {t('common.add')}
                </button>
              </div>
              {(card.state.requirementsVersion ?? 0) === 0 && <button type="button"
                disabled={actionBusy || !goalDraft.trim() || !card.state.acceptance.length}
                onClick={() => void runAction(() => handleSaveBriefing(true))}
                className="rounded bg-primary px-2 py-1 text-white disabled:opacity-50">{t('agent.portal.enrollButlerBtn')}</button>}
            </div>
            </details>

            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">{t('agent.portal.waitAndRecheckSummary')}</summary>
              <div className="mt-3 space-y-2">
              <div className="text-ink-3">{t('agent.portal.currentWaitLine', { label: t(WAIT_STATE_LABELS[card.state.waitState] ?? 'agent.portal.waitState.unknown'), reasonSuffix: card.state.waitReason ? ` · ${card.state.waitReason}` : '' })}</div>
              <input aria-label={t('agent.portal.waitReasonAria')} value={waitReasonDraft} onChange={(e) => setWaitReasonDraft(e.target.value)} placeholder={t('agent.portal.waitReasonPlaceholder')} className="w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={actionBusy || !waitReasonDraft.trim()} onClick={() => void runAction(() => updateCard(card.id, { waitState: 'waiting_input', waitReason: waitReasonDraft.trim() }))}>{t('agent.portal.markWaitingInputBtn')}</button>
                <button type="button" disabled={actionBusy || !waitReasonDraft.trim()} onClick={() => void runAction(() => updateCard(card.id, { waitState: 'waiting_external', waitReason: waitReasonDraft.trim() }))}>{t('agent.portal.markWaitingExternalBtn')}</button>
                <button type="button" disabled={actionBusy || card.state.waitState === 'none'} onClick={() => void runAction(() => updateCard(card.id, { waitState: 'none', waitReason: null }))}>{t('agent.portal.clearWaitBtn')}</button>
                <button type="button" disabled={actionBusy || card.state.waitState === 'canceled'} onClick={() => void runAction(() => updateCard(card.id, { waitState: 'canceled', waitReason: t('agent.portal.userCanceledFollowReason'), nextCheckAt: null }))}>{t('agent.portal.cancelFollowBtn')}</button>
              </div>
              <label className="block text-ink-3">{t('agent.portal.nextCheckLabel')}
                <input aria-label={t('agent.portal.nextCheckLabel')} type="datetime-local" value={card.state.nextCheckAt ? new Date(card.state.nextCheckAt - new Date(card.state.nextCheckAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''}
                  onChange={(e) => void runAction(() => updateCard(card.id, { nextCheckAt: e.target.value ? new Date(e.target.value).getTime() : null }))}
                  className="mt-1 block w-full rounded border border-line bg-surface-4 px-2 py-1 text-ink" />
              </label>
            </div>
            </details>

            {/* 实时 Git 工作区 / Worktree 状态 */}
            <details className="rounded-md border border-line bg-surface-3 p-3">
              <summary className="cursor-pointer font-medium text-ink-2">{t('agent.portal.gitSnapshotSummary')}</summary>
              <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1 font-medium text-ink-2">
                  <FileCode2 size={13} />
                  {t('agent.portal.gitSnapshotHeading')}
                </span>
                <button
                  onClick={() => void refreshGitSnapshot()}
                  className="inline-flex items-center gap-0.5 text-ink-3 hover:text-primary"
                >
                  <RefreshCw size={11} className={gitLoading ? 'animate-spin' : ''} />
                  {t('common.refresh')}
                </button>
              </div>

              {gitLoading ? <div role="status" className="text-ink-3">{t('agent.portal.gitLoading')}</div> : gitError ? <div role="alert" className="text-warning">{t('agent.portal.gitReadError', { error: gitError })}</div> : gitSnapshot ? (
                <div className="space-y-1.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded px-1.5 py-0.5 font-medium ${
                        gitSnapshot.isWorktree
                          ? 'bg-success/15 text-success'
                          : 'bg-fill-2 text-ink-2'
                      }`}
                    >
                      {gitSnapshot.isWorktree ? t('agent.portal.gitWorktreeBadge') : t('agent.portal.gitMainWorkspaceBadge')}
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
                    {t('agent.portal.gitPathLine', { path: gitSnapshot.workspaceRoot })}
                  </div>
                  {gitSnapshot.diffStat && (
                    <pre className="max-h-24 overflow-auto rounded bg-surface-4 p-2 font-mono text-xs text-ink-2">
                      {gitSnapshot.diffStat}
                    </pre>
                  )}
                  <div className="text-ink-3">
                    {t('agent.portal.gitDirtyCount', { count: gitSnapshot.dirtyFiles.length })}
                  </div>
                </div>
              ) : (
                <div className="text-ink-3">
                  {t('agent.portal.gitEmptyHint')}
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
                        {t('agent.portal.sessionDirLine', { dir: session.workspaceRoot || t('agent.portal.unknownDir') })}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${badge.className}`}>
                      {t(badge.labelKey)}
                    </span>
                  </div>

                  <div className="text-xs text-ink-3">{t('agent.portal.sessionStatusLine', { status: t(SESSION_STATUS_LABELS[session.runtimeStatus] ?? 'agent.portal.sessionStatus.unknown'), reasonSuffix: session.controlReason ? ` · ${session.controlReason}` : '' })}</div>

                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleOpenOrResumeSession(session)}
                      className="inline-flex items-center gap-1 rounded bg-primary/15 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
                    >
                      <PlayCircle size={11} />
                      {session.controlMode === 'readonly' ? t('agent.portal.viewConversationBtn') : t('agent.portal.openSessionBtn')}
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleUnbindSessionFromCard(session.id)}
                      className="inline-flex items-center gap-1 rounded bg-fill-2 px-2 py-1 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink disabled:opacity-50"
                    >
                      <X size={11} />
                      {t('agent.portal.unbindSessionBtn')}
                    </button>

                    {session.controlMode === 'readonly' && <details className="w-full">
                      <summary className="cursor-pointer text-ink-3">{t('agent.portal.createIndependentSessionSummary')}</summary>
                      <p className="my-2 text-xs text-ink-3">{t('agent.portal.createIndependentSessionHint')}</p>
                      <button
                        disabled={spawning}
                        onClick={() => void handleSpawnWorker(true, session.id)}
                        className="inline-flex items-center gap-1 rounded bg-primary/15 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/25"
                      >
                        <CopyPlus size={11} />
                        {t('agent.portal.createIndependentSessionBtn')}
                      </button>
                    </details>}
                  </div>
                </div>
              );
            })}

            {cardSessions.length === 0 && (
              <div className="rounded-md border border-dashed border-line p-5 text-center text-ink-3">
                {t('agent.portal.noSessionsLinked')}
              </div>
            )}

            <details open={cardSessions.length === 0 || undefined} className="space-y-2 border-t border-line pt-3">
              <summary className="cursor-pointer text-xs font-medium text-ink-2"><History size={12} className="mr-1 inline" />{t('agent.portal.linkOtherSessionsSummary')}</summary>
              <input aria-label={t('agent.portal.searchLinkableSessionsAria')} value={sessionSearch} onChange={(e) => setSessionSearch(e.target.value)} placeholder={t('agent.portal.searchLinkableSessionsPlaceholder')} className="w-full rounded border border-line bg-surface-4 px-2 py-1.5 text-ink" />
              <div className="text-ink-3">{t('agent.portal.matchingSessionsCount', { count: unboundLocalSessions.length })}</div>
              {unboundLocalSessions.length === 0 ? (
                <div className="rounded-md border border-dashed border-line p-3 text-center text-xs text-ink-3">
                  {sessionSearch.trim() ? t('agent.portal.noMatchingSessions') : t('agent.portal.noUnboundLocalSessions')}
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
                            {s.workspaceRoot || t('agent.portal.unknownDir')}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleBindSessionToThisCard(s.id)}
                          className="shrink-0 rounded bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                        >
                          {t('agent.portal.bindToCardBtn')}
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
            <p className="text-sm leading-relaxed text-ink-3">{t('agent.portal.evidenceTabDesc')}</p>
            {cardEvidences.length === 0 && <div className="rounded-xl border border-dashed border-line p-6 text-sm text-ink-3">{t('agent.portal.evidenceEmpty')}</div>}
            <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-sm text-ink-3">{t('agent.portal.acceptanceManagementSummary')}</summary>
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
                {t('agent.portal.completionGateTitle')}
              </div>
              <div className="mt-1 text-xs">{completionGate.reason}</div>
              <div className="mt-2 text-ink-2">{t('agent.portal.manualAcceptHint')}</div>
              <fieldset className="mt-2 space-y-1" disabled={actionBusy || card.state.stage === 'done'}>
                <legend className="font-medium">{t('agent.portal.manualAcceptLegend')}</legend>
                {card.state.acceptance.map((criterion) => <label key={criterion} className="flex items-start gap-2 text-ink">
                  <input type="checkbox" aria-label={t('agent.portal.acceptCriterionAria', { criterion })} checked={acceptedCriteria.includes(criterion)}
                    onChange={(e) => setAcceptedCriteria((current) => e.target.checked ? [...current, criterion] : current.filter((item) => item !== criterion))} />
                  {criterion}
                </label>)}
              </fieldset>
              {card.state.stage !== 'done' && <button type="button"
                disabled={actionBusy || !card.state.acceptance.length || card.state.waitState !== 'none' || !card.state.acceptance.every((criterion) => acceptedCriteria.includes(criterion) || completionGate.validEvidences.some((e) => e.criterionIds?.includes(criterion))) || !acceptedCriteria.length}
                onClick={() => void runAction(handleAccept)}
                className="mt-2 inline-flex items-center gap-1 rounded bg-surface-4 px-2.5 py-1 text-ink disabled:opacity-50">
                <CheckCircle2 size={12} />{t('agent.portal.acceptSelectedAndDoneBtn')}
              </button>}
              <button type="button" disabled={actionBusy || (card.state.requirementsVersion ?? 0) === 0}
                onClick={() => void runAction(async () => { await updateCard(card.id, { rework: true, stage: 'in_progress', waitState: 'none', waitReason: null, expectedRequirementsVersion: card.state.requirementsVersion ?? 0, expectedContentVersion: card.state.contentVersion ?? 0 }); toast.success(t('agent.portal.reworkSuccessToast')); })}
                className="mt-2 block text-primary hover:underline disabled:opacity-50">{t('agent.portal.reworkBtn')}</button>
            </div>

            <div className="space-y-2 rounded-md border border-line bg-surface-3 p-3">
              <div className="font-medium text-ink-2">{t('agent.portal.recordNewEvidenceTitle')}</div>
              <div className="flex gap-1.5">
                <select
                  value={evidenceKind}
                  onChange={(e) => setEvidenceKind(e.target.value as WorkEvidenceKind)}
                  className="rounded border border-line bg-surface-4 px-2 py-1 text-xs text-ink"
                >
                  <option value="test_run">{t('agent.portal.evidenceKind.test_run')}</option>
                  <option value="ci_build">{t('agent.portal.evidenceKind.ci_build')}</option>
                  <option value="pr_status">{t('agent.portal.evidenceKind.pr_status')}</option>
                  <option value="diff_check">{t('agent.portal.evidenceKind.diff_check')}</option>
                  <option value="manual_note">{t('agent.portal.evidenceKind.manual_note')}</option>
                </select>
                <input
                  value={evidenceTitle}
                  onChange={(e) => setEvidenceTitle(e.target.value)}
                  aria-label={t('agent.portal.evidenceTitleAria')}
                  placeholder={t('agent.portal.evidenceTitlePlaceholder')}
                  className="min-w-0 flex-1 rounded border border-line bg-surface-4 px-2 py-1 text-xs text-ink"
                />
              </div>
              <textarea aria-label={t('agent.portal.evidenceSourceAria')} value={evidenceSource} onChange={(e) => setEvidenceSource(e.target.value)} rows={3}
                placeholder={t('agent.portal.evidenceSourcePlaceholder')}
                className="w-full rounded border border-line bg-surface-4 p-2 text-ink" />
              <fieldset className="space-y-1">
                <legend className="text-ink-2">{t('agent.portal.coveredCriteriaLegend')}</legend>
                {card.state.acceptance.map((criterion) => <label key={criterion} className="flex items-start gap-2 text-ink">
                  <input type="checkbox" aria-label={t('agent.portal.coverCriterionAria', { criterion })} checked={evidenceCriteria.includes(criterion)}
                    onChange={(e) => setEvidenceCriteria((current) => e.target.checked ? [...current, criterion] : current.filter((item) => item !== criterion))} />
                  {criterion}
                </label>)}
              </fieldset>
              <label className="flex items-center gap-2 text-ink"><input type="checkbox" checked={evidencePassed} onChange={(e) => setEvidencePassed(e.target.checked)} />{t('agent.portal.checkedPassedCheckbox')}</label>
              <div className="flex justify-end">
                <button
                  disabled={actionBusy || !evidenceTitle.trim() || !evidenceSource.trim() || !evidenceCriteria.length}
                  onClick={() => void runAction(handleRecordEvidence)}
                  className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  <Plus size={12} /> {t('agent.portal.recordEvidenceBtn')}
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
                      {t('agent.portal.evidenceTypeAndVersion', {
                        kind: ev.kind,
                        reqVer: ev.requirementsVersion ?? '?',
                        contentVer: ev.contentVersion ?? '?',
                      })}
                      {ev.headSha ? ` · SHA @${ev.headSha.slice(0, 7)}` : ''}
                    </div>
                    {ev.summary && <div className="mt-1 whitespace-pre-wrap text-ink-3">{ev.summary}</div>}
                    {!!ev.criterionIds?.length && <div className="mt-1 text-ink-3">{t('agent.portal.evidenceCriteriaLine', { criteria: ev.criterionIds.join(t('agent.common.listSep')) })}</div>}
                    {ev.acceptedBy && <div className="mt-1 text-ink-3">{t('agent.portal.evidenceAcceptedByLine', { actor: ev.acceptedBy })}</div>}
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
                    {ev.stale ? t('agent.portal.evidenceBadgeStale', { reason: ev.staleReason ?? '' }) : ev.kind === 'manual_note' || ev.kind === 'agent_report' ? t('agent.portal.evidenceBadgeReference') : ev.passed ? t('agent.portal.passedLabel') : t('agent.portal.failedLabel')}
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
                    {isExternal ? t('agent.portal.timelineKindExternal') : t('agent.portal.timelineKindDispatch')} · {act.actionKind}
                  </span>
                  <span className="rounded bg-fill-2 px-1.5 py-0.5 text-xs text-ink-2">
                    {act.state}
                  </span>
                </div>
                {decision && <p className="whitespace-pre-wrap break-words text-sm text-ink">{decision.summary}</p>}
                {act.state === 'awaiting_approval' && !decision && <p className="text-sm text-warning">{t('agent.portal.timelineStaleRequest')}</p>}
                {act.receiptRef && (
                  <div className="text-xs text-success">{t('agent.portal.timelineReceiptLine', { receipt: act.receiptRef })}</div>
                )}
                {act.errorMessage && (
                  <div className="text-xs text-danger">{t('agent.portal.timelineErrorLine', { error: act.errorMessage })}</div>
                )}
                {external && <details className="text-xs text-ink-3">
                  <summary className="cursor-pointer">{t('agent.portal.timelineSnapshotSummary', { version: external.requirementsVersion })}</summary>
                  <div className="mt-1">{t('agent.portal.timelineActorLine', { userId: external.actor.userId, server: external.actor.server })}</div>
                  {external.kind === 'ado_state_write'
                    ? <div>{t('agent.portal.timelineAdoStateLine', { id: external.workItemId, rev: external.expectedRevision, expected: external.expectedState, target: external.targetState })}</div>
                    : external.kind === 'ado_comment'
                      ? <><div>{t('agent.portal.timelineAdoCommentLine', { id: external.workItemId })}</div><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{external.commentText}</pre></>
                      : <><div>{t('agent.portal.timelineTargetRoomLine', { rid: external.rid })}</div><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{external.parts.map((part) => part.text).join('\n\n')}</pre></>}
                </details>}
                {isExternal && ['dispatched', 'verifying_delivery'].includes(act.state) && <button type="button" disabled={actionBusy}
                  onClick={() => void runAction(() => executePreparedExternalAction(act.id))}
                  className="text-primary hover:underline disabled:opacity-50">{t('agent.portal.verifyDeliveryResultBtn')}</button>}
                {act.state === 'awaiting_approval' && (
                  <div className="flex items-center gap-1.5 pt-1">
                    <button
                      disabled={actionBusy || !decision || (isExternal && !external)}
                      onClick={() => void runAction(async () => {
                        if (isExternal) {
                          await executePreparedExternalAction(act.id, true);
                        } else {
                          await transitionDispatchAction({ id: act.id, state: 'prepared', expectedState: 'awaiting_approval' });
                          toast.success(t('agent.portal.toastApprovedQueued'));
                        }
                      })}
                      className="rounded bg-primary px-2 py-0.5 text-xs text-white hover:bg-primary-hover"
                    >
                      {t('agent.portal.approveAndExecuteBtn')}
                    </button>
                    <button
                      disabled={actionBusy}
                      onClick={() => void runAction(() => transitionDispatchAction({
                          id: act.id,
                          state: 'canceled',
                          expectedState: 'awaiting_approval',
                          errorMessage: t('agent.portal.portalCancelReason'),
                        }))}
                      className="rounded bg-fill-2 px-2 py-0.5 text-xs text-ink-3 hover:bg-fill-hover"
                    >
                      {t('common.cancel')}
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
                  {t('agent.portal.eventResourceLine', { key: ev.resourceKey, version: ev.resourceVersion })}
                </div>
                {ev.statusDetail && (
                  <div className="text-xs text-ink-3">{ev.statusDetail}</div>
                )}
              </div>
            ))}

            {cardActions.length === 0 && cardEvents.length === 0 && (
              <div className="rounded-md border border-dashed border-line p-6 text-center text-ink-3">
                {t('agent.portal.timelineEmpty')}
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
      {terminalOpen && primaryWorkspaceRoot ? (
        <ButlerTerminalDrawer
          workspaceRoot={primaryWorkspaceRoot}
          open={terminalOpen}
          onClose={() => setTerminalOpen(false)}
        />
      ) : null}
      {diffOpen && primaryWorkspaceRoot ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30">
          <WorkDiffDrawer
            workspaceRoot={primaryWorkspaceRoot}
            open={diffOpen}
            onClose={() => setDiffOpen(false)}
            onWorkspaceChanged={() => void refreshGitSnapshot()}
          />
        </div>
      ) : null}
      {previewSession && <WorkSessionHistoryPreview key={previewSession.id} session={previewSession} onClose={() => setPreviewSession(null)} />}
    </aside>
  );
}
