import {
  Archive,
  Bell,
  BookmarkCheck,
  Brain,
  Calendar,
  CheckCircle2,
  CheckSquare,
  Clock,
  Cpu,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  Layers,
  Loader2,
  MessageSquarePlus,
  Moon,
  PanelLeft,
  PauseCircle,
  Pin,
  PinOff,
  PlayCircle,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
  SquareKanban,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  buildAssistantAiSynthesisPrompt,
  generatePersonalAssistantBrief,
  saveAssistantSnapshotDigest,
  type PersonalAssistantBriefKind,
} from '../agent/personalAssistant';
import { executePreparedExternalAction, readExternalActionSpec } from '../agent/externalWorkActions';
import ButlerSkillsStudio from './ButlerSkillsStudio';
import ShareToRoomButton from './ShareToRoomButton';
import { writeButlerShareDrag, type ButlerSharePayload } from '../lib/butlerChatBridge';
import { useI18n, type MessageKey } from '../i18n';
import { formatDateTime } from '../i18n/format';
import { isTauriRuntime } from '../lib/client';
import { renderMarkdownDoc } from '../lib/markdown';
import type {
  ButlerAssistantDigest,
  ButlerMemoryCategory,
  ButlerMemoryEntry,
} from '../platform/desktopCommands';
import { useAcpAgents } from '../stores/acpAgents';
import { useButlerCognition } from '../stores/butlerCognition';
import { isMemoryCurrent, isMemoryInWorkspace, useButlerMemory, validateMemoryNoSecrets } from '../stores/butlerMemory';
import { useButlerSkills } from '../stores/butlerSkills';
import { useChat } from '../stores/chat';
import { useRoutines } from '../stores/routines';
import { useTodos } from '../stores/todos';
import { inspectNativeWorkspaceGit, type NativeWorkspaceGitSnapshot } from '../platform/desktopCommands';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import { useWorkLedger } from '../stores/workLedger';

const BRIEF_TABS: ReadonlyArray<{
  kind: PersonalAssistantBriefKind;
  labelKey: MessageKey;
  subtitleKey: MessageKey;
}> = [
  { kind: 'morning_brief', labelKey: 'butler.assistant.brief.morningLabel', subtitleKey: 'butler.assistant.brief.morningSubtitle' },
  { kind: 'evening_review', labelKey: 'butler.assistant.brief.eveningLabel', subtitleKey: 'butler.assistant.brief.eveningSubtitle' },
  { kind: 'focus_digest', labelKey: 'butler.assistant.brief.focusLabel', subtitleKey: 'butler.assistant.brief.focusSubtitle' },
];

const MEMORY_CATEGORIES: ReadonlyArray<{
  key: 'all' | ButlerMemoryCategory;
  labelKey: MessageKey;
  badgeClass: string;
}> = [
  { key: 'all', labelKey: 'butler.assistant.category.all', badgeClass: 'bg-fill-2 text-ink-2' },
  { key: 'preference', labelKey: 'butler.assistant.category.preference', badgeClass: 'bg-primary/10 text-primary' },
  { key: 'project_fact', labelKey: 'butler.assistant.category.projectFact', badgeClass: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300' },
  { key: 'workflow_habit', labelKey: 'butler.assistant.category.workflowHabit', badgeClass: 'bg-purple-500/12 text-purple-700 dark:text-purple-300' },
  { key: 'person_context', labelKey: 'butler.assistant.category.personContext', badgeClass: 'bg-amber-500/12 text-amber-700 dark:text-amber-300' },
  { key: 'episodic_summary', labelKey: 'butler.assistant.category.episodicSummary', badgeClass: 'bg-success/10 text-success' },
];

function categoryMeta(category: ButlerMemoryCategory): {
  key: string;
  labelKey?: MessageKey;
  fallbackLabel?: string;
  badgeClass: string;
} {
  return (
    MEMORY_CATEGORIES.find((c) => c.key === category) ?? {
      key: category,
      fallbackLabel: category,
      badgeClass: 'bg-fill-2 text-ink-2',
    }
  );
}

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

export default function ButlerAssistantCenter() {
  const { t, tp, locale } = useI18n();
  const setModule = useUI((state) => state.setModule);
  const setButlerView = useUI((state) => state.setButlerView);
  const openAcpHub = useUI((state) => state.openAcpHub);
  const butlerSidebarCollapsed = useUI((state) => state.butlerSidebarCollapsed);
  const toggleButlerSidebarCollapsed = useUI((state) => state.toggleButlerSidebarCollapsed);

  const memories = useButlerMemory((state) => state.memories);
  const digests = useButlerMemory((state) => state.digests);
  const memoryPaused = useButlerMemory((state) => state.memoryPaused);
  const loading = useButlerMemory((state) => state.loading);
  const hydrateMemory = useButlerMemory((state) => state.hydrate);
  const setMemoryPaused = useButlerMemory((state) => state.setMemoryPaused);
  const upsertMemory = useButlerMemory((state) => state.upsertMemory);
  const correctMemory = useButlerMemory((state) => state.correctMemory);
  const expireMemory = useButlerMemory((state) => state.expireMemory);
  const accountScope = useButlerMemory((state) => state.accountScope);
  const deleteMemory = useButlerMemory((state) => state.deleteMemory);
  const togglePin = useButlerMemory((state) => state.togglePin);
  const toggleEnabled = useButlerMemory((state) => state.toggleEnabled);
  const clearScope = useButlerMemory((state) => state.clearScope);
  const deleteDigest = useButlerMemory((state) => state.deleteDigest);

  const acpAgents = useAcpAgents((state) => state.agents);
  const acpSessionsMap = useAcpAgents((state) => state.sessions);
  const setActiveAcpSession = useAcpAgents((state) => state.setActiveSession);
  const hydrateAcp = useAcpAgents((state) => state.hydrate);
  const startAcpSession = useAcpAgents((state) => state.startSession);
  const sendAcpPrompt = useAcpAgents((state) => state.sendPrompt);

  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const butlerWorkspaceRoot = useCodexWorkspace((state) => state.butlerWorkspaceRoot);
  const defaultWorkspaceRoot = useCodexWorkspace((state) => state.defaultWorkspaceRoot);
  const hydrateLedger = useWorkLedger((state) => state.hydrate);
  const ledgerActions = useWorkLedger((state) => state.actions);
  const transitionDispatchAction = useWorkLedger((state) => state.transitionDispatchAction);

  const sectionTab = useUI((state) => state.assistantTab);
  const setSectionTab = useUI((state) => state.setAssistantTab);
  const hydrateCognition = useButlerCognition((state) => state.hydrate);
  const ambientEnabled = useButlerCognition((state) => state.ambientEnabled);
  const dreamEnabled = useButlerCognition((state) => state.dreamEnabled);
  const setAmbientEnabled = useButlerCognition((state) => state.setAmbientEnabled);
  const setDreamEnabled = useButlerCognition((state) => state.setDreamEnabled);
  const ambientRunning = useButlerCognition((state) => state.ambientRunning);
  const dreamRunning = useButlerCognition((state) => state.dreamRunning);
  const cognitionObservations = useButlerCognition((state) => state.observations);
  const cognitionWatchpoints = useButlerCognition((state) => state.watchpoints);
  const cognitionInsights = useButlerCognition((state) => state.insights);
  const dreamJournal = useButlerCognition((state) => state.dreamJournal);
  const lastUserActivityAt = useButlerCognition((state) => state.lastUserActivityAt);
  const lastAmbientWakeAt = useButlerCognition((state) => state.lastAmbientWakeAt);
  const lastDreamDate = useButlerCognition((state) => state.lastDreamDate);
  const runAmbientTurn = useButlerCognition((state) => state.runAmbientTurn);
  const runDreamNow = useButlerCognition((state) => state.runDreamNow);
  const rollbackDreamEntry = useButlerCognition((state) => state.rollbackDreamEntry);
  const cancelWatchpoint = useButlerCognition((state) => state.cancelWatchpoint);
  const markInsightFeedback = useButlerCognition((state) => state.markInsightFeedback);

  const allSkills = useButlerSkills((state) => state.skills);
  const skillsCount = allSkills.length;
  const hydrateSkills = useButlerSkills((state) => state.hydrate);
  const routines = useRoutines((state) => state.routines);
  const hydrateRoutines = useRoutines((state) => state.hydrate);
  const [gitInspect, setGitInspect] = useState<NativeWorkspaceGitSnapshot | null>(null);
  const [briefKind, setBriefKind] = useState<PersonalAssistantBriefKind>(() =>
    new Date().getHours() >= 17 ? 'evening_review' : 'morning_brief',
  );
  const [refreshTick, setRefreshTick] = useState(0);
  const [savingDigest, setSavingDigest] = useState(false);
  const [sendingToButler, setSendingToButler] = useState(false);
  const [dispatchingAcp, setDispatchingAcp] = useState(false);
  const [selectedAcpAgentId, setSelectedAcpAgentId] = useState<string>('');
  const [selectedDigest, setSelectedDigest] = useState<ButlerAssistantDigest | null>(null);

  // Memory Vault states
  const [memoryQuery, setMemoryQuery] = useState('');
  const [showMemoryHistory, setShowMemoryHistory] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<'all' | ButlerMemoryCategory>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [memTitle, setMemTitle] = useState('');
  const [memCategory, setMemCategory] = useState<ButlerMemoryCategory>('preference');
  const [memContent, setMemContent] = useState('');
  const [memTags, setMemTags] = useState('');
  const [memWorkspace, setMemWorkspace] = useState('');
  const [memPinned, setMemPinned] = useState(false);
  const [savingMem, setSavingMem] = useState(false);
  const [confirmClearScope, setConfirmClearScope] = useState(false);

  useEffect(() => {
    hydrateCognition();
    void hydrateMemory();
    void hydrateSkills();
    hydrateRoutines();
    void hydrateAcp();
    void hydrateLedger();
  }, [hydrateAcp, hydrateCognition, hydrateLedger, hydrateMemory, hydrateRoutines, hydrateSkills]);

  const effectiveWorkspace =
    workspaceRoot || butlerWorkspaceRoot || defaultWorkspaceRoot || '';

  useEffect(() => {
    if (!isTauriRuntime() || !effectiveWorkspace.trim()) {
      setGitInspect(null);
      return;
    }
    let cancelled = false;
    void inspectNativeWorkspaceGit(effectiveWorkspace)
      .then((info: NativeWorkspaceGitSnapshot) => {
        if (!cancelled) setGitInspect(info);
      })
      .catch(() => {
        if (!cancelled) setGitInspect(null);
      });
    return () => { cancelled = true; };
  }, [effectiveWorkspace, refreshTick]);

  const enabledAcpAgents = useMemo(
    () => acpAgents.filter((a) => a.enabled),
    [acpAgents],
  );
  const resolvedAcpAgentId =
    selectedAcpAgentId || enabledAcpAgents[0]?.id || acpAgents[0]?.id || '';

  const snapshot = useMemo(() => {
    void refreshTick;
    return generatePersonalAssistantBrief(briefKind, new Date(), effectiveWorkspace);
  }, [briefKind, effectiveWorkspace, refreshTick, memories, memoryPaused]);

  const filteredMemories = useMemo(() => {
    const q = memoryQuery.trim().toLowerCase();
    return memories.filter((m) => {
      if (m.accountScope !== accountScope || !isMemoryInWorkspace(m, effectiveWorkspace)) return false;
      if (!showMemoryHistory && !isMemoryCurrent(m)) return false;
      if (categoryFilter !== 'all' && m.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        m.title.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q)) ||
        (m.workspaceRoot?.toLowerCase().includes(q) ?? false) ||
        (m.sourceRef?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [accountScope, categoryFilter, effectiveWorkspace, memories, memoryQuery, showMemoryHistory]);

  const secretCheck = useMemo(
    () => validateMemoryNoSecrets(`${memTitle}\n${memContent}`),
    [memContent, memTitle],
  );

  const openNewMemoryEditor = () => {
    setEditingId(null);
    setMemTitle('');
    setMemCategory('preference');
    setMemContent('');
    setMemTags('');
    setMemWorkspace(effectiveWorkspace);
    setMemPinned(false);
    setEditorOpen(true);
  };

  const openEditMemoryEditor = (entry: ButlerMemoryEntry) => {
    setEditingId(entry.id);
    setMemTitle(entry.title);
    setMemCategory(entry.category);
    setMemContent(entry.content);
    setMemTags(entry.tags.join(', '));
    setMemWorkspace(entry.workspaceRoot ?? '');
    setMemPinned(entry.pinned);
    setEditorOpen(true);
  };

  const handleSaveMemory = async (event: FormEvent) => {
    event.preventDefault();
    if (!memTitle.trim() || !memContent.trim()) {
      toast.error(t('butler.assistant.memoryValidationRequired'));
      return;
    }
    if (!secretCheck.ok) {
      toast.error(secretCheck.reason || t('butler.assistant.memorySecretBlocked'));
      return;
    }
    setSavingMem(true);
    try {
      const tags = memTags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const fields = {
        category: memCategory,
        title: memTitle.trim(),
        content: memContent.trim(),
        tags,
        workspaceRoot: memWorkspace.trim() || null,
        pinned: memPinned,
      };
      if (editingId) await correctMemory(editingId, fields);
      else await upsertMemory({ ...fields, sourceKind: 'manual', enabled: true });
      setEditorOpen(false);
      toast.success(t(editingId ? 'butler.assistant.memoryCorrected' : 'butler.assistant.memorySaved'));
    } catch (error) {
      toast.error(error, t('butler.assistant.memorySaveFailed'));
    } finally {
      setSavingMem(false);
    }
  };

  const handleSaveDigest = async () => {
    setSavingDigest(true);
    try {
      const saved = await saveAssistantSnapshotDigest(snapshot);
      setSelectedDigest(saved);
      toast.success(t('butler.assistant.digestArchived'));
    } catch (error) {
      toast.error(error, t('butler.assistant.digestArchiveFailed'));
    } finally {
      setSavingDigest(false);
    }
  };

  const handleSendToButler = async () => {
    setSendingToButler(true);
    try {
      const prompt = buildAssistantAiSynthesisPrompt(snapshot);
      const ws = useCodexWorkspace.getState();
      if (isTauriRuntime() && ws.status === 'ready') {
        await ws.startTask(prompt, snapshot.title);
        setButlerView('conversation');
        toast.success(t('butler.assistant.handoffStarted'));
      } else {
        ws.setComposerDraft(prompt);
        setButlerView('conversation');
        toast.info(t('butler.assistant.handoffDrafted'));
      }
    } catch (error) {
      toast.error(error, t('butler.assistant.handoffFailed'));
    } finally {
      setSendingToButler(false);
    }
  };

  const handleDispatchToAcp = async () => {
    if (!resolvedAcpAgentId) {
      openAcpHub(null);
      toast.info(t('butler.assistant.acpNoAgent'));
      return;
    }
    if (!effectiveWorkspace) {
      openAcpHub(resolvedAcpAgentId);
      toast.info(t('butler.assistant.acpNoWorkspace'));
      return;
    }
    setDispatchingAcp(true);
    try {
      const prompt = buildAssistantAiSynthesisPrompt(snapshot);
      const session = await startAcpSession({
        agentId: resolvedAcpAgentId,
        workspaceRoot: effectiveWorkspace,
        autonomyMode: 'confirm',
        title: snapshot.title,
      });
      openAcpHub(resolvedAcpAgentId);
      void sendAcpPrompt(session.sessionKey, prompt, { injectMemory: true }).catch((err) => {
        toast.error(err, t('butler.assistant.acpRunFailed'));
      });
      toast.success(t('butler.assistant.acpDispatched', { agentName: session.agentName }));
    } catch (error) {
      toast.error(error, t('butler.assistant.acpDispatchFailed'));
    } finally {
      setDispatchingAcp(false);
    }
  };

  const askButlerAbout = (prompt: string, taskTitle: string) => {
    const ws = useCodexWorkspace.getState();
    if (isTauriRuntime() && ws.status === 'ready') {
      void ws.startTask(prompt, taskTitle).then(() => {
        setButlerView('conversation');
        toast.success(t('butler.assistant.handoffStarted'));
      }).catch((err) => toast.error(err, t('butler.assistant.handoffFailed')));
    } else {
      ws.setComposerDraft(prompt);
      setButlerView('conversation');
      toast.info(t('butler.assistant.handoffDrafted'));
    }
  };

  const unreadInsights = useMemo(
    () => cognitionInsights.filter((item) => item.status === 'unread' && item.level !== 'silent_log'),
    [cognitionInsights],
  );
  const armedWatchpoints = useMemo(
    () => cognitionWatchpoints.filter((item) => item.status === 'armed'),
    [cognitionWatchpoints],
  );
  const unconsumedObsCount = useMemo(
    () => cognitionObservations.filter((item) => !item.consumedAt).length,
    [cognitionObservations],
  );

  const activeRoutinesCount = useMemo(
    () => routines.filter((r) => r.enabled && !r.workTemplate).length,
    [routines],
  );
  const unreadRoutineRunsCount = useMemo(
    () => routines.reduce((sum, r) => sum + r.runs.filter((run) => !run.archived && !run.readAt).length, 0),
    [routines],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-surface-3">
      {/* 顶部栏：与管家/ACP 工作台等高齐平的 52px 栏 */}
      <header className="rcx-glass-header flex h-[52px] min-h-[52px] shrink-0 items-center justify-between gap-3 border-b border-line bg-surface-3 px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          {butlerSidebarCollapsed ? (
            <button
              type="button"
              onClick={toggleButlerSidebarCollapsed}
              title={t('butler.sidebar.expandTitle')}
              aria-label={t('butler.sidebar.expandAria')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
            >
              <PanelLeft size={16} />
            </button>
          ) : null}
          <Sparkles size={16} className="shrink-0 text-primary" />
          <h1 className="truncate text-sm font-semibold text-ink">{t('butler.assistant.title')}</h1>
          <span
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-4 px-2.5 py-0.5 text-2xs font-medium text-ink-2"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${memoryPaused ? 'bg-warning' : 'bg-success'}`} />
            <span>{memoryPaused ? t('butler.assistant.memoryPausedBadge') : t('butler.assistant.memoryOnlineBadge', { count: snapshot.metrics.memoryCount })}</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* 隐私暂停开关 */}
          <button
            type="button"
            onClick={() => {
              setMemoryPaused(!memoryPaused);
              toast.info(
                t(!memoryPaused ? 'butler.assistant.memoryPausedToast' : 'butler.assistant.memoryResumedToast'),
              );
            }}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
              memoryPaused
                ? 'border-warning/40 bg-warning/10 text-warning'
                : 'border-line bg-surface-4 text-ink-2 shadow-raise hover:bg-fill-hover hover:text-ink'
            }`}
            title={t('butler.assistant.memoryPauseTitle')}
          >
            {memoryPaused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
            <span>{t(memoryPaused ? 'butler.assistant.resumeMemory' : 'butler.assistant.pauseMemory')}</span>
          </button>

          {/* 主分栏切换 */}
          <div className="flex items-center rounded-lg border border-line-soft bg-surface-2 p-0.5 text-xs">
            {[
              { id: 'briefing' as const, label: t('butler.assistant.tabBriefing'), icon: Sparkles },
              {
                id: 'cognition' as const,
                label: unreadInsights.length > 0
                  ? t('butler.assistant.tabCognitionUnread', { count: unreadInsights.length })
                  : t('butler.assistant.tabCognition'),
                icon: Radar,
              },
              { id: 'skills' as const, label: t('butler.assistant.tabSkills', { count: skillsCount }), icon: Wand2 },
              { id: 'memories' as const, label: t('butler.assistant.tabMemories', { count: memories.length }), icon: Brain },
              { id: 'archive' as const, label: t('butler.assistant.tabArchive', { count: digests.length }), icon: History },
            ].map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSectionTab(tab.id)}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition ${
                    sectionTab === tab.id
                      ? 'bg-surface-4 font-semibold text-ink shadow-raise'
                      : 'text-ink-3 hover:text-ink'
                  }`}
                >
                  <Icon size={12} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* 主内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        {sectionTab === 'briefing' && (
          <div className="space-y-4">
            {unreadInsights.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-2.5 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <Radar size={14} className="shrink-0 text-primary" />
                  <span className="font-semibold text-ink">
                    {t('butler.cognition.briefingBanner', {
                      count: unreadInsights.length,
                      topTitle: unreadInsights[0].title,
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSectionTab('cognition')}
                  className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white transition hover:bg-primary-hover"
                >
                  {t('butler.cognition.openInbox')}
                </button>
              </div>
            )}
            {/* 模式切换 + 操作工具条 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface-3 p-3 shadow-raise">
              <div className="flex flex-wrap items-center gap-1.5">
                {BRIEF_TABS.map((item) => (
                  <button
                    key={item.kind}
                    type="button"
                    onClick={() => setBriefKind(item.kind)}
                    className={`rounded-xl border px-3 py-1.5 text-left transition ${
                      briefKind === item.kind
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-line-soft bg-surface-4 text-ink-2 hover:bg-fill-hover'
                    }`}
                  >
                    <div className="text-xs font-semibold">{t(item.labelKey)}</div>
                    <div className="text-xs opacity-75">{t(item.subtitleKey)}</div>
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRefreshTick((t) => t + 1)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs font-medium text-ink-2 shadow-raise transition hover:bg-fill-hover hover:text-ink"
                >
                  <RefreshCw size={12} />
                  <span>{t('butler.assistant.refreshSnapshot')}</span>
                </button>

                <button
                  type="button"
                  disabled={savingDigest}
                  onClick={() => void handleSaveDigest()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs font-medium text-ink shadow-raise transition hover:bg-fill-hover disabled:opacity-50"
                >
                  <BookmarkCheck size={12} className="text-success" />
                  <span>{t(savingDigest ? 'butler.assistant.archivingDigest' : 'butler.assistant.saveArchive')}</span>
                </button>

                <button
                  type="button"
                  disabled={sendingToButler}
                  onClick={() => void handleSendToButler()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
                >
                  {sendingToButler ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  <span>{t('butler.assistant.sendToButler')}</span>
                </button>

                <div className="flex items-center gap-1">
                  {acpAgents.length > 1 && (
                    <select
                      aria-label={t('butler.assistant.selectAcpClientAria')}
                      value={resolvedAcpAgentId}
                      onChange={(e) => setSelectedAcpAgentId(e.target.value)}
                      className="h-8 rounded-xl border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
                    >
                      {acpAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={dispatchingAcp}
                    onClick={() => void handleDispatchToAcp()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-medium text-purple-500 shadow-raise transition hover:bg-purple-500/20 disabled:opacity-50"
                  >
                    {dispatchingAcp ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Cpu size={12} />
                    )}
                    <span>{t('butler.assistant.dispatchAcp')}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Bento 指标卡 */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-2xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="text-xs text-ink-3">{t('butler.assistant.metricOpenTodos')}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-lg font-bold text-ink">{snapshot.metrics.openTodos}</span>
                  {snapshot.metrics.overdueTodos > 0 && (
                    <span className="rounded-full bg-danger/15 px-2 py-0.5 text-2xs font-medium text-danger">
                      {t('butler.assistant.metricOverdue', { count: snapshot.metrics.overdueTodos })}
                    </span>
                  )}
                  {snapshot.metrics.dueTodayTodos > 0 && (
                    <span className="rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning">
                      {t('butler.assistant.metricDueToday', { count: snapshot.metrics.dueTodayTodos })}
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="text-xs text-ink-3">{t('butler.assistant.metricTodayEvents')}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-lg font-bold text-ink">{snapshot.metrics.todayEvents}</span>
                  <span className="text-xs text-ink-3">
                    {t('butler.assistant.metricCompletedEvents', { count: snapshot.metrics.completedTodayEvents })}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="text-xs text-ink-3">{t('butler.assistant.metricActiveWorkflows')}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-lg font-bold text-ink">{snapshot.metrics.activeWorkflows}</span>
                  <span className="text-xs text-ink-3">
                    {t('butler.assistant.metricAcpAndBlocked', {
                      acp: snapshot.metrics.acpActiveSessions,
                      blocked: snapshot.metrics.blockedCount,
                    })}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="text-xs text-ink-3">{t('butler.assistant.metricWaitingApproval')}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span
                    className={`text-lg font-bold ${
                      snapshot.metrics.waitingApprovalCount > 0 ? 'text-warning' : 'text-ink'
                    }`}
                  >
                    {snapshot.metrics.waitingApprovalCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setButlerView('kanban')}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <SquareKanban size={11} />
                    {t('butler.assistant.viewBoard')}
                  </button>
                </div>
              </div>
            </div>

            {/* 主动哨兵 Watchers 条 */}
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface-3 px-3.5 py-2.5 text-xs shadow-raise">
              <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                <Bell size={13} className="text-primary" />
                <span>{t('butler.assistant.watchersTitle')}</span>
              </span>
              <button
                type="button"
                onClick={() => setButlerView('kanban')}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-4 px-2.5 py-1 text-xs text-ink-2 transition hover:border-primary/40 hover:text-ink"
              >
                <SquareKanban size={11} className="text-warning" />
                <span>
                  {t('butler.assistant.watcherWorkSummary', {
                    blocked: snapshot.metrics.blockedCount,
                    approval: snapshot.metrics.waitingApprovalCount,
                  })}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setButlerView('routines')}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-4 px-2.5 py-1 text-xs text-ink-2 transition hover:border-primary/40 hover:text-ink"
              >
                <Clock size={11} className="text-primary" />
                <span>
                  {t('butler.assistant.watcherRoutineSummary', {
                    active: activeRoutinesCount,
                    unread: unreadRoutineRunsCount,
                  })}
                </span>
              </button>
              {gitInspect?.repoTopLevel ? (
                <button
                  type="button"
                  onClick={() =>
                    askButlerAbout(
                      `Inspect dirty working tree changes on branch ${gitInspect.branch || 'HEAD'} (${gitInspect.dirtyFiles.length} changed files) and summarize risks.`,
                      t('butler.assistant.watcherGitTitle'),
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-4 px-2.5 py-1 text-xs text-ink-2 transition hover:border-primary/40 hover:text-ink"
                >
                  <GitBranch size={11} className="text-success" />
                  <span>
                    {t('butler.assistant.watcherGitSummary', {
                      branch: gitInspect.branch || 'HEAD',
                      dirty: gitInspect.dirtyFiles.length,
                    })}
                  </span>
                </button>
              ) : null}
            </div>

            {/* 三栏结构化简报明细 */}
            <div className="grid gap-4 lg:grid-cols-3">
              {/* 左栏：焦点任务与承诺 */}
              <div className="space-y-4 lg:col-span-2">
                <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <Layers size={14} className="text-primary" />
                      <span>{t('butler.assistant.focusItemsTitle')}</span>
                    </h2>
                    <span className="text-xs text-ink-3">{tp(snapshot.focusItems.length, 'butler.assistant.itemCountOne', 'butler.assistant.itemCountOther')}</span>
                  </div>
                  {snapshot.focusItems.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-ink-3">
                      {t('butler.assistant.noFocusItems')}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {snapshot.focusItems.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-line-soft bg-surface-4 px-3 py-2.5 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-semibold text-ink">{item.title}</div>
                            <div className="mt-0.5 text-xs text-ink-3">{item.reason}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className="rounded-full bg-fill-2 px-2 py-0.5 text-2xs font-medium text-ink-2">
                              P{item.priority}
                            </span>
                            {item.stage && (
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">
                                {item.stage}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                askButlerAbout(
                                  `Help advance focus item "${item.title}" (${item.reason}) and propose the next concrete step.`,
                                  item.title,
                                )
                              }
                              title={t('butler.assistant.askButlerItem')}
                              className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary transition hover:bg-primary/20"
                            >
                              <MessageSquarePlus size={11} />
                              <span>{t('butler.assistant.askButlerItem')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setButlerView('kanban')}
                              title={t('butler.assistant.viewBoard')}
                              className="rounded-md border border-line bg-surface-3 px-2 py-0.5 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-ink"
                            >
                              {t('butler.assistant.viewBoard')}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* 承诺与协同 + 下一步行动 */}
                <div className="grid gap-4 md:grid-cols-2">
                  <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                    <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <Clock size={14} className="text-warning" />
                      <span>{t('butler.assistant.commitmentsTitle')}</span>
                    </h2>
                    {snapshot.commitments.length === 0 ? (
                      <p className="text-xs text-ink-3">{t('butler.assistant.noCommitments')}</p>
                    ) : (
                      <div className="space-y-2">
                        {snapshot.commitments.map((c, idx) => (
                          <div
                            key={`${c.todoId}-${idx}`}
                            className="rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
                                  c.direction === 'committed_to'
                                    ? 'bg-primary/10 text-primary'
                                    : 'bg-warning/15 text-warning'
                                }`}
                              >
                                {c.direction === 'committed_to'
                                  ? t('butler.assistant.committedTo', { person: c.person })
                                  : t('butler.assistant.waitingFor', { person: c.person })}
                              </span>
                              {c.due && <span className="text-xs text-ink-3">{t('butler.assistant.duePrefix', { due: c.due })}</span>}
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-2">
                              <span className="truncate font-medium text-ink">{c.title}</span>
                              <button
                                type="button"
                                onClick={() =>
                                  askButlerAbout(
                                    `Draft a concise status follow-up with ${c.person} regarding "${c.title}"${c.due ? ` (due ${c.due})` : ''}.`,
                                    c.title,
                                  )
                                }
                                className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs text-primary hover:bg-primary/20"
                              >
                                {t('butler.assistant.followUpItem')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                    <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <CheckCircle2 size={14} className="text-success" />
                      <span>{t('butler.assistant.actionItemsTitle')}</span>
                    </h2>
                    <ul className="space-y-2 text-xs text-ink-2">
                      {snapshot.actionItems.map((act, idx) => (
                        <li
                          key={idx}
                          className="flex items-start justify-between gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2"
                        >
                          <div className="flex min-w-0 items-start gap-2">
                            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                            <span>{act}</span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                useTodos.getState().add({ title: act, source: 'manual', priority: 2 });
                                toast.success(t('butler.assistant.todoAddedFromBriefing'));
                              }}
                              title={t('butler.assistant.createTodoItem')}
                              className="inline-flex items-center gap-1 rounded border border-line bg-surface-3 px-1.5 py-0.5 text-xs text-ink-2 transition hover:border-primary/40 hover:text-primary"
                            >
                              <CheckSquare size={11} />
                              <span>{t('butler.assistant.createTodoItem')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => askButlerAbout(`Execute action item: ${act}`, act.slice(0, 48))}
                              title={t('butler.assistant.askButlerItem')}
                              className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs text-primary transition hover:bg-primary/20"
                            >
                              {t('butler.assistant.askButlerItem')}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              </div>

              {/* 右栏：今日日程、活跃会话、已召回记忆 */}
              <div className="space-y-4">
                <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                  <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Calendar size={14} className="text-primary" />
                    <span>{t('butler.assistant.scheduleTitle')}</span>
                  </h2>
                  {snapshot.schedule.length === 0 ? (
                    <p className="text-xs text-ink-3">{t('butler.assistant.noSchedule')}</p>
                  ) : (
                    <div className="space-y-1.5">
                      {snapshot.schedule.map((ev) => (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs"
                        >
                          <span className={ev.done ? 'text-ink-3 line-through' : 'font-medium text-ink'}>
                            {ev.title}
                          </span>
                          <span className="shrink-0 text-xs text-ink-3">
                            {ev.allDay
                              ? t('butler.assistant.allDay')
                              : [ev.startTime, ev.endTime].filter(Boolean).join('-') || t('butler.assistant.allDay')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <Brain size={14} className="text-primary" />
                      <span>{t('butler.assistant.pinnedMemoriesTitle')}</span>
                    </h2>
                    <button
                      type="button"
                      onClick={() => setSectionTab('memories')}
                      className="text-xs text-primary hover:underline"
                    >
                      {t('butler.assistant.openMemoryVault')}
                    </button>
                  </div>
                  {memoryPaused ? (
                    <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                      {t('butler.assistant.memoryPausedNotice')}
                    </div>
                  ) : snapshot.relevantMemories.length === 0 ? (
                    <p className="text-xs text-ink-3">{t('butler.assistant.noRelevantMemories')}</p>
                  ) : (
                    <div className="space-y-1.5">
                      {snapshot.relevantMemories.map((m) => {
                        const meta = categoryMeta(m.category);
                        return (
                          <div
                            key={m.id}
                            className="rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-semibold text-ink">{m.title}</span>
                              <span
                                className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${meta.badgeClass}`}
                              >
                                {meta.labelKey ? t(meta.labelKey) : meta.fallbackLabel}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-ink-3">{m.content}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>
        )}

        {sectionTab === 'cognition' && (
          <div className="space-y-4">
            {/* 主动感知与 Dream 控制条 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface-3 p-4 shadow-raise">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Radar size={15} className="text-primary" />
                  <h2 className="text-sm font-semibold text-ink">{t('butler.cognition.heading')}</h2>
                  <span className="rounded-full bg-fill-1 px-2 py-0.5 text-xs text-ink-2">
                    {t('butler.cognition.statsBadge', {
                      obs: unconsumedObsCount,
                      wp: armedWatchpoints.length,
                    })}
                  </span>
                </div>
                <p className="text-xs text-ink-3">
                  {t('butler.cognition.subtitle', {
                    lastActive: lastUserActivityAt > 0
                      ? formatDateTime(lastUserActivityAt, DATE_TIME_OPTIONS, locale)
                      : t('butler.cognition.neverLabel'),
                    lastWake: lastAmbientWakeAt > 0
                      ? formatDateTime(lastAmbientWakeAt, DATE_TIME_OPTIONS, locale)
                      : t('butler.cognition.neverLabel'),
                    lastDream: lastDreamDate ?? t('butler.cognition.neverLabel'),
                  })}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAmbientEnabled(!ambientEnabled)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition ${
                    ambientEnabled
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-line bg-surface-4 text-ink-3 hover:text-ink'
                  }`}
                >
                  <Radar size={12} />
                  <span>{t(ambientEnabled ? 'butler.cognition.ambientOn' : 'butler.cognition.ambientOff')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDreamEnabled(!dreamEnabled)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition ${
                    dreamEnabled
                      ? 'border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-300'
                      : 'border-line bg-surface-4 text-ink-3 hover:text-ink'
                  }`}
                >
                  <Moon size={12} />
                  <span>{t(dreamEnabled ? 'butler.cognition.dreamOn' : 'butler.cognition.dreamOff')}</span>
                </button>

                <button
                  type="button"
                  disabled={ambientRunning}
                  onClick={() => {
                    void runAmbientTurn('manual').then((res) => {
                      if (res.ran) toast.success(t('butler.cognition.pulseDone'));
                      else toast.info(res.output || t('butler.cognition.pulseSkipped'));
                    });
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 text-xs font-medium text-ink shadow-raise transition hover:bg-fill-hover disabled:opacity-50"
                >
                  {ambientRunning ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />}
                  <span>{t('butler.cognition.runPulseNow')}</span>
                </button>

                <button
                  type="button"
                  disabled={dreamRunning}
                  onClick={() => {
                    void runDreamNow().then((entry) => {
                      toast.success(
                        t('butler.cognition.dreamDone', {
                          merged: entry.memoriesConsolidated,
                          skills: entry.skillsEvolved,
                        }),
                      );
                    }).catch((err) => toast.error(err, t('butler.cognition.dreamFailed')));
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
                >
                  {dreamRunning ? <Loader2 size={12} className="animate-spin" /> : <Moon size={12} />}
                  <span>{t('butler.cognition.runDreamNow')}</span>
                </button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {/* 主动注意力收件箱 */}
              <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-raise">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                    <Bell size={14} className="text-primary" />
                    <span>{t('butler.cognition.inboxTitle')}</span>
                  </h3>
                  <span className="text-xs text-ink-3">
                    {t('butler.cognition.unreadCount', { count: unreadInsights.length })}
                  </span>
                </div>

                {cognitionInsights.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-ink-3">
                    {t('butler.cognition.inboxEmpty')}
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {cognitionInsights.slice(0, 12).map((item) => {
                      const sharePayload: ButlerSharePayload = {
                        kind: 'insight',
                        id: item.id,
                        insightKind: item.kind,
                        title: item.title,
                        summary: item.summary,
                        suggestedActions: item.suggestedActions?.map((a) => a.label),
                        ref: item.ref,
                      };
                      const pendingAction = item.ref?.actionId
                        ? ledgerActions.find(
                            (a) => a.id === item.ref?.actionId && a.state === 'awaiting_approval',
                          )
                        : undefined;
                      const refAcpSession = item.ref?.sessionKey
                        ? acpSessionsMap[item.ref.sessionKey]
                        : undefined;

                      return (
                      <article
                        key={item.id}
                        draggable
                        onDragStart={(e) => writeButlerShareDrag(e.dataTransfer, sharePayload)}
                        className={`rounded-xl border p-3 transition ${
                          item.status === 'unread'
                            ? 'border-primary/35 bg-primary/5'
                            : 'border-line-soft bg-surface-4 opacity-80'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
                              {t(`butler.cognition.kind.${item.kind}`)}
                            </span>
                            <span className="truncate text-xs font-semibold text-ink">{item.title}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <ShareToRoomButton payload={sharePayload} compact />
                            <span className="text-xs text-ink-3">
                              {formatDateTime(item.createdAt, DATE_TIME_OPTIONS, locale)}
                            </span>
                          </div>
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-2">
                          {item.summary}
                        </p>
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {(item.suggestedActions ?? []).map((act, idx) => (
                            <button
                              key={`${item.id}:act:${idx}`}
                              type="button"
                              onClick={() => {
                                markInsightFeedback(item.id, 'acted');
                                if (act.prompt) {
                                  askButlerAbout(act.prompt, act.label);
                                }
                              }}
                              className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white transition hover:bg-primary-hover"
                            >
                              {act.label}
                            </button>
                          ))}
                          {!item.suggestedActions?.length && item.status === 'unread' && (
                            <button
                              type="button"
                              onClick={() => {
                                markInsightFeedback(item.id, 'acted');
                                askButlerAbout(`${item.title}\n\n${item.summary}`, item.title);
                              }}
                              className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white transition hover:bg-primary-hover"
                            >
                              {t('butler.cognition.handleInButler')}
                            </button>
                          )}
                          {pendingAction ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  markInsightFeedback(item.id, 'acted');
                                  const isExternal = Boolean(readExternalActionSpec(pendingAction));
                                  const actionPromise = isExternal
                                    ? executePreparedExternalAction(pendingAction.id, true)
                                    : transitionDispatchAction({
                                        id: pendingAction.id,
                                        state: 'prepared',
                                        expectedState: 'awaiting_approval',
                                      });
                                  void actionPromise
                                    .then(() => toast.success(t('butler.cognition.actionApprovedToast')))
                                    .catch((err) => toast.error(err));
                                }}
                                className="rounded-lg border border-success/40 bg-success/15 px-2 py-1 text-xs font-medium text-success hover:bg-success/25"
                              >
                                {t('butler.cognition.approveAction')}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  markInsightFeedback(item.id, 'dismissed');
                                  void transitionDispatchAction({
                                    id: pendingAction.id,
                                    state: 'canceled',
                                    expectedState: 'awaiting_approval',
                                  })
                                    .then(() => toast.info(t('butler.cognition.actionRejectedToast')))
                                    .catch((err) => toast.error(err));
                                }}
                                className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-ink-3 hover:text-danger"
                              >
                                {t('butler.cognition.rejectAction')}
                              </button>
                            </>
                          ) : null}
                          {item.ref?.rid ? (
                            <button
                              type="button"
                              onClick={() => {
                                const chat = useChat.getState();
                                setModule('messages');
                                if (item.ref?.mid) {
                                  void chat.jumpToMessage(item.ref.mid, item.ref.rid);
                                } else if (item.ref?.rid) {
                                  void chat.openRoom(item.ref.rid);
                                }
                              }}
                              className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2 hover:text-primary"
                            >
                              {t('butler.cognition.jumpToRoom')}
                            </button>
                          ) : null}
                          {item.ref?.sessionKey ? (
                            <button
                              type="button"
                              onClick={() => {
                                setActiveAcpSession(item.ref?.sessionKey ?? null);
                                openAcpHub(refAcpSession?.agentId ?? null);
                              }}
                              className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2 hover:text-primary"
                            >
                              {t('butler.cognition.jumpToAcp')}
                            </button>
                          ) : null}
                          {item.ref?.todoId ? (
                            <button
                              type="button"
                              onClick={() => {
                                setButlerView('kanban');
                              }}
                              className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2 hover:text-primary"
                            >
                              {t('butler.cognition.jumpToCard')}
                            </button>
                          ) : null}
                          {item.status === 'unread' ? (
                            <>
                              <button
                                type="button"
                                onClick={() => markInsightFeedback(item.id, 'acknowledged')}
                                className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2 hover:text-ink"
                              >
                                {t('butler.cognition.acknowledge')}
                              </button>
                              <button
                                type="button"
                                onClick={() => markInsightFeedback(item.id, 'dismissed')}
                                className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-ink-3 hover:text-danger"
                              >
                                {t('butler.cognition.dismissNoise')}
                              </button>
                            </>
                          ) : (
                            <span className="text-xs text-ink-3">
                              {t(`butler.cognition.status.${item.status}`)}
                            </span>
                          )}
                        </div>
                      </article>
                    );})}
                  </div>
                )}
              </section>

              {/* 自调度观察点与观测缓冲 */}
              <section className="space-y-4 rounded-2xl border border-line bg-surface-3 p-4 shadow-raise">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                      <Clock size={14} className="text-primary" />
                      <span>{t('butler.cognition.watchpointsTitle')}</span>
                    </h3>
                    <span className="text-xs text-ink-3">{armedWatchpoints.length}</span>
                  </div>
                  {armedWatchpoints.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-line p-3 text-xs text-ink-3">
                      {t('butler.cognition.watchpointsEmpty')}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {armedWatchpoints.map((wp) => {
                        const wpPayload: ButlerSharePayload = {
                          kind: 'watchpoint',
                          watchpointId: wp.id,
                          reason: wp.reason,
                          conditionKind: wp.condition.kind,
                          expiresAt: wp.expiresAt,
                        };
                        return (
                        <div
                          key={wp.id}
                          draggable
                          onDragStart={(e) => writeButlerShareDrag(e.dataTransfer, wpPayload)}
                          className="flex items-center justify-between gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-ink">{wp.reason}</div>
                            <div className="mt-0.5 truncate font-mono text-xs text-ink-3">
                              {wp.condition.kind} · {t('butler.cognition.expiresAt', {
                                time: formatDateTime(wp.expiresAt, DATE_TIME_OPTIONS, locale),
                              })}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <ShareToRoomButton
                              payload={wpPayload}
                              bindableTarget={{
                                targetKind: 'watchpoint',
                                targetId: wp.id,
                                label: wp.reason,
                              }}
                              compact
                            />
                            <button
                              type="button"
                              onClick={() => cancelWatchpoint(wp.id)}
                              className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-ink-3 hover:text-danger"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        </div>
                      );})}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="mb-2 text-xs font-semibold text-ink">{t('butler.cognition.observationsTitle')}</h3>
                  {cognitionObservations.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-line p-3 text-xs text-ink-3">
                      {t('butler.cognition.observationsEmpty')}
                    </p>
                  ) : (
                    <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                      {cognitionObservations.slice(0, 15).map((obs) => (
                        <div
                          key={obs.id}
                          className="flex items-start justify-between gap-2 rounded-lg border border-line-soft bg-surface-4 px-2.5 py-1.5 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="mr-1.5 rounded bg-fill-1 px-1.5 py-0.5 font-mono text-xs text-ink-2">
                              {obs.source}/{obs.kind}
                            </span>
                            <span className="text-ink-2">{obs.summary}</span>
                          </div>
                          <span className="shrink-0 text-xs text-ink-3">
                            {formatDateTime(obs.at, DATE_TIME_OPTIONS, locale)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>

            {/* 每日 Dream 进化日志 */}
            <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-raise">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                  <Moon size={14} className="text-primary" />
                  <span>{t('butler.cognition.dreamJournalTitle')}</span>
                </h3>
                <span className="text-xs text-ink-3">
                  {t('butler.cognition.dreamCount', { count: dreamJournal.length })}
                </span>
              </div>
              {dreamJournal.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-ink-3">
                  {t('butler.cognition.dreamEmpty')}
                </p>
              ) : (
                <div className="space-y-3">
                  {dreamJournal.slice(0, 7).map((entry) => {
                    const hasRollbackables =
                      (entry.memoryArtifacts?.length ?? 0) > 0 || (entry.skillSnapshots?.length ?? 0) > 0;
                    return (
                    <article
                      key={entry.id}
                      className="space-y-2 rounded-xl border border-line-soft bg-surface-4 p-3.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-ink">{entry.dateKey}</span>
                          <span className="rounded-full bg-fill-1 px-2 py-0.5 text-xs text-ink-2">
                            {entry.trigger === 'auto'
                              ? t('butler.cognition.triggerAuto')
                              : t('butler.cognition.triggerManual')}
                          </span>
                          {entry.rolledBackAt ? (
                            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
                              {t('butler.cognition.dreamRolledBackBadge')}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          {hasRollbackables && !entry.rolledBackAt ? (
                            <button
                              type="button"
                              onClick={() => {
                                void rollbackDreamEntry(entry.id).then((res) => {
                                  toast.info(t('butler.cognition.dreamRollbackToast', {
                                    memories: res.restoredMemories,
                                    skills: res.restoredSkills,
                                  }));
                                }).catch((err) => toast.error(err));
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-3 px-2 py-0.5 text-xs text-ink-2 hover:border-warning/40 hover:text-warning"
                            >
                              <RotateCcw size={11} aria-hidden="true" />
                              <span>{t('butler.cognition.dreamRollbackBtn')}</span>
                            </button>
                          ) : null}
                          <span className="text-xs text-ink-3">
                            {formatDateTime(entry.at, DATE_TIME_OPTIONS, locale)}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-xs">
                        <span className="rounded-full bg-fill-1 px-2 py-0.5 text-ink-2">
                          {t('butler.cognition.metricEpisodes', { count: entry.episodesReviewed })}
                        </span>
                        <span className="rounded-full bg-fill-1 px-2 py-0.5 text-ink-2">
                          {t('butler.cognition.metricMerged', { count: entry.memoriesConsolidated })}
                        </span>
                        <span className="rounded-full bg-fill-1 px-2 py-0.5 text-ink-2">
                          {t('butler.cognition.metricCreated', { count: entry.memoriesCreated })}
                        </span>
                        <span className="rounded-full bg-fill-1 px-2 py-0.5 text-ink-2">
                          {t('butler.cognition.metricSkills', { count: entry.skillsEvolved })}
                        </span>
                      </div>
                      {((entry.memoryArtifacts?.length ?? 0) > 0 || (entry.skillSnapshots?.length ?? 0) > 0) ? (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          {(entry.memoryArtifacts ?? []).slice(0, 6).map((artifact) => (
                            <button
                              key={`${entry.id}:mem:${artifact.id}`}
                              type="button"
                              onClick={() => setSectionTab('memories')}
                              className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-3 px-2 py-0.5 text-xs text-ink-2 hover:border-primary/40 hover:text-primary"
                            >
                              <Brain size={11} aria-hidden="true" />
                              <span>{artifact.title}</span>
                            </button>
                          ))}
                          {(entry.skillSnapshots ?? []).slice(0, 6).map((snap) => {
                            const matchedSkill = allSkills.find(
                              (s) => s.id === snap.currentSkillId || s.slug === snap.slug,
                            );
                            return (
                              <div
                                key={`${entry.id}:skill:${snap.slug}`}
                                className="inline-flex items-center gap-1"
                              >
                                <button
                                  type="button"
                                  onClick={() => setSectionTab('skills')}
                                  className="inline-flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20"
                                >
                                  <Wand2 size={11} aria-hidden="true" />
                                  <span>/{snap.slug}</span>
                                </button>
                                {matchedSkill ? (
                                  <ShareToRoomButton
                                    compact
                                    payload={{
                                      kind: 'skill',
                                      skillId: matchedSkill.id,
                                      slug: matchedSkill.slug,
                                      name: matchedSkill.name,
                                      description: matchedSkill.description,
                                      category: matchedSkill.category,
                                      approvalPolicy: matchedSkill.approvalPolicy,
                                      triggers: matchedSkill.triggers,
                                      allowedTools: matchedSkill.allowedTools,
                                      instructionsMd: matchedSkill.instructionsMd,
                                    }}
                                  />
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                      <div className="butler-conversation-markdown text-xs">
                        {renderMarkdownDoc(entry.reflectionMd)}
                      </div>
                    </article>
                  );})}
                </div>
              )}
            </section>
          </div>
        )}

        {sectionTab === 'skills' && (
          <ButlerSkillsStudio workspaceRoot={effectiveWorkspace} />
        )}

        {sectionTab === 'memories' && (
          <div className="space-y-4">
            <p className="text-xs text-ink-3">{t('butler.assistant.memoryScopeNote')}</p>
            <label className="inline-flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={showMemoryHistory} onChange={(e) => setShowMemoryHistory(e.target.checked)} />{t('butler.assistant.showMemoryHistory')}</label>
            {/* 记忆库搜索、分类与新增 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface-3 p-3 shadow-raise">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex items-center">
                  <Search size={13} className="pointer-events-none absolute left-3 text-ink-3" />
                  <input
                    type="search"
                    value={memoryQuery}
                    onChange={(e) => setMemoryQuery(e.target.value)}
                    placeholder={t('butler.assistant.searchMemoryPlaceholder')}
                    className="h-8 w-64 rounded-xl border border-line bg-surface-4 pl-8 pr-3 text-xs text-ink outline-none focus:border-primary"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  {MEMORY_CATEGORIES.map((cat) => (
                    <button
                      key={cat.key}
                      type="button"
                      onClick={() => setCategoryFilter(cat.key)}
                      className={`rounded-full px-2.5 py-1 text-2xs font-medium transition ${
                        categoryFilter === cat.key
                          ? 'bg-primary text-white'
                          : 'bg-fill-2 text-ink-2 hover:bg-fill-hover'
                      }`}
                    >
                      {t(cat.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {memories.length > 0 && (
                  confirmClearScope ? (
                    <div className="flex items-center gap-1 rounded-xl border border-danger/40 bg-danger/10 px-2.5 py-1 text-xs">
                      <span className="text-danger">{t('butler.assistant.confirmClearMemories')}</span>
                      <button
                        type="button"
                        onClick={() =>
                          void clearScope().then((n) => {
                            setConfirmClearScope(false);
                            toast.success(tp(n, 'butler.assistant.clearedMemoriesToastOne', 'butler.assistant.clearedMemoriesToastOther'));
                          })
                        }
                        className="rounded bg-danger px-2 py-0.5 text-xs font-medium text-white"
                      >
                        {t('common.confirm')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmClearScope(false)}
                        className="rounded px-1.5 py-0.5 text-xs text-ink-3 hover:text-ink"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmClearScope(true)}
                      className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface-4 px-2.5 py-1.5 text-xs text-ink-3 hover:border-danger/40 hover:text-danger"
                    >
                      <Trash2 size={12} />
                      <span>{t('butler.assistant.clearAccountMemories')}</span>
                    </button>
                  )
                )}

                <button
                  type="button"
                  onClick={openNewMemoryEditor}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
                >
                  <Plus size={13} />
                  <span>{t('butler.assistant.addMemory')}</span>
                </button>
              </div>
            </div>

            {/* 新增 / 编辑记忆表单 */}
            {editorOpen && (
              <form
                onSubmit={(e) => void handleSaveMemory(e)}
                className="space-y-3 rounded-2xl border border-primary/30 bg-surface-3 p-4 shadow-card"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-ink">
                    {t(editingId ? 'butler.assistant.editMemoryHeading' : 'butler.assistant.newMemoryHeading')}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setEditorOpen(false)}
                    className="rounded-lg p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"
                  >
                    <X size={15} />
                  </button>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-2">{t('butler.assistant.memoryTitleLabel')}</label>
                    <input
                      aria-label={t('butler.assistant.memoryTitleAria')}
                      value={memTitle}
                      onChange={(e) => setMemTitle(e.target.value)}
                      placeholder={t('butler.assistant.memoryTitlePlaceholder')}
                      className="h-9 w-full rounded-xl border border-line bg-surface-4 px-3 text-xs text-ink outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-2">{t('butler.assistant.memoryCategoryLabel')}</label>
                    <select
                      value={memCategory}
                      onChange={(e) => setMemCategory(e.target.value as ButlerMemoryCategory)}
                      className="h-9 w-full rounded-xl border border-line bg-surface-4 px-3 text-xs text-ink outline-none focus:border-primary"
                    >
                      {MEMORY_CATEGORIES.filter((c) => c.key !== 'all').map((cat) => (
                        <option key={cat.key} value={cat.key}>
                          {t(cat.labelKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-2">
                    {t('butler.assistant.memoryContentLabel')}
                  </label>
                  <textarea
                    aria-label={t('butler.assistant.memoryContentAria')}
                    rows={3}
                    value={memContent}
                    onChange={(e) => setMemContent(e.target.value)}
                    placeholder={t('butler.assistant.memoryContentPlaceholder')}
                    className="w-full rounded-xl border border-line bg-surface-4 p-3 text-xs text-ink outline-none focus:border-primary"
                  />
                  {!secretCheck.ok && (
                    <div className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                      <ShieldAlert size={13} />
                      <span>{secretCheck.reason}</span>
                    </div>
                  )}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-2">{t('butler.assistant.memoryTagsLabel')}</label>
                    <input
                      value={memTags}
                      onChange={(e) => setMemTags(e.target.value)}
                      placeholder="rust, testing, ui"
                      className="h-9 w-full rounded-xl border border-line bg-surface-4 px-3 text-xs text-ink outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-2">{t('butler.assistant.memoryWorkspaceLabel')}</label>
                    <input
                      value={memWorkspace}
                      onChange={(e) => setMemWorkspace(e.target.value)}
                      placeholder={t('butler.assistant.memoryWorkspacePlaceholder')}
                      className="h-9 w-full rounded-xl border border-line bg-surface-4 px-3 text-xs text-ink outline-none focus:border-primary"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-2">
                    <input
                      type="checkbox"
                      checked={memPinned}
                      onChange={(e) => setMemPinned(e.target.checked)}
                      className="rounded border-line"
                    />
                    <span>{t('butler.assistant.memoryPinOption')}</span>
                  </label>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditorOpen(false)}
                      className="rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs text-ink-2 hover:bg-fill-hover"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={savingMem || !secretCheck.ok}
                      className="rounded-xl bg-primary px-4 py-1.5 text-xs font-medium text-white shadow-raise hover:bg-primary-hover disabled:opacity-50"
                    >
                      {t(savingMem ? 'butler.assistant.savingMemory' : 'butler.assistant.saveMemory')}
                    </button>
                  </div>
                </div>
              </form>
            )}

            {/* 记忆列表 */}
            {loading && memories.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-xs text-ink-3">
                <Loader2 size={16} className="mr-2 animate-spin" />
                {t('butler.assistant.loadingMemories')}
              </div>
            ) : filteredMemories.length === 0 ? (
              <div className="flex h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center">
                <Brain size={28} className="mb-2 text-ink-3 opacity-50" />
                <div className="text-sm font-medium text-ink">
                  {t(memories.length === 0 ? 'butler.assistant.emptyMemoriesTitle' : 'butler.assistant.noMatchingMemoriesTitle')}
                </div>
                <p className="mt-1 max-w-md text-xs text-ink-3">
                  {t('butler.assistant.emptyMemoriesDesc')}
                </p>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {filteredMemories.map((entry) => {
                  const meta = categoryMeta(entry.category);
                  return (
                    <article
                      key={entry.id}
                      className={`flex flex-col justify-between gap-3 rounded-2xl border p-4 shadow-raise transition ${
                        isMemoryCurrent(entry)
                          ? 'border-line bg-surface-4'
                          : 'border-line-soft bg-surface-2 opacity-65'
                      }`}
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={`rounded-full px-2 py-0.5 text-2xs font-medium ${meta.badgeClass}`}
                              >
                                {meta.labelKey ? t(meta.labelKey) : meta.fallbackLabel}
                              </span>
                              {entry.pinned && (
                                <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning">
                                  <Pin size={10} />
                                  {t('butler.assistant.pinnedBadge')}
                                </span>
                              )}
                              {!entry.enabled && (
                                <span className="rounded-full bg-fill-2 px-2 py-0.5 text-2xs text-ink-3">
                                  {t(entry.supersededBy ? 'butler.assistant.statusSuperseded' : entry.expiresAt && entry.expiresAt <= Date.now() ? 'butler.assistant.statusExpired' : entry.sourceKind === 'workflow_report' ? 'butler.assistant.statusPendingBackground' : 'butler.assistant.statusDisabled')}
                                </span>
                              )}
                            </div>
                            <h3 className="mt-1.5 break-words text-sm font-semibold text-ink">
                              {entry.title}
                            </h3>
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              disabled={Boolean(entry.supersededBy)}
                              onClick={() => void togglePin(entry.id)}
                              title={t(entry.pinned ? 'butler.assistant.unpinTitle' : 'butler.assistant.pinTitle')}
                              className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
                            >
                              {entry.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(entry.supersededBy) || (entry.expiresAt != null && entry.expiresAt <= Date.now())}
                              onClick={() => void toggleEnabled(entry.id).catch((error) => toast.error(error, t('butler.assistant.updateMemoryFailed')))}
                              title={t(entry.enabled ? 'butler.assistant.disableMemoryTitle' : 'butler.assistant.enableMemoryTitle')}
                              className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
                            >
                              {entry.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(entry.supersededBy)}
                              onClick={() => openEditMemoryEditor(entry)}
                              title={t('butler.assistant.correctMemoryTitle')}
                              className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
                            >
                              <Edit3 size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void deleteMemory(entry.id).then(() => toast.info(t('butler.assistant.deletedMemoryToast')))
                              }
                              title={t('common.delete')}
                              className="rounded-lg p-1.5 text-ink-3 hover:bg-danger/10 hover:text-danger"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>

                        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-2">
                          {entry.content}
                        </p>
                        <details className="text-xs text-ink-3">
                          <summary className="cursor-pointer">{t('butler.assistant.memoryProvenanceSummary')}</summary>
                          <p className="mt-1 break-all">
                            {t('butler.assistant.memorySourceLine', {
                              kind: entry.sourceKind,
                              ref: entry.sourceRef || t('butler.assistant.memoryManualSource'),
                            })}
                            <br />
                            {t('butler.assistant.memoryScopeLine', {
                              scope: entry.workspaceRoot || t('butler.assistant.memoryGlobalScope'),
                            })}
                            <br />
                            {t('butler.assistant.memoryUpdatedLine', {
                              time: formatDateTime(entry.updatedAt, DATE_TIME_OPTIONS, locale),
                            })}
                          </p>
                          {entry.supersededBy && <p className="break-all">{t('butler.assistant.memorySupersededBy', { id: entry.supersededBy })}</p>}
                          {entry.expiresAt != null && <p>{t('butler.assistant.memoryExpiresAt', { time: formatDateTime(entry.expiresAt, DATE_TIME_OPTIONS, locale) })}</p>}
                        </details>
                        {!entry.supersededBy && isMemoryCurrent(entry) && <button type="button" onClick={() => void expireMemory(entry.id).catch((error) => toast.error(error, t('butler.assistant.markExpiredFailed')))} className="text-xs text-warning hover:underline">{t('butler.assistant.markExpiredButton')}</button>}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2 text-xs text-ink-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {entry.workspaceRoot && (
                            <span
                              className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-md bg-fill-1 px-1.5 py-0.5 font-mono"
                              title={entry.workspaceRoot}
                            >
                              <FolderOpen size={10} />
                              <span className="truncate">
                                {entry.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)}
                              </span>
                            </span>
                          )}
                          {entry.tags.map((tag) => (
                            <span key={tag} className="rounded-md bg-fill-1 px-1.5 py-0.5">
                              #{tag}
                            </span>
                          ))}
                        </div>
                        <span>
                          {t('butler.assistant.recallStats', {
                            count: entry.recallCount,
                            time: formatDateTime(entry.updatedAt, DATE_TIME_OPTIONS, locale),
                          })}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {sectionTab === 'archive' && (
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-2 lg:col-span-1">
              {digests.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center">
                  <Archive size={24} className="mb-2 text-ink-3 opacity-50" />
                  <span className="text-xs font-medium text-ink">{t('butler.assistant.noArchivedDigests')}</span>
                  <span className="mt-1 text-xs text-ink-3">{t('butler.assistant.noArchivedDigestsHint')}</span>
                </div>
              ) : (
                digests.map((d) => (
                  <div
                    key={d.id}
                    onClick={() => setSelectedDigest(d)}
                    className={`cursor-pointer rounded-2xl border p-3 transition ${
                      selectedDigest?.id === d.id
                        ? 'border-primary bg-primary/5 shadow-card'
                        : 'border-line bg-surface-3 hover:bg-fill-hover'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold text-ink">{d.title}</div>
                        <div className="mt-0.5 text-xs text-ink-3">
                          {d.dateKey} · {formatDateTime(d.createdAt, DATE_TIME_OPTIONS, locale)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteDigest(d.id).then(() => {
                            if (selectedDigest?.id === d.id) setSelectedDigest(null);
                            toast.info(t('butler.assistant.deletedDigestToast'));
                          });
                        }}
                        className="rounded p-1 text-ink-3 hover:bg-danger/10 hover:text-danger"
                        title={t('butler.assistant.deleteArchiveTitle')}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="lg:col-span-2">
              {selectedDigest ? (
                <div className="rounded-2xl border border-line bg-surface-3 p-5 shadow-card">
                  <div className="mb-3 flex items-center justify-between border-b border-line-soft pb-3">
                    <div>
                      <h2 className="text-sm font-semibold text-ink">{selectedDigest.title}</h2>
                      <p className="text-xs text-ink-3">{formatDateTime(selectedDigest.createdAt, DATE_TIME_OPTIONS, locale)}</p>
                    </div>
                    <FileText size={16} className="text-primary" />
                  </div>
                  <div className="butler-conversation-markdown text-sm">
                    {renderMarkdownDoc(selectedDigest.summaryMd)}
                  </div>
                </div>
              ) : (
                <div className="flex h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center text-xs text-ink-3">
                  <FileText size={26} className="mb-2 opacity-40" />
                  <span>{t('butler.assistant.archiveEmptyPreview')}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
