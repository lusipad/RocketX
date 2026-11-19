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

export const WORK_KANBAN_STAGES: {
  key: WorkCardStage;
  label: string;
  tagline: string;
  accent: string;
  dotClass: string;
  borderAccent: string;
  badgeBg: string;
}[] = [
  {
    key: 'triage',
    label: '待整理',
    tagline: '捕获想法与未分拣任务',
    accent: 'text-purple-700 dark:text-purple-300',
    dotClass: 'bg-purple-500',
    borderAccent: 'border-purple-500/30',
    badgeBg: 'bg-purple-500/12 text-purple-700 dark:text-purple-300',
  },
  {
    key: 'ready',
    label: '可执行',
    tagline: '已记录，打开查看目标与下一步',
    accent: 'text-blue-700 dark:text-blue-300',
    dotClass: 'bg-blue-500',
    borderAccent: 'border-blue-500/30',
    badgeBg: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
  },
  {
    key: 'in_progress',
    label: '执行中',
    tagline: '查看当前执行记录与进展',
    accent: 'text-amber-700 dark:text-amber-300',
    dotClass: 'bg-amber-500',
    borderAccent: 'border-amber-500/30',
    badgeBg: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
  },
  {
    key: 'verifying',
    label: '待验证',
    tagline: '等待测试与证据核实',
    accent: 'text-cyan-700 dark:text-cyan-300',
    dotClass: 'bg-cyan-500',
    borderAccent: 'border-cyan-500/30',
    badgeBg: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300',
  },
  {
    key: 'done',
    label: '已完成',
    tagline: '历史标记已完成，验证情况见工作详情',
    accent: 'text-emerald-700 dark:text-emerald-300',
    dotClass: 'bg-emerald-500',
    borderAccent: 'border-emerald-500/30',
    badgeBg: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  },
];

export const WAIT_STATE_LABELS: Record<
  WorkCardWaitState,
  { label: string; badgeClass: string }
> = {
  none: { label: '无待处理事项', badgeClass: 'bg-fill-2 text-ink-3' },
  waiting_input: { label: '需输入', badgeClass: 'bg-warning/15 text-warning font-medium' },
  waiting_approval: {
    label: '需确认',
    badgeClass: 'bg-warning/15 text-warning font-medium',
  },
  waiting_external: {
    label: '等外部',
    badgeClass: 'bg-primary/15 text-primary font-medium',
  },
  blocked: { label: '阻塞', badgeClass: 'bg-danger/15 text-danger font-medium' },
  paused: { label: '已暂停', badgeClass: 'bg-fill-3 text-ink-3 font-medium' },
  canceled: { label: '已取消', badgeClass: 'bg-fill-3 text-ink-4 line-through' },
};

export const AUTONOMY_MODE_LABELS: Record<WorkCardAutonomyMode, string> = {
  readonly: '观察',
  confirm: '建议确认',
  autonomous: '受控自动',
};

export const SESSION_CONTROL_BADGES: Record<
  WorkSessionControlMode,
  { label: string; className: string }
> = {
  controllable: {
    label: '实时控制',
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

function formatSessionRelativeTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const diffMs = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}

function shortWorkspaceName(workspaceRoot: string): string {
  const clean = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!clean) return '未知工作区';
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

const WORK_GROUPS = [
  { key: 'saved', label: '待开始' },
  { key: 'active', label: '正在推进' },
  { key: 'attention', label: '需要你' },
  { key: 'results', label: '结果待看' },
  { key: 'stopped', label: '已停止' },
] as const;

type WorkGroup = typeof WORK_GROUPS[number]['key'] | 'history';

const pendingDescriptions: Record<string, string> = {
  rc_report: '查看待发送的工作汇报', ado_state_write: '核对工作项的状态更新', ado_comment: '核对待发布的工作项评论',
};
const issueDescriptions: Record<string, string> = {
  waiting_input: '原会话正在等你补充信息', waiting_approval: '原会话有待确认的操作', error: '原会话报告执行错误',
};

function decisionHeadline(decision: NativeWorkDecision): string {
  const params = decision.params as { questions?: Array<{ question?: string }>; reason?: string; command?: string } | null;
  if (decision.method === 'item/tool/requestUserInput') {
    const first = Array.isArray(params?.questions) ? params.questions[0]?.question : null;
    return typeof first === 'string' && first.trim() ? first : '执行者有一个问题需要你回答';
  }
  if (typeof params?.reason === 'string' && params.reason.trim()) return params.reason;
  if (typeof params?.command === 'string' && params.command.trim()) return `请求运行 ${params.command}`;
  if (decision.method === 'item/fileChange/requestApproval') return '执行者请求修改项目文件';
  return '执行者有一项请求需要核对';
}

function nativeObservationKey(card: NativeWorkCard, session: NativeWorkSessionRecord, eventVersion: number): string {
  return JSON.stringify([card.id, card.state.requirementsVersion ?? 0, card.state.contentVersion ?? 0,
    session.id, session.nativeSessionId, session.accountScope, session.sourceScope, session.workspaceRoot,
    session.updatedAt, session.runtimeStatus, session.controlMode, session.configSnapshotJson, eventVersion]);
}

type WorkEntry = { id: string; target?: 'evidence' | 'reply'; turnId?: string; sessionId?: string };

export default function WorkKanbanBoard({ initialWork }: { initialWork?: WorkEntry | null } = {}) {
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
      const directory = await openDesktopDialog({ directory: true, multiple: false, title: '选择工作目录' });
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
      if (current) setSessionSyncError(`后台工作状态监听失败：${error instanceof Error ? error.message : String(error)}`);
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
      ? startTrial.notStarted ? '调查尚未开始，请核对项目或执行配置' : '开工回执待核对' : null;
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
    const project = card.state.projectKey || card.adoProject || (roots.length === 1 ? shortWorkspaceName(roots[0]) : roots.length > 1 ? '多个项目' : '个人工作');
    const source = [...new Set(cardSessions.map((session) => parseWorkSessionProviderMeta(session).label))].join(' / ')
      || (card.adoWorkItemId ? 'ADO' : card.source === 'message' ? '讨论消息' : '手动记录');
    const summary = snapshot?.messages.filter((message) => message.role === 'assistant').at(-1)?.text
      || cardSessions.map((session) => parseWorkSessionProviderMeta(session).preview)
      .find((preview) => preview?.trim() && preview.trim() !== card.title.trim() && preview.trim() !== card.state.goal?.trim());
    const updatedAt = Math.max(card.updatedAt || card.createdAt, ...cardSessions.map((session) => session.updatedAt));
    const decision = snapshot?.decisions.find(item => canAnswerWorkDecision(snapshot, card, item));
    const reason = startIssue || (uncertain ? '上次操作的送达结果待核对' : null) || snapshot?.error
      || (snapshot?.decisions.some(item => item.state === 'unknown') ? '上次答复是否送达仍待核对' : null)
      || (decision ? decisionHeadline(decision) : null)
      || (snapshot?.decisions.some(item => item.state === 'pending') ? '有一条旧请求需要核对' : null)
      || (card.state.waitState !== 'none' ? card.state.waitReason : null)
      || (pending.length ? pendingDescriptions[pending[0].actionKind] ?? '查看待决定的操作' : null)
      || (observedIssue ? issueDescriptions[observedIssue.runtimeStatus] : null);
    return { card, cardSessions, nativeProfile, observationKey, snapshot, latestEvidence, verifiedRecord, observedIssue, pending, group, project, source, summary, updatedAt, roots, decision, reason, resultReply, uncertain, opening };
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.card.id.localeCompare(b.card.id)), [cards, sessions, links, evidences, actions, nativeSnapshots, nativeEventVersions, startTrials, selectedAccountScope]);

  const counts = {
    all: rows.length,
    attention: rows.filter((row) => row.group === 'attention').length,
    waiting_external: rows.filter((row) => row.card.state.waitState === 'waiting_external').length,
    paused: rows.filter((row) => row.card.state.waitState === 'paused').length,
  };
  const filteredRows = rows.filter((row) => waitFilter === 'all'
    || (waitFilter === 'attention' ? row.group === 'attention' : row.card.state.waitState === waitFilter));
  const visibleGroups = WORK_GROUPS.map((group) => ({ ...group, rows: filteredRows.filter((row) => row.group === group.key) }))
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
  const featureAction = featured?.uncertain ? '核对送达' : featured?.decision?.method === 'item/tool/requestUserInput' ? '回答问题'
    : featured?.decision || featured?.pending.length ? '查看请求' : featured?.group === 'results' ? '查看结果' : '查看阻碍';
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
      setCreateError('请填写完整的本地项目目录，例如 D:\\Repos\\RocketX。'); return;
    }
    const accountScope = resolveButlerAccountScope();
    const runtimeScope = useCodexWorkspace.getState().scope;
    const assertAccount = captureButlerAccountGeneration();
    const profileId = start ? startProfile?.id : undefined;
    if (start && !profileId) { setCreateError('请选择可用的 Codex 执行配置。'); return; }
    const request = useNewWorkDrafts.getState().begin(draftKey);
    if (!request) return;
    const target = newWorkTarget.current;
    const assertCurrentAccount = () => {
      assertAccount();
      if (resolveButlerAccountScope() !== accountScope || useCodexWorkspace.getState().scope !== runtimeScope) {
        throw new Error('账号或运行范围已切换，原工作保留，未继续保存目录。');
      }
    };
    try {
      const { goal, workspace } = request;
      const card = await useWorkLedger.getState().createCard({ requestId: request.id, title: goal.split('\n')[0].slice(0, 100), goal, stage: 'ready', priority: 3, projectKey: shortWorkspaceName(workspace) });
      assertCurrentAccount();
      await useWorkLedger.getState().upsertLink({ todoId: card.id, kind: 'kanban_card', externalId: card.id, project: card.state.projectKey,
        repo: workspace, rid: card.rid, headSha: null, title: '工作目录', webUrl: null, stateSnapshot: 'workspace' });
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
      if (!profileId) toast.success('工作和目录已记录，尚未开始执行。');
    } catch (error) { useNewWorkDrafts.getState().finish(draftKey, request.id, error instanceof Error ? error.message : String(error)); }
  };

  const renderRow = (row: typeof rows[number]) => {
    const { card, cardSessions, nativeProfile, observationKey, snapshot, latestEvidence, verifiedRecord, observedIssue, pending, group, project, source, summary, updatedAt, roots, reason } = row;
    const waiting = card.state.waitState !== 'none';
    const waitingLabel = WAIT_STATE_LABELS[card.state.waitState].label;
    const session = cardSessions[0];
    const status = snapshot?.admissionWait ? '等待执行条件'
      : group === 'active' ? snapshot?.runtimeStatus === 'running' ? '执行中' : '最近记录为执行中'
      : group === 'history' ? '历史标记已完成'
      : waiting ? waitingLabel
      : observedIssue ? observedIssue.runtimeStatus === 'error' ? '会话报告错误' : observedIssue.runtimeStatus === 'waiting_approval' ? '会话等待确认' : '会话等待输入'
      : pending.length ? '有待确认动作'
      : snapshot?.runtimeStatus === 'unknown' || snapshot?.connectionStatus === 'unknown' || !snapshot && (session?.runtimeStatus === 'unknown' || card.state.stage === 'in_progress') ? '执行状态未核实'
      : group === 'results' ? '有结果可查看' : '已收录';
    const actionLabel = group === 'attention' ? '查看并处理' : group === 'results' ? '查看结果' : '打开工作';
    const evidenceLabel = latestEvidence && (verifiedRecord ? `最近验证 · ${latestEvidence.passed ? '通过' : '未通过'}`
      : latestEvidence.kind === 'agent_report' ? '执行者说明 · 未核验' : '最近记录');
    const pendingStart = pendingInvestigation(snapshot);
    const situation = reason || snapshot?.admissionWait?.message || pendingStart || (row.opening ? '正在为这个项目准备调查' : null)
      || (group === 'stopped' ? '本轮已停止' : null) || (waiting ? waitingLabel : null)
      || latestEvidence?.summary || latestEvidence?.title || (group === 'results' && row.resultReply?.text) || summary || card.state.nextStep
      || (card.state.goal?.trim() !== card.title.trim() ? card.state.goal : null)
      || (group === 'history' ? '尚无当前验证记录' : !session && roots.length ? '目录已绑定，等待连接执行者' : '');
    const provenance = group !== 'stopped' && !reason && !pendingStart && !snapshot?.admissionWait && !waiting && (evidenceLabel || (summary && (snapshot ? '执行者回复 · 未核验' : '原会话摘要')));
    return <article key={card.id} data-card-id={card.id} className="work-first-row" data-selected={selectedCardId === card.id} data-tone={group === 'attention' ? 'attention' : group === 'active' ? 'active' : group === 'results' ? 'results' : 'default'}>
      <button type="button" data-work-id={card.id} aria-label={card.title} aria-pressed={selectedCardId === card.id}
        onClick={() => group === 'results' ? viewResult(row) : selectWork(card.id)} className="work-first-row-main text-left">
        <span className="work-first-row-title">{card.title}</span>
        {situation && <span className="work-first-row-summary">{situation}</span>}
        <span className="work-first-row-meta">
          <span title={roots.join('\n')}>{project}{card.adoWorkItemId ? ` · #${card.adoWorkItemId}` : ''}</span>
          {source !== '手动记录' && <span>{source}</span>}
          {provenance && <span>{provenance}</span>}
          {(status === '执行状态未核实' || status === '最近记录为执行中' || group === 'history') && <span>{status}</span>}
          <time title={`记录更新于${new Date(updatedAt).toLocaleString()}`}>{formatSessionRelativeTime(updatedAt)}</time>
          {card.priority <= 2 && <span className={card.priority === 1 ? 'text-danger' : 'text-warning'}>{card.priority === 1 ? '紧急' : '高优先级'}</span>}
        </span>
        {!(session && nativeProfile && parseWorkSessionProviderMeta(session).provider === 'codex') && <span className="work-first-row-action">{actionLabel}<ArrowRight size={14} aria-hidden="true" /></span>}
      </button>
      {session && nativeProfile && parseWorkSessionProviderMeta(session).provider === 'codex' && <NativeWorkCardControls card={card} session={session} observationKey={observationKey}
        allowStart={group === 'saved' || group === 'stopped'} onViewResult={group === 'results' ? () => viewResult(row) : undefined}
        onOpen={() => selectWork(card.id)} onSnapshot={(snapshot, observed) => updateNativeSnapshot(session.id, snapshot, observed)} />}
      {session && !(nativeProfile && parseWorkSessionProviderMeta(session).provider === 'codex') && <button type="button" disabled={actingSessionId === session.id} className="work-first-row-source"
        onClick={() => void handleOpenSession(session)} title={session.workspaceRoot}>
        <History size={13} aria-hidden="true" />
        {session.controlMode === 'readonly' ? '查看' : '打开'} {parseWorkSessionProviderMeta(session).label} 对话
      </button>}
    </article>;
  };

  return <div ref={boardRoot} className="work-first-board relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-surface-3">
    <header className="rcx-glass-header flex h-[52px] min-h-[52px] shrink-0 items-center justify-between gap-3 border-b border-line px-5">
      <div className="flex min-w-0 items-center gap-2">
        {butlerSidebarCollapsed ? <button type="button" onClick={toggleButlerSidebarCollapsed} title="展开会话列表 (Ctrl+B)" aria-label="展开会话列表" className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover"><PanelLeft size={16} /></button> : null}
        <h1 className="text-base font-semibold text-ink">我的工作</h1>
        <span className="text-xs text-ink-3">{cards.length}</span>
      </div>
      {!poolOpen && !selectedCard && <div className="work-board-entry-actions">
        <button type="button" className="work-first-secondary-button" onClick={() => setPoolOpen(true)}><History size={15} />添加已有会话</button>
        <button type="button" className="work-first-primary-button" onClick={() => showNewWork(true)}><Plus size={15} />新建工作</button>
      </div>}
    </header>
    <div ref={setToastViewport} className="max-h-[12%] shrink-0 overflow-y-auto" />
    {loading && !hydrated && <p role="status" className="shrink-0 px-5 py-2 text-sm text-ink-2">正在读取工作记录</p>}
    {lastError || sessionSyncError ? <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-5 py-2 text-xs text-ink">
      <span>{lastError || sessionSyncError}。当前显示缓存记录，最新状态与会话覆盖尚未确认。</span>
      <button type="button" aria-label="重试读取工作记录" className="shrink-0 text-primary hover:underline" onClick={() => { void hydrate(); if (sessionSyncError) void refreshSessions().catch(() => {}); }}>重试</button>
    </div> : !hydrated && !loading ? <div role="status" className="px-5 py-2 text-xs text-ink-2">尚未读取工作记录。<button type="button" onClick={() => void hydrate()} className="ml-2 text-primary">读取工作记录</button></div> : null}

    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={boardContent} className="work-first-board-content flex min-h-0 flex-1 flex-col">
        {poolOpen ? <div className="min-h-0 flex-1 overflow-auto p-5"><WorkSessionImport scanning={scanningSessions} scanError={sessionSyncError} onRefresh={refreshSessions}
          onSelectWork={(id) => { selectWork(id); setPoolOpen(false); }} onClose={() => setPoolOpen(false)} /></div> : <>
          {!newWorkOpen && rows.length > 0 && <section aria-label="管家简报" className="work-control-brief" data-tone={featured?.group}>
            <Bot size={19} aria-hidden="true" className="text-primary" />
            <div>
              {featured && <><div className="work-brief-source">{featured.group === 'attention' ? '需要你' : featured.verifiedRecord ? '验证通过' : '待核验'} · {featured.card.title}</div>
                <p>{featureText}</p></>}
              <div className="work-brief-counts">{activeCount > 0 ? `${activeCount} 项最近记录在推进` : '暂无已知执行中的工作'}{queuedCount > 0 && ` · ${queuedCount} 项排队中`}{counts.attention > 1 && ` · 另有 ${counts.attention - 1} 项需要你`}{resultsCount > 0 && ` · ${resultsCount} 项结果可看`}{counts.waiting_external > 0 && ` · ${counts.waiting_external} 项等待外部`}</div>
            </div>
            {featured && <button type="button" onClick={openFeatured}>{featureAction}<ArrowRight size={14} aria-hidden="true" /></button>}
          </section>}
          {newWorkOpen && <form aria-label="交代新工作" className="work-control-new" onKeyDown={event => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
          }} onSubmit={(event) => {
            event.preventDefault();
            void createWork(hasInvestigator);
          }}>
            <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium text-ink">新建工作</h2><button type="button" aria-label="收起，保留新工作草稿" onClick={() => showNewWork(false)} className="text-ink-3"><X size={17} /></button></div>
            <label className="work-control-field">要完成什么<textarea required value={newGoal} onChange={(event) => { newWorkTarget.current += 1; setNewGoal(event.target.value); }} placeholder="例如：调查登录失败，尝试修复并验证结果。" /></label>
            <div className="flex items-end gap-2"><label className="work-control-field min-w-0 flex-1">工作目录<input required value={newWorkspace} onChange={(event) => { newWorkTarget.current += 1; setNewWorkspace(event.target.value); }} placeholder="选择或填写项目目录" /></label><button type="button" disabled={choosingDirectory} onClick={() => void chooseWorkDirectory()} className="work-first-secondary-button shrink-0 disabled:opacity-50">{choosingDirectory ? '正在选择…' : '选择文件夹'}</button></div>
            {workspaceChoices.length > 0 && <select aria-label="选择已有项目目录" value="" onChange={(event) => { if (event.target.value) { newWorkTarget.current += 1; setNewWorkspace(event.target.value); } }} className="w-full rounded-lg border border-line bg-surface-3 px-3 py-2 text-xs text-ink-2"><option value="">选择已有项目目录…</option>{workspaceChoices.map((workspace) => <option key={workspace} value={workspace}>{shortWorkspaceName(workspace)} · {workspace}</option>)}</select>}
            {isTauriRuntime() && (startProfiles.length ? <WorkStartProfile profiles={startProfiles} value={startProfile?.id}
              onChange={profileId => useNewWorkDrafts.getState().edit(draftKey, { profileId })} />
              : <p className="text-xs text-ink-2">接入本机 Codex 后可以直接开始调查。 <button type="button" className="text-primary" onClick={() => openAcpHub(null)}>设置执行器</button></p>)}
            {createError && <p role="alert" className="text-xs text-danger">{createError}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type={hasInvestigator ? 'button' : 'submit'} onClick={hasInvestigator ? () => void createWork(false) : undefined} className={hasInvestigator ? 'work-first-secondary-button' : 'work-first-primary-button'} disabled={creating || !newGoal.trim() || !newWorkspace.trim()}>{creating ? '正在保存…' : '加入待开始'}</button>
              {hasInvestigator && <button type="submit" className="work-first-primary-button" disabled={creating || !startProfile || !newGoal.trim() || !newWorkspace.trim()}>开始调查</button>}
            </div>
          </form>}
          <div className="work-first-toolbar">
            <nav aria-label="工作状态筛选" className="flex flex-wrap items-center gap-1">
              {[
                { key: 'all' as const, label: '全部', count: counts.all },
                { key: 'attention' as const, label: '需我处理', count: counts.attention },
                { key: 'waiting_external' as const, label: '等待外部', count: counts.waiting_external },
                { key: 'paused' as const, label: '已暂停', count: counts.paused },
              ].map((item) => <button key={item.key} type="button" aria-pressed={waitFilter === item.key} onClick={() => setWaitFilter(item.key)} className="work-first-filter">{item.label}{item.count > 0 ? ` ${item.count}` : ''}</button>)}
            </nav>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setSearchOpen((value) => !value)} aria-expanded={searchOpen} aria-controls="work-first-search" className="work-first-view-button"><Search size={14} />查找</button>
            </div>
          </div>
          <div ref={searchContainer} id="work-first-search" hidden={!searchOpen} className="px-5 pb-3"><WorkContextSearch compact onSelectWork={selectWork} /></div>
          {orphanActions.length > 0 && <div role="status" className="px-5 pb-3 text-xs text-warning">有 {orphanActions.length} 项待决定动作尚未找到关联工作，请重新读取记录后查看。<button type="button" className="ml-2 text-primary" onClick={() => void hydrate()}>重新读取</button></div>}
          <div className="work-first-groups min-h-0 flex-1 overflow-y-auto">
            <div role="region" aria-label="工作看板" className="work-control-columns" data-layout={compactLayout ? 'list' : 'kanban'}>{visibleGroups.map((group) => {
              const groupRows = group.rows;
              return <section key={group.key} aria-label={group.label} className="work-first-group" data-empty={!groupRows.length} data-stage={group.key}>
                <div className="work-first-group-heading"><h2>{group.label}</h2><span>{groupRows.length}</span></div>
                {groupRows.map(renderRow)}
                {!groupRows.length && <p className="work-control-column-empty">{group.key === 'attention' ? '暂时没有需要你处理的事' : '暂无工作'}</p>}
              </section>;
            })}</div>
            {filteredRows.some((row) => row.group === 'history') && <details className="work-control-history"><summary>历史完成记录 {filteredRows.filter((row) => row.group === 'history').length}</summary><section aria-label="历史完成记录">{filteredRows.filter((row) => row.group === 'history').map(renderRow)}</section></details>}
            {filteredRows.length === 0 && hydrated && !loading && !lastError && !sessionSyncError && <div className="work-first-empty">
              <Inbox size={28} className="text-ink-3" />
              <h2 className="text-base font-medium text-ink">{cards.length ? '这个范围内没有工作' : '还没有工作记录'}</h2>
              <p className="text-sm text-ink-3">{cards.length ? '换一个筛选，继续查看其他工作。' : '交代一件新事情，或添加 Codex、Claude 等已有会话。'}</p>
              {cards.length > 0 && <button type="button" onClick={() => setWaitFilter('all')} className="text-sm text-primary">查看全部工作</button>}
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
