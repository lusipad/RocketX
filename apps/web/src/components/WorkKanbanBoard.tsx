import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  History,
  Inbox,
  PanelLeft,
  Plus,
  Search,
  Bot,
  X,
} from 'lucide-react';
import {
  openOrResumeWorkSession,
  parseWorkSessionProviderMeta,
  syncLiveSessionsIntoLedger,
} from '../agent/superAgentBridge';
import type {
  WorkCardAutonomyMode,
  WorkCardStage,
  WorkCardWaitState,
  WorkSessionControlMode,
  NativeWorkCard,
  NativeWorkSessionRecord,
} from '../platform/desktopCommands';
import { toast, useToast } from '../stores/toast';
import { useUI } from '../stores/ui';
import { useWorkLedger } from '../stores/workLedger';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { newWorkDraftKey, useNewWorkDraft, useNewWorkDrafts } from '../stores/newWorkDrafts';
import { absoluteWorkspace, beginWorkInvestigation, chooseStartProfile, eligibleCodexProfiles, isWorkStartPending, useNativeWorkStarts, workStartKey } from '../stores/nativeWorkStarts';
import { useAcpAgents } from '../stores/acpAgents';
import WorkStartProfile from './WorkStartProfile';
import type { NativeWorkDecision, NativeWorkSnapshot } from '../platform/nativeWorkRuntime';
import { isTauriRuntime } from '../lib/http';
import { workContextPathKey } from '../lib/workContext';
import { openDesktopDialog } from '../platform/desktopDialog';
import { listenDesktopEvent } from '../platform/desktopEvents';
import { captureButlerAccountGeneration, captureButlerRuntimeAccountContext, subscribeButlerAccountSelection } from '../platform/butlerAccountReady';
import WorkCardPortal from './WorkCardPortal';
import WorkContextSearch from './WorkContextSearch';
import WorkSessionImport from './WorkSessionImport';
import WorkSessionHistoryPreview from './WorkSessionHistoryPreview';
import NativeWorkCardControls, { canAnswerWorkDecision } from './NativeWorkCardControls';
import { findWorkResultReply, pendingInvestigation, unresolvedWorkDelivery } from '../lib/nativeWorkResult';
import { t as rawT, useI18n, type MessageKey, type ResolvedLocale } from '../i18n';
import { compareLocaleText, formatDate, formatDateTime } from '../i18n/format';

export const WORK_KANBAN_STAGES: {
  key: WorkCardStage;
  labelKey: MessageKey;
  taglineKey: MessageKey;
  readonly label: string;
  readonly tagline: string;
  accent: string;
  dotClass: string;
  borderAccent: string;
  badgeBg: string;
}[] = [
  {
    key: 'triage',
    labelKey: 'agent.kanban.stage.triage',
    taglineKey: 'agent.kanban.stage.triageTagline',
    get label() { return rawT(this.labelKey); },
    get tagline() { return rawT(this.taglineKey); },
    accent: 'text-purple-700 dark:text-purple-300',
    dotClass: 'bg-purple-500',
    borderAccent: 'border-purple-500/30',
    badgeBg: 'bg-purple-500/12 text-purple-700 dark:text-purple-300',
  },
  {
    key: 'ready',
    labelKey: 'agent.kanban.stage.ready',
    taglineKey: 'agent.kanban.stage.readyTagline',
    get label() { return rawT(this.labelKey); },
    get tagline() { return rawT(this.taglineKey); },
    accent: 'text-blue-700 dark:text-blue-300',
    dotClass: 'bg-blue-500',
    borderAccent: 'border-blue-500/30',
    badgeBg: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
  },
  {
    key: 'in_progress',
    labelKey: 'agent.kanban.stage.in_progress',
    taglineKey: 'agent.kanban.stage.in_progressTagline',
    get label() { return rawT(this.labelKey); },
    get tagline() { return rawT(this.taglineKey); },
    accent: 'text-amber-700 dark:text-amber-300',
    dotClass: 'bg-amber-500',
    borderAccent: 'border-amber-500/30',
    badgeBg: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
  },
  {
    key: 'verifying',
    labelKey: 'agent.kanban.stage.verifying',
    taglineKey: 'agent.kanban.stage.verifyingTagline',
    get label() { return rawT(this.labelKey); },
    get tagline() { return rawT(this.taglineKey); },
    accent: 'text-cyan-700 dark:text-cyan-300',
    dotClass: 'bg-cyan-500',
    borderAccent: 'border-cyan-500/30',
    badgeBg: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300',
  },
  {
    key: 'done',
    labelKey: 'agent.kanban.stage.done',
    taglineKey: 'agent.kanban.stage.doneTagline',
    get label() { return rawT(this.labelKey); },
    get tagline() { return rawT(this.taglineKey); },
    accent: 'text-emerald-700 dark:text-emerald-300',
    dotClass: 'bg-emerald-500',
    borderAccent: 'border-emerald-500/30',
    badgeBg: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  },
];

export const WAIT_STATE_LABELS: Record<
  WorkCardWaitState,
  { labelKey: MessageKey; readonly label: string; badgeClass: string }
> = {
  none: { labelKey: 'agent.kanban.wait.none', get label() { return rawT(this.labelKey); }, badgeClass: 'bg-fill-2 text-ink-3' },
  waiting_input: { labelKey: 'agent.kanban.wait.waiting_input', get label() { return rawT(this.labelKey); }, badgeClass: 'bg-warning/15 text-warning font-medium' },
  waiting_approval: {
    labelKey: 'agent.kanban.wait.waiting_approval',
    get label() { return rawT(this.labelKey); },
    badgeClass: 'bg-warning/15 text-warning font-medium',
  },
  waiting_external: {
    labelKey: 'agent.kanban.wait.waiting_external',
    get label() { return rawT(this.labelKey); },
    badgeClass: 'bg-primary/15 text-primary font-medium',
  },
  blocked: { labelKey: 'agent.kanban.wait.blocked', get label() { return rawT(this.labelKey); }, badgeClass: 'bg-danger/15 text-danger font-medium' },
  paused: { labelKey: 'agent.kanban.wait.paused', get label() { return rawT(this.labelKey); }, badgeClass: 'bg-fill-3 text-ink-3 font-medium' },
  canceled: { labelKey: 'agent.kanban.wait.canceled', get label() { return rawT(this.labelKey); }, badgeClass: 'bg-fill-3 text-ink-4 line-through' },
};

export const AUTONOMY_MODE_LABELS: Record<WorkCardAutonomyMode, string> = {
  get readonly() { return rawT('agent.kanban.autonomy.readonly'); },
  get confirm() { return rawT('agent.kanban.autonomy.confirm'); },
  get autonomous() { return rawT('agent.kanban.autonomy.autonomous'); },
};

export const SESSION_CONTROL_BADGES: Record<
  WorkSessionControlMode,
  { labelKey: MessageKey; readonly label: string; className: string }
> = {
  controllable: {
    labelKey: 'agent.kanban.control.controllable',
    get label() { return rawT(this.labelKey); },
    className: 'bg-success/15 text-success border border-success/30',
  },
  resumable: {
    labelKey: 'agent.kanban.control.resumable',
    get label() { return rawT(this.labelKey); },
    className: 'bg-primary/15 text-primary border border-primary/30',
  },
  readonly: {
    labelKey: 'agent.kanban.control.readonly',
    get label() { return rawT(this.labelKey); },
    className: 'bg-fill-3 text-ink-3 border border-line',
  },
};

function formatSessionRelativeTime(ts: number, locale: ResolvedLocale, tFn: typeof rawT = rawT): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const diffMs = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return tFn('agent.kanban.time.justNow');
  if (mins < 60) return tFn('agent.kanban.time.minsAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tFn('agent.kanban.time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return tFn('agent.kanban.time.daysAgo', { count: days });
  return formatDate(ts, undefined, locale);
}

function shortWorkspaceName(workspaceRoot: string, tFn: typeof rawT = rawT): string {
  const clean = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!clean) return tFn('agent.kanban.unknownWorkspace');
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

const WORK_GROUPS = [
  { key: 'saved', labelKey: 'agent.kanban.group.saved' },
  { key: 'active', labelKey: 'agent.kanban.group.active' },
  { key: 'attention', labelKey: 'agent.kanban.group.attention' },
  { key: 'results', labelKey: 'agent.kanban.group.results' },
  { key: 'stopped', labelKey: 'agent.kanban.group.stopped' },
] as const;

type WorkGroup = typeof WORK_GROUPS[number]['key'] | 'history';

const PENDING_DESCRIPTION_KEYS: Record<string, MessageKey> = {
  rc_report: 'agent.kanban.pending.rc_report',
  ado_state_write: 'agent.kanban.pending.ado_state_write',
  ado_comment: 'agent.kanban.pending.ado_comment',
};
const ISSUE_DESCRIPTION_KEYS: Record<string, MessageKey> = {
  waiting_input: 'agent.kanban.issue.waiting_input',
  waiting_approval: 'agent.kanban.issue.waiting_approval',
  error: 'agent.kanban.issue.error',
};

function decisionHeadline(decision: NativeWorkDecision, tFn: typeof rawT = rawT): string {
  const params = decision.params as { questions?: Array<{ question?: string }>; reason?: string; command?: string } | null;
  if (decision.method === 'item/tool/requestUserInput') {
    const first = Array.isArray(params?.questions) ? params.questions[0]?.question : null;
    return typeof first === 'string' && first.trim() ? first : tFn('agent.kanban.decision.userQuestionFallback');
  }
  if (typeof params?.reason === 'string' && params.reason.trim()) return params.reason;
  if (typeof params?.command === 'string' && params.command.trim()) return tFn('agent.kanban.decision.runCommand', { command: params.command });
  if (decision.method === 'item/fileChange/requestApproval') return tFn('agent.kanban.decision.fileChange');
  return tFn('agent.kanban.decision.fallback');
}

function nativeObservationKey(card: NativeWorkCard, session: NativeWorkSessionRecord, eventVersion: number): string {
  return JSON.stringify([card.id, card.state.requirementsVersion ?? 0, card.state.contentVersion ?? 0,
    session.id, session.nativeSessionId, session.accountScope, session.sourceScope, session.workspaceRoot,
    session.updatedAt, session.runtimeStatus, session.controlMode, session.configSnapshotJson, eventVersion]);
}

type WorkEntry = { id: string; target?: 'evidence' | 'reply'; turnId?: string; sessionId?: string };

export default function WorkKanbanBoard({ initialWork }: { initialWork?: WorkEntry | null } = {}) {
  const { t, locale } = useI18n();
  const { cards, sessions, links, evidences, actions, loading, hydrated, lastError, hydrate } = useWorkLedger();
  const butlerSidebarCollapsed = useUI((state) => state.butlerSidebarCollapsed);
  const toggleButlerSidebarCollapsed = useUI((state) => state.toggleButlerSidebarCollapsed);
  const [waitFilter, setWaitFilter] = useState<'all' | 'attention' | WorkCardWaitState>('all');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [resultEntry, setResultEntry] = useState<WorkEntry | null>(null);
  const consumedEntry = useRef<WorkEntry | null>(null);
  const [poolOpen, setPoolOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(false);
  const [previewSession, setPreviewSession] = useState<NativeWorkSessionRecord | null>(null);
  const [actingSessionId, setActingSessionId] = useState<string | null>(null);
  const { key: draftKey, draft: newWorkDraft } = useNewWorkDraft();
  const { goal: newGoal, workspace: newWorkspace, open: newWorkOpen, error: createError } = newWorkDraft;
  const creating = Boolean(newWorkDraft.pending);
  const agents = useAcpAgents(state => state.agents);
  const hydrateAgents = useAcpAgents(state => state.hydrate);
  const openAcpHub = useUI(state => state.openAcpHub);
  const startProfiles = useMemo(() => eligibleCodexProfiles(agents), [agents]);
  const startProfile = chooseStartProfile(startProfiles, newWorkspace, newWorkDraft.profileId);
  const hasInvestigator = isTauriRuntime() && startProfiles.length > 0;
  useEffect(() => { if (newWorkOpen) void hydrateAgents(); }, [newWorkOpen, hydrateAgents, draftKey]);
  const setNewWorkOpen = (open: boolean) => useNewWorkDrafts.getState().edit(draftKey, { open });
  const setNewGoal = (goal: string) => useNewWorkDrafts.getState().edit(draftKey, { goal });
  const setNewWorkspace = (workspace: string) => useNewWorkDrafts.getState().edit(draftKey, { workspace });
  const setCreateError = (error: string | null) => useNewWorkDrafts.getState().edit(draftKey, { error });
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [nativeSnapshots, setNativeSnapshots] = useState<Record<string, { snapshot: NativeWorkSnapshot; observationKey: string }>>({});
  const [nativeEventVersions, setNativeEventVersions] = useState<Record<string, number>>({});
  const newWorkMounted = useRef(false);
  const directoryRequest = useRef(0);
  const newWorkTarget = useRef(0);
  const [sessionSyncError, setSessionSyncError] = useState<string | null>(null);
  const [scanningSessions, setScanningSessions] = useState(true);
  const scanGeneration = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const boardRoot = useRef<HTMLDivElement | null>(null);
  const setToastViewport = useToast(state => state.setViewport);
  const boardContent = useRef<HTMLDivElement | null>(null);
  const searchContainer = useRef<HTMLDivElement | null>(null);
  const detailContainer = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const board = boardRoot.current;
    if (!board) return;
    const updateLayout = () => setCompactLayout(board.clientWidth <= 980);
    const observer = new ResizeObserver(updateLayout);
    observer.observe(board); updateLayout();
    return () => observer.disconnect();
  }, []);
  const updateNativeSnapshot = useCallback((sessionId: string, snapshot: NativeWorkSnapshot | null, observationKey?: string) => {
    if (!observationKey) return;
    setNativeSnapshots((previous) => {
      const before = previous[sessionId];
      if (!snapshot) {
        if (!before || before.observationKey !== observationKey) return previous;
        const next = { ...previous }; delete next[sessionId]; return next;
      }
      if (before?.observationKey === observationKey && JSON.stringify(before.snapshot) === JSON.stringify(snapshot)) return previous;
      return { ...previous, [sessionId]: { snapshot, observationKey } };
    });
  }, []);

  useEffect(() => {
    let subscribing = true;
    const unsubscribe = subscribeButlerAccountSelection(() => {
      if (subscribing) return; // Initial notification also fires on StrictMode effect replay.
      directoryRequest.current += 1; newWorkTarget.current += 1;
      setNativeSnapshots({}); setNativeEventVersions({}); setSelectedCardId(null); setResultEntry(null);
      setChoosingDirectory(false);
    });
    subscribing = false;
    return unsubscribe;
  }, []);

  useEffect(() => {
    newWorkMounted.current = true;
    return () => { newWorkMounted.current = false; directoryRequest.current += 1; };
  }, []);

  useEffect(() => {
    directoryRequest.current += 1; newWorkTarget.current += 1;
    setChoosingDirectory(false);
  }, [draftKey]);

  const selectedAccountScope = resolveButlerAccountScope();
  const startTrials = useNativeWorkStarts(state => state.trials);
  const workspaceChoices = useMemo(() => {
    const choices = new Map<string, string>();
    const candidates = [...sessions.filter((session) => !session.accountScope || session.accountScope === selectedAccountScope).map((session) => session.workspaceRoot),
      ...links.filter((link) => link.kind === 'kanban_card' && link.stateSnapshot === 'workspace' && cards.some((card) => card.id === link.todoId)).map((link) => link.repo)];
    for (const candidate of candidates) {
      const path = candidate?.trim();
      if (path && !choices.has(workContextPathKey(path))) choices.set(workContextPathKey(path), path);
    }
    return [...choices.values()];
  }, [sessions, links, cards, selectedAccountScope]);

  const showNewWork = (open: boolean) => {
    newWorkTarget.current += 1; directoryRequest.current += 1;
    setChoosingDirectory(false); setNewWorkOpen(open);
  };

  const chooseWorkDirectory = async () => {
    const request = ++directoryRequest.current;
    const target = newWorkTarget.current;
    const accountScope = resolveButlerAccountScope();
    const runtimeScope = useCodexWorkspace.getState().scope;
    const assertAccount = captureButlerAccountGeneration();
    const isCurrent = () => request === directoryRequest.current && target === newWorkTarget.current
      && accountScope === resolveButlerAccountScope() && runtimeScope === useCodexWorkspace.getState().scope;
    setChoosingDirectory(true);
    try {
      const directory = await openDesktopDialog({ directory: true, multiple: false, title: t('agent.kanban.pickWorkspaceTitle') });
      if (!isCurrent()) return;
      assertAccount();
      if (typeof directory === 'string' && directory.trim()) { setNewWorkspace(directory); setCreateError(null); }
    } catch (error) {
      if (isCurrent()) setCreateError(error instanceof Error ? error.message : String(error));
    } finally { if (request === directoryRequest.current) setChoosingDirectory(false); }
  };

  const selectWork = (id: string, target?: WorkEntry['target'], turnId?: string, sessionId?: string) => {
    if (!selectedCardId) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setResultEntry(target ? { id, target, turnId, sessionId } : null);
    setSelectedCardId(id);
  };
  useEffect(() => {
    if (!initialWork || initialWork === consumedEntry.current || !hydrated || !cards.some(card => card.id === initialWork.id)) return;
    consumedEntry.current = initialWork;
    setResultEntry(initialWork);
    setSelectedCardId(initialWork.id);
  }, [initialWork, hydrated, cards]);
  const closeWork = () => {
    const closedId = selectedCardId;
    setSelectedCardId(null);
    requestAnimationFrame(() => {
      const target = returnFocus.current?.isConnected ? returnFocus.current
        : searchOpen ? searchContainer.current?.querySelector('input')
          : closedId ? boardRoot.current?.querySelector<HTMLButtonElement>(`button[data-work-id="${CSS.escape(closedId)}"]`) : null;
      target?.focus({ preventScroll: true });
    });
  };

  const refreshSessions = useCallback(async () => {
    const request = ++scanGeneration.current;
    setScanningSessions(true);
    setSessionSyncError(null);
    try { await syncLiveSessionsIntoLedger(); }
    catch (error) {
      if (request === scanGeneration.current) setSessionSyncError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (request === scanGeneration.current) setScanningSessions(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void hydrate().then(() => { if (current) return refreshSessions(); }).catch((error) => {
      if (current) {
        setSessionSyncError(error instanceof Error ? error.message : String(error));
        setScanningSessions(false);
      }
    });
    return () => { current = false; scanGeneration.current += 1; };
  }, [hydrate, refreshSessions]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let current = true;
    let epoch = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let refreshingEpoch: number | null = null;
    type Update = { epoch: number; assertAccount: () => void };
    let deferred: Update | null = null;
    const schedule = (update: Update) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (!current || update.epoch !== epoch) return;
        if (refreshingEpoch === epoch) { deferred = update; return; }
        refreshingEpoch = epoch;
        void (async () => {
          try {
            update.assertAccount();
            await hydrate();
            update.assertAccount();
          } catch { /* hydrate reports current-account errors; obsolete accounts cannot publish. */ }
          finally {
            if (current && update.epoch === epoch) {
              refreshingEpoch = null;
              if (deferred) { const next = deferred; deferred = null; schedule(next); }
            }
          }
        })();
      }, 250);
    };
    const unsubscribeAccount = subscribeButlerAccountSelection(() => {
      epoch += 1; deferred = null; refreshingEpoch = null;
      if (timer) { clearTimeout(timer); timer = undefined; }
    });
    void listenDesktopEvent<{ accountScope: string; sessionId?: string }>('native-work-updated', ({ payload }) => {
      if (!current) return;
      try {
        const account = captureButlerRuntimeAccountContext();
        if (payload?.accountScope !== account.accountScope) return;
        const sessionId = payload.sessionId;
        if (sessionId && useWorkLedger.getState().sessions.some((session) => session.id === sessionId
          && (!session.accountScope || session.accountScope === account.accountScope))) {
          setNativeEventVersions((versions) => ({ ...versions, [sessionId]: (versions[sessionId] ?? 0) + 1 }));
          setNativeSnapshots((previous) => { if (!previous[sessionId]) return previous; const next = { ...previous }; delete next[sessionId]; return next; });
        }
        schedule({ epoch, assertAccount: captureButlerAccountGeneration() });
      } catch { /* No selected, ready account: ignore background notifications. */ }
    }).then((stop) => {
      if (current) unlisten = stop;
      else void Promise.resolve(stop()).catch(() => {});
    }).catch((error) => {
      if (current) setSessionSyncError(t('agent.kanban.backgroundListenerFailed', { error: error instanceof Error ? error.message : String(error) }));
    });
    return () => {
      current = false; epoch += 1; deferred = null;
      if (timer) clearTimeout(timer);
      unsubscribeAccount();
      if (unlisten) void Promise.resolve(unlisten()).catch(() => {});
    };
  }, [hydrate]);

  useEffect(() => {
    if (searchOpen) searchContainer.current?.querySelector('input')?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (selectedCardId && hydrated && !loading && !cards.some((card) => card.id === selectedCardId)) setSelectedCardId(null);
  }, [cards, hydrated, loading, selectedCardId]);

  useEffect(() => {
    const content = boardContent.current;
    const detail = detailContainer.current;
    if (!selectedCardId || !content || !detail || !boardRoot.current) return;
    detailContainer.current?.focus({ preventScroll: true });
    const blocked = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
    const restore = () => {
      for (const [element, original] of blocked) {
        element.inert = original.inert;
        if (original.ariaHidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', original.ariaHidden);
      }
      blocked.clear();
    };
    const block = (element: HTMLElement) => {
      blocked.set(element, { inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') });
      element.inert = true; element.setAttribute('aria-hidden', 'true');
    };
    const updateOverlay = () => {
      restore();
      if ((boardRoot.current?.clientWidth ?? 0) <= 1100) block(content);
      else {
        const overlay = detail.getBoundingClientRect();
        for (const element of content.querySelectorAll<HTMLElement>('*')) {
          if (element.closest('[inert]')) continue;
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          const fullyCovered = rect.left >= overlay.left && rect.right <= overlay.right;
          const coveredControl = element.matches('button, input, textarea, select, summary, a[href], [tabindex]')
            && rect.left + rect.width / 2 >= overlay.left;
          if (fullyCovered || coveredControl) block(element);
        }
      }
      if (document.activeElement instanceof HTMLElement && content.contains(document.activeElement)
        && document.activeElement.closest('[inert]')) detail.focus({ preventScroll: true });
    };
    const observer = new ResizeObserver(updateOverlay);
    observer.observe(boardRoot.current); observer.observe(detail);
    const mutations = new MutationObserver(updateOverlay);
    mutations.observe(content, { childList: true, subtree: true });
    updateOverlay();
    return () => { observer.disconnect(); mutations.disconnect(); restore(); };
  }, [selectedCardId, searchOpen, poolOpen, newWorkOpen]);

  const rows = useMemo(() => cards.map((card) => {
    const cardSessions = sessions.filter((session) => session.todoId === card.id).sort((a, b) => b.updatedAt - a.updatedAt);
    const pending = actions.filter((action) => action.todoId === card.id && action.state === 'awaiting_approval');
    const session = cardSessions[0];
    const startKey = workStartKey(selectedAccountScope, card.id);
    const startTrial = cardSessions.length === 0 ? startTrials[startKey] : undefined;
    const opening = Boolean(startTrial && isWorkStartPending(startKey));
    const startIssue = startTrial && !opening
      ? startTrial.notStarted ? t('agent.kanban.startNotStarted') : t('agent.kanban.startPendingReceipt') : null;
    let nativeProfile: string | null = null;
    try {
      const config = JSON.parse(session?.configSnapshotJson ?? '{}');
      const profile = config.executionProfileId ?? config.agentId;
      if (typeof profile === 'string' && profile.trim()) nativeProfile = profile;
    } catch { /* Historical records may not contain a usable execution profile. */ }
    const observationKey = session ? nativeObservationKey(card, session, nativeEventVersions[session.id] ?? 0) : undefined;
    const entry = session && nativeSnapshots[session.id];
    const candidate = entry && entry.observationKey === observationKey ? entry.snapshot : null;
    const snapshot = candidate?.todoId === card.id && candidate.nativeThreadId === session.nativeSessionId
      && candidate.sourceScope === session.sourceScope && candidate.executionProfileId === nativeProfile ? candidate : null;
    const resultReply = findWorkResultReply(snapshot, card);
    const uncertain = session && unresolvedWorkDelivery(snapshot?.commands ?? actions, card.id, session.id);
    const stopped = (snapshot?.runtimeStatus ?? session?.runtimeStatus) === 'interrupted' || (!snapshot && session?.runtimeStatus === 'stopped');
    const latestEvidence = evidences.filter((evidence) => evidence.todoId === card.id && !evidence.stale
      && (evidence.requirementsVersion ?? 0) === (card.state.requirementsVersion ?? 0)
      && (evidence.contentVersion ?? 0) === (card.state.contentVersion ?? 0))
      .sort((a, b) => b.verifiedAt - a.verifiedAt)[0];
    const verifiedRecord = latestEvidence && ['test_run', 'ci_build', 'diff_check', 'manual_ack'].includes(latestEvidence.kind);
    const observedIssue = cardSessions.find((session) => {
      if (['waiting_input', 'waiting_approval'].includes(session.runtimeStatus)) return true;
      if (session.runtimeStatus !== 'error') return false;
      const recovered = verifiedRecord && latestEvidence.passed && latestEvidence.verifiedAt > session.updatedAt
        && cardSessions.some((newer) => newer.updatedAt > session.updatedAt && ['idle', 'ended', 'running'].includes(newer.runtimeStatus));
      return !recovered;
    });
    const attention = Boolean(uncertain || startIssue) || ['waiting_input', 'waiting_approval', 'blocked'].includes(card.state.waitState)
      || pending.length > 0 || Boolean(observedIssue)
      || Boolean(snapshot && (['waiting_input', 'waiting_approval'].includes(snapshot.runtimeStatus) || snapshot.error
        || snapshot.decisions.some((decision) => decision.state === 'pending' || decision.state === 'unknown')))
      || Boolean(verifiedRecord && !latestEvidence.passed);
    let group: WorkGroup = 'saved';
    if (attention) group = 'attention';
    else if (card.state.stage === 'done') group = 'history';
    else if (stopped && !snapshot?.admissionWait) group = 'stopped';
    else if (!['paused', 'canceled'].includes(card.state.waitState)) {
      if (snapshot?.admissionWait) group = 'saved';
      else if (card.state.waitState === 'waiting_external' || (snapshot ? snapshot.connectionStatus === 'connected' && snapshot.runtimeStatus === 'running' : cardSessions.some((item) => item.runtimeStatus === 'running'))) group = 'active';
      else if (latestEvidence || (snapshot?.runtimeStatus === 'idle' && resultReply)) group = 'results';
    }
    const boundRoot = links.find((link) => link.todoId === card.id && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace')?.repo;
    const roots = [...new Set([...cardSessions.map((item) => item.workspaceRoot), boundRoot].filter((value): value is string => Boolean(value)))];
    const project = card.state.projectKey || card.adoProject || (roots.length === 1 ? shortWorkspaceName(roots[0], t) : roots.length > 1 ? t('agent.kanban.projectMultiple') : t('agent.kanban.projectPersonal'));
    const sessionSourceLabels = [...new Set(cardSessions.map((session) => parseWorkSessionProviderMeta(session).label))].join(' / ');
    const hasDisplaySource = Boolean(sessionSourceLabels || card.adoWorkItemId || card.source === 'message');
    const source = sessionSourceLabels
      || (card.adoWorkItemId ? 'ADO' : card.source === 'message' ? t('agent.kanban.sourceMessage') : t('agent.kanban.sourceManual'));
    const summary = snapshot?.messages.filter((message) => message.role === 'assistant').at(-1)?.text
      || cardSessions.map((session) => parseWorkSessionProviderMeta(session).preview)
      .find((preview) => preview?.trim() && preview.trim() !== card.title.trim() && preview.trim() !== card.state.goal?.trim());
    const updatedAt = Math.max(card.updatedAt || card.createdAt, ...cardSessions.map((session) => session.updatedAt));
    const decision = snapshot?.decisions.find(item => canAnswerWorkDecision(snapshot, card, item));
    const pendingKey = pending.length ? PENDING_DESCRIPTION_KEYS[pending[0].actionKind] : undefined;
    const issueKey = observedIssue ? ISSUE_DESCRIPTION_KEYS[observedIssue.runtimeStatus] : undefined;
    const reason = startIssue || (uncertain ? t('agent.kanban.reasonUnverifiedDelivery') : null) || snapshot?.error
      || (snapshot?.decisions.some(item => item.state === 'unknown') ? t('agent.kanban.reasonUnknownDecision') : null)
      || (decision ? decisionHeadline(decision, t) : null)
      || (snapshot?.decisions.some(item => item.state === 'pending') ? t('agent.kanban.reasonPendingDecision') : null)
      || (card.state.waitState !== 'none' ? card.state.waitReason : null)
      || (pending.length ? (pendingKey ? t(pendingKey) : t('agent.kanban.reasonPendingActionFallback')) : null)
      || (issueKey ? t(issueKey) : null);
    return { card, cardSessions, nativeProfile, observationKey, snapshot, latestEvidence, verifiedRecord, observedIssue, pending, group, project, source, hasDisplaySource, summary, updatedAt, roots, decision, reason, resultReply, uncertain, opening };
  }).sort((a, b) => b.updatedAt - a.updatedAt || compareLocaleText(a.card.id, b.card.id, locale)), [cards, sessions, links, evidences, actions, nativeSnapshots, nativeEventVersions, startTrials, selectedAccountScope, locale, t]);

  const counts = {
    all: rows.length,
    attention: rows.filter((row) => row.group === 'attention').length,
    waiting_external: rows.filter((row) => row.card.state.waitState === 'waiting_external').length,
    paused: rows.filter((row) => row.card.state.waitState === 'paused').length,
  };
  const filteredRows = rows.filter((row) => waitFilter === 'all'
    || (waitFilter === 'attention' ? row.group === 'attention' : row.card.state.waitState === waitFilter));
  const visibleGroups = WORK_GROUPS.map((group) => ({ ...group, label: t(group.labelKey), rows: filteredRows.filter((row) => row.group === group.key) }))
    .filter((group) => group.rows.length > 0 || !compactLayout && group.key !== 'stopped');
  if (compactLayout) {
    const priority = ['attention', 'results', 'active', 'saved', 'stopped'];
    visibleGroups.sort((first, second) => priority.indexOf(first.key) - priority.indexOf(second.key));
  }
  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? null;
  const activeCount = rows.filter((row) => row.group === 'active' && row.card.state.waitState !== 'waiting_external').length;
  const resultsCount = rows.filter((row) => row.group === 'results').length;
  const queuedCount = rows.filter(row => row.snapshot?.admissionWait && row.snapshot.admissionWait.reason !== 'recovery_required').length;
  const featured = rows.find(row => row.group === 'attention' && row.decision)
    ?? rows.find(row => row.group === 'attention')
    ?? rows.find(row => row.group === 'results');
  const featureText = featured && (featured.reason || featured.latestEvidence?.summary || featured.latestEvidence?.title
    || featured.resultReply?.text || featured.card.state.nextStep || featured.card.title);
  const viewResult = (row: typeof rows[number]) => selectWork(row.card.id, row.latestEvidence ? 'evidence' : 'reply', row.resultReply?.turnId ?? undefined, row.snapshot?.sessionId);
  const featureAction = featured?.uncertain ? t('agent.kanban.featureAction.verifyDelivery') : featured?.decision?.method === 'item/tool/requestUserInput' ? t('agent.kanban.featureAction.answerQuestion')
    : featured?.decision || featured?.pending.length ? t('agent.kanban.featureAction.viewRequest') : featured?.group === 'results' ? t('agent.kanban.featureAction.viewResult') : t('agent.kanban.featureAction.viewBlocker');
  const openFeatured = () => {
    if (!featured) return;
    // Focus the existing card control so a shortcut never submits an answer or creates a second responder.
    if (featured.decision && !featured.uncertain) {
      const row = boardContent.current?.querySelector(`[data-card-id="${CSS.escape(featured.card.id)}"]`);
      const section = row?.querySelector<HTMLElement>(`[data-native-decision-id="${CSS.escape(featured.decision.id)}"]`);
      if (section) {
        section.scrollIntoView({ block: 'nearest' });
        const input = section.querySelector<HTMLElement>('select:not(:disabled), input:not(:disabled)');
        section.tabIndex = -1;
        (input ?? section).focus({ preventScroll: true });
        return;
      }
    }
    if (featured.group === 'results') viewResult(featured);
    else selectWork(featured.card.id);
  };
  const orphanActions = actions.filter((action) => action.state === 'awaiting_approval' && !cards.some((card) => card.id === action.todoId));

  const handleOpenSession = async (session: NativeWorkSessionRecord) => {
    if (session.controlMode === 'readonly') { setPreviewSession(session); return; }
    setActingSessionId(session.id);
    try { await openOrResumeWorkSession(session); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setActingSessionId(null); }
  };

  const createWork = async (start: boolean) => {
    if (draftKey !== newWorkDraftKey() || creating || !newGoal.trim() || !newWorkspace.trim()) return;
    if (!absoluteWorkspace(newWorkspace)) {
      setCreateError(t('agent.kanban.errorRequireAbsoluteDir')); return;
    }
    const accountScope = resolveButlerAccountScope();
    const runtimeScope = useCodexWorkspace.getState().scope;
    const assertAccount = captureButlerAccountGeneration();
    const profileId = start ? startProfile?.id : undefined;
    if (start && !profileId) { setCreateError(t('agent.kanban.errorSelectCodexProfile')); return; }
    const request = useNewWorkDrafts.getState().begin(draftKey);
    if (!request) return;
    const target = newWorkTarget.current;
    const assertCurrentAccount = () => {
      assertAccount();
      if (resolveButlerAccountScope() !== accountScope || useCodexWorkspace.getState().scope !== runtimeScope) {
        throw new Error(t('agent.kanban.errorAccountOrScopeSwitched'));
      }
    };
    try {
      const { goal, workspace } = request;
      const card = await useWorkLedger.getState().createCard({ requestId: request.id, title: goal.split('\n')[0].slice(0, 100), goal, stage: 'ready', priority: 3, projectKey: shortWorkspaceName(workspace, t) });
      assertCurrentAccount();
      await useWorkLedger.getState().upsertLink({ todoId: card.id, kind: 'kanban_card', externalId: card.id, project: card.state.projectKey,
        repo: workspace, rid: card.rid, headSha: null, title: t('agent.kanban.linkTitleWorkspace'), webUrl: null, stateSnapshot: 'workspace' });
      assertCurrentAccount();
      // The saved work owns the native start request even if the form is later closed.
      if (profileId) void beginWorkInvestigation(card, workspace, profileId).catch(error => {
        if (draftKey === newWorkDraftKey() && newWorkMounted.current && target === newWorkTarget.current)
          toast.error(error instanceof Error ? error.message : String(error));
      });
      const unchanged = useNewWorkDrafts.getState().drafts[draftKey]?.revision === request.revision;
      useNewWorkDrafts.getState().finish(draftKey, request.id);
      if (!newWorkMounted.current || target !== newWorkTarget.current || !unchanged) return;
      selectWork(card.id);
      if (!profileId) toast.success(t('agent.kanban.toastWorkSaved'));
    } catch (error) { useNewWorkDrafts.getState().finish(draftKey, request.id, error instanceof Error ? error.message : String(error)); }
  };

  const renderRow = (row: typeof rows[number]) => {
    const { card, cardSessions, nativeProfile, observationKey, snapshot, latestEvidence, verifiedRecord, observedIssue, pending, group, project, source, hasDisplaySource, summary, updatedAt, roots, reason } = row;
    const waiting = card.state.waitState !== 'none';
    const waitingLabel = t(WAIT_STATE_LABELS[card.state.waitState].labelKey);
    const session = cardSessions[0];
    const isUnverifiedStatus = Boolean(
      !snapshot?.admissionWait
      && group !== 'active'
      && group !== 'history'
      && !waiting
      && !observedIssue
      && !pending.length
      && (snapshot?.runtimeStatus === 'unknown'
        || snapshot?.connectionStatus === 'unknown'
        || (!snapshot && (session?.runtimeStatus === 'unknown' || card.state.stage === 'in_progress'))),
    );
    const isRecentRunningStatus = Boolean(!snapshot?.admissionWait && group === 'active' && snapshot?.runtimeStatus !== 'running');
    const showStatusBadge = isUnverifiedStatus || isRecentRunningStatus || group === 'history';
    const status = snapshot?.admissionWait ? t('agent.kanban.status.admissionWait')
      : group === 'active' ? snapshot?.runtimeStatus === 'running' ? t('agent.kanban.status.running') : t('agent.kanban.status.recentRunning')
      : group === 'history' ? t('agent.kanban.status.historyDone')
      : waiting ? waitingLabel
      : observedIssue ? observedIssue.runtimeStatus === 'error' ? t('agent.kanban.status.sessionError') : observedIssue.runtimeStatus === 'waiting_approval' ? t('agent.kanban.status.sessionWaitingApproval') : t('agent.kanban.status.sessionWaitingInput')
      : pending.length ? t('agent.kanban.status.pendingAction')
      : isUnverifiedStatus ? t('agent.kanban.status.unverifiedExecution')
      : group === 'results' ? t('agent.kanban.status.hasResults') : t('agent.kanban.status.recorded');
    const actionLabel = group === 'attention' ? t('agent.kanban.action.reviewAndHandle') : group === 'results' ? t('agent.kanban.action.viewResult') : t('agent.kanban.action.openWork');
    const evidenceLabel = latestEvidence && (verifiedRecord
      ? t(latestEvidence.passed ? 'agent.kanban.evidence.verifiedPassed' : 'agent.kanban.evidence.verifiedFailed')
      : latestEvidence.kind === 'agent_report' ? t('agent.kanban.evidence.agentNote') : t('agent.kanban.evidence.recentRecord'));
    const pendingStart = pendingInvestigation(snapshot);
    const situation = reason || snapshot?.admissionWait?.message || pendingStart || (row.opening ? t('agent.kanban.situation.preparing') : null)
      || (group === 'stopped' ? t('agent.kanban.situation.stopped') : null) || (waiting ? waitingLabel : null)
      || latestEvidence?.summary || latestEvidence?.title || (group === 'results' && row.resultReply?.text) || summary || card.state.nextStep
      || (card.state.goal?.trim() !== card.title.trim() ? card.state.goal : null)
      || (group === 'history' ? t('agent.kanban.situation.noCurrentEvidence') : !session && roots.length ? t('agent.kanban.situation.boundWaitingExecutor') : '');
    const provenance = group !== 'stopped' && !reason && !pendingStart && !snapshot?.admissionWait && !waiting && (evidenceLabel || (summary && (snapshot ? t('agent.kanban.provenance.executorReply') : t('agent.kanban.provenance.originalSummary'))));
    return <article key={card.id} data-card-id={card.id} className="work-first-row" data-selected={selectedCardId === card.id} data-tone={group === 'attention' ? 'attention' : group === 'active' ? 'active' : group === 'results' ? 'results' : 'default'}>
      <button type="button" data-work-id={card.id} aria-label={card.title} aria-pressed={selectedCardId === card.id}
        onClick={() => group === 'results' ? viewResult(row) : selectWork(card.id)} className="work-first-row-main text-left">
        <span className="work-first-row-title">{card.title}</span>
        {situation && <span className="work-first-row-summary">{situation}</span>}
        <span className="work-first-row-meta">
          <span title={roots.join('\n')}>{project}{card.adoWorkItemId ? ` · #${card.adoWorkItemId}` : ''}</span>
          {hasDisplaySource && <span>{source}</span>}
          {provenance && <span>{provenance}</span>}
          {showStatusBadge && <span>{status}</span>}
          <time title={t('agent.kanban.meta.updatedAtTitle', { time: formatDateTime(updatedAt, undefined, locale) })}>{formatSessionRelativeTime(updatedAt, locale, t)}</time>
          {card.priority <= 2 && <span className={card.priority === 1 ? 'text-danger' : 'text-warning'}>{card.priority === 1 ? t('agent.kanban.priority.urgent') : t('agent.kanban.priority.high')}</span>}
        </span>
        {!(session && nativeProfile && parseWorkSessionProviderMeta(session).provider === 'codex') && <span className="work-first-row-action">{actionLabel}<ArrowRight size={14} aria-hidden="true" /></span>}
      </button>
      {session && nativeProfile && parseWorkSessionProviderMeta(session).provider === 'codex' && <NativeWorkCardControls card={card} session={session} observationKey={observationKey}
        allowStart={group === 'saved' || group === 'stopped'} onViewResult={group === 'results' ? () => viewResult(row) : undefined}
        onOpen={() => selectWork(card.id)} onSnapshot={(snapshot, observed) => updateNativeSnapshot(session.id, snapshot, observed)} />}
      {session && !(nativeProfile && parseWorkSessionProviderMeta(session).provider === 'codex') && <button type="button" disabled={actingSessionId === session.id} className="work-first-row-source"
        onClick={() => void handleOpenSession(session)} title={session.workspaceRoot}>
        <History size={13} aria-hidden="true" />
        {t('agent.kanban.sessionSourceBtn', {
          action: session.controlMode === 'readonly' ? t('agent.kanban.sessionActionView') : t('agent.kanban.sessionActionOpen'),
          label: parseWorkSessionProviderMeta(session).label,
        })}
      </button>}
    </article>;
  };

  return <div ref={boardRoot} className="work-first-board relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-surface-3">
    <header className="rcx-glass-header flex h-[52px] min-h-[52px] shrink-0 items-center justify-between gap-3 border-b border-line px-5">
      <div className="flex min-w-0 items-center gap-2">
        {butlerSidebarCollapsed ? <button type="button" onClick={toggleButlerSidebarCollapsed} title={t('agent.kanban.expandSidebarTitle')} aria-label={t('agent.kanban.expandSidebarAria')} className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover"><PanelLeft size={16} /></button> : null}
        <h1 className="text-base font-semibold text-ink">{t('agent.kanban.headerTitle')}</h1>
        <span className="text-xs text-ink-3">{cards.length}</span>
      </div>
      {!poolOpen && !selectedCard && <div className="work-board-entry-actions">
        <button type="button" className="work-first-secondary-button" onClick={() => setPoolOpen(true)}><History size={15} />{t('agent.kanban.addExistingSession')}</button>
        <button type="button" className="work-first-primary-button" onClick={() => showNewWork(true)}><Plus size={15} />{t('agent.kanban.newWorkBtn')}</button>
      </div>}
    </header>
    <div ref={setToastViewport} className="max-h-[12%] shrink-0 overflow-y-auto" />
    {loading && !hydrated && <p role="status" className="shrink-0 px-5 py-2 text-sm text-ink-2">{t('agent.kanban.readingRecords')}</p>}
    {lastError || sessionSyncError ? <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-5 py-2 text-xs text-ink">
      <span>{t('agent.kanban.cacheLoadNotice', { error: lastError || sessionSyncError || '' })}</span>
      <button type="button" aria-label={t('agent.kanban.retryReadAria')} className="shrink-0 text-primary hover:underline" onClick={() => { void hydrate(); if (sessionSyncError) void refreshSessions().catch(() => {}); }}>{t('common.retry')}</button>
    </div> : !hydrated && !loading ? <div role="status" className="px-5 py-2 text-xs text-ink-2">{t('agent.kanban.notReadYet')}<button type="button" onClick={() => void hydrate()} className="ml-2 text-primary">{t('agent.kanban.readRecordsBtn')}</button></div> : null}

    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={boardContent} className="work-first-board-content flex min-h-0 flex-1 flex-col">
        {poolOpen ? <div className="min-h-0 flex-1 overflow-auto p-5"><WorkSessionImport scanning={scanningSessions} scanError={sessionSyncError} onRefresh={refreshSessions}
          onSelectWork={(id) => { selectWork(id); setPoolOpen(false); }} onClose={() => setPoolOpen(false)} /></div> : <>
          {!newWorkOpen && rows.length > 0 && <section aria-label={t('agent.kanban.briefingAria')} className="work-control-brief" data-tone={featured?.group}>
            <Bot size={19} aria-hidden="true" className="text-primary" />
            <div>
              {featured && <><div className="work-brief-source">{featured.group === 'attention' ? t('agent.kanban.group.attention') : featured.verifiedRecord ? t('agent.kanban.briefVerified') : t('agent.kanban.briefUnverified')} · {featured.card.title}</div>
                <p>{featureText}</p></>}
              <div className="work-brief-counts">{activeCount > 0 ? t('agent.kanban.briefActiveCount', { count: activeCount }) : t('agent.kanban.briefNoActive')}{queuedCount > 0 && t('agent.kanban.briefQueuedSuffix', { count: queuedCount })}{counts.attention > 1 && t('agent.kanban.briefMoreAttentionSuffix', { count: counts.attention - 1 })}{resultsCount > 0 && t('agent.kanban.briefResultsSuffix', { count: resultsCount })}{counts.waiting_external > 0 && t('agent.kanban.briefExternalSuffix', { count: counts.waiting_external })}</div>
            </div>
            {featured && <button type="button" onClick={openFeatured}>{featureAction}<ArrowRight size={14} aria-hidden="true" /></button>}
          </section>}
          {newWorkOpen && <form aria-label={t('agent.kanban.newFormAria')} className="work-control-new" onKeyDown={event => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
          }} onSubmit={(event) => {
            event.preventDefault();
            void createWork(hasInvestigator);
          }}>
            <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium text-ink">{t('agent.kanban.newWorkBtn')}</h2><button type="button" aria-label={t('agent.kanban.closeNewFormAria')} onClick={() => showNewWork(false)} className="text-ink-3"><X size={17} /></button></div>
            <label className="work-control-field">{t('agent.kanban.goalFieldLabel')}<textarea required value={newGoal} onChange={(event) => { newWorkTarget.current += 1; setNewGoal(event.target.value); }} placeholder={t('agent.kanban.goalFieldPlaceholder')} /></label>
            <div className="flex items-end gap-2"><label className="work-control-field min-w-0 flex-1">{t('agent.kanban.workspaceFieldLabel')}<input required value={newWorkspace} onChange={(event) => { newWorkTarget.current += 1; setNewWorkspace(event.target.value); }} placeholder={t('agent.kanban.workspaceFieldPlaceholder')} /></label><button type="button" disabled={choosingDirectory} onClick={() => void chooseWorkDirectory()} className="work-first-secondary-button shrink-0 disabled:opacity-50">{choosingDirectory ? t('agent.kanban.choosingDir') : t('agent.kanban.chooseFolder')}</button></div>
            {workspaceChoices.length > 0 && <select aria-label={t('agent.kanban.existingDirAria')} value="" onChange={(event) => { if (event.target.value) { newWorkTarget.current += 1; setNewWorkspace(event.target.value); } }} className="w-full rounded-lg border border-line bg-surface-3 px-3 py-2 text-xs text-ink-2"><option value="">{t('agent.kanban.existingDirPlaceholder')}</option>{workspaceChoices.map((workspace) => <option key={workspace} value={workspace}>{shortWorkspaceName(workspace, t)} · {workspace}</option>)}</select>}
            {isTauriRuntime() && (startProfiles.length ? <WorkStartProfile profiles={startProfiles} value={startProfile?.id}
              onChange={profileId => useNewWorkDrafts.getState().edit(draftKey, { profileId })} />
              : <p className="text-xs text-ink-2">{t('agent.kanban.connectCodexHint')} <button type="button" className="text-primary" onClick={() => openAcpHub(null)}>{t('agent.kanban.configureExecutorBtn')}</button></p>)}
            {createError && <p role="alert" className="text-xs text-danger">{createError}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type={hasInvestigator ? 'button' : 'submit'} onClick={hasInvestigator ? () => void createWork(false) : undefined} className={hasInvestigator ? 'work-first-secondary-button' : 'work-first-primary-button'} disabled={creating || !newGoal.trim() || !newWorkspace.trim()}>{creating ? t('agent.kanban.savingBtn') : t('agent.kanban.saveToReadyBtn')}</button>
              {hasInvestigator && <button type="submit" className="work-first-primary-button" disabled={creating || !startProfile || !newGoal.trim() || !newWorkspace.trim()}>{t('agent.kanban.startInvestigationBtn')}</button>}
            </div>
          </form>}
          <div className="work-first-toolbar">
            <nav aria-label={t('agent.kanban.filterAria')} className="flex flex-wrap items-center gap-1">
              {[
                { key: 'all' as const, labelKey: 'agent.kanban.filter.all' as const, count: counts.all },
                { key: 'attention' as const, labelKey: 'agent.kanban.filter.attention' as const, count: counts.attention },
                { key: 'waiting_external' as const, labelKey: 'agent.kanban.filter.waitingExternal' as const, count: counts.waiting_external },
                { key: 'paused' as const, labelKey: 'agent.kanban.filter.paused' as const, count: counts.paused },
              ].map((item) => <button key={item.key} type="button" aria-pressed={waitFilter === item.key} onClick={() => setWaitFilter(item.key)} className="work-first-filter">{t(item.labelKey)}{item.count > 0 ? ` ${item.count}` : ''}</button>)}
            </nav>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setSearchOpen((value) => !value)} aria-expanded={searchOpen} aria-controls="work-first-search" className="work-first-view-button"><Search size={14} />{t('agent.kanban.searchBtn')}</button>
            </div>
          </div>
          <div ref={searchContainer} id="work-first-search" hidden={!searchOpen} className="px-5 pb-3"><WorkContextSearch compact onSelectWork={selectWork} /></div>
          {orphanActions.length > 0 && <div role="status" className="px-5 pb-3 text-xs text-warning">{t('agent.kanban.orphanActionsNotice', { count: orphanActions.length })}<button type="button" className="ml-2 text-primary" onClick={() => void hydrate()}>{t('agent.kanban.rereadBtn')}</button></div>}
          <div className="work-first-groups min-h-0 flex-1 overflow-y-auto">
            <div role="region" aria-label={t('agent.kanban.boardAria')} className="work-control-columns" data-layout={compactLayout ? 'list' : 'kanban'}>{visibleGroups.map((group) => {
              const groupRows = group.rows;
              return <section key={group.key} aria-label={group.label} className="work-first-group" data-empty={!groupRows.length} data-stage={group.key}>
                <div className="work-first-group-heading"><h2>{group.label}</h2><span>{groupRows.length}</span></div>
                {groupRows.map(renderRow)}
                {!groupRows.length && <p className="work-control-column-empty">{group.key === 'attention' ? t('agent.kanban.emptyAttention') : t('agent.kanban.emptyColumn')}</p>}
              </section>;
            })}</div>
            {filteredRows.some((row) => row.group === 'history') && <details className="work-control-history"><summary>{t('agent.kanban.historySummary', { count: filteredRows.filter((row) => row.group === 'history').length })}</summary><section aria-label={t('agent.kanban.historyAria')}>{filteredRows.filter((row) => row.group === 'history').map(renderRow)}</section></details>}
            {filteredRows.length === 0 && hydrated && !loading && !lastError && !sessionSyncError && <div className="work-first-empty">
              <Inbox size={28} className="text-ink-3" />
              <h2 className="text-base font-medium text-ink">{cards.length ? t('agent.kanban.emptyFilteredTitle') : t('agent.kanban.emptyAllTitle')}</h2>
              <p className="text-sm text-ink-3">{cards.length ? t('agent.kanban.emptyFilteredDesc') : t('agent.kanban.emptyAllDesc')}</p>
              {cards.length > 0 && <button type="button" onClick={() => setWaitFilter('all')} className="text-sm text-primary">{t('agent.kanban.viewAllWork')}</button>}
            </div>}
          </div>
        </>}
      </div>
      {selectedCard && <div ref={detailContainer} tabIndex={-1} className="work-control-detail" onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); closeWork(); }
        if (event.key !== 'Tab' || (boardRoot.current?.clientWidth ?? 0) > 1100) return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter((element) => element.getClientRects().length > 0);
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}><WorkCardPortal key={selectedCard.id} card={selectedCard} layout="workspace" resultTarget={resultEntry?.id === selectedCard.id ? resultEntry.target : undefined}
        resultTurnId={resultEntry?.id === selectedCard.id ? resultEntry.turnId : undefined} resultSessionId={resultEntry?.id === selectedCard.id ? resultEntry.sessionId : undefined}
        resultRequest={resultEntry?.id === selectedCard.id ? resultEntry : undefined}
        onClose={closeWork} onSelectWork={selectWork} /></div>}
    </div>
    {previewSession && <WorkSessionHistoryPreview session={previewSession} onClose={() => setPreviewSession(null)} />}
  </div>;
}
