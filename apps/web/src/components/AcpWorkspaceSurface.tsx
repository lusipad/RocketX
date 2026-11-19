import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  Cpu,
  FileText,
  FolderOpen,
  History,
  ListChecks,
  Loader2,
  PanelLeft,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  matchesDiscoveredWorkSession,
  promoteWorkSessionToCard,
  syncLiveSessionsIntoLedger,
} from '../agent/superAgentBridge';
import { buildWorkflowExecutionReport } from '../agent/workflowReport';
import { getServerBase, isTauriRuntime } from '../lib/client';
import { renderMarkdownDoc } from '../lib/markdown';
import { useStickToBottom } from '../lib/stickToBottom';
import { acpLocalSessionMessages, type LocalSessionMessage,
  type AcpAgentPreset,
  type AcpAgentProfile,
  type AcpDiscoveredCandidate,
  type DiscoveredLocalSession,
  type WorkCardAutonomyMode,
} from '../platform/desktopCommands';
import { openDesktopDialog } from '../platform/desktopDialog';
import {
  ACP_PRESET_TEMPLATES,
  type AcpManagedSessionState,
  useAcpAgents,
} from '../stores/acpAgents';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import { useWorkLedger } from '../stores/workLedger';
import { useAuth } from '../stores/auth';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { useAgentComposerDraft, useAgentComposerDrafts, type AgentComposerRequest } from '../stores/agentComposerDrafts';
import AgentComposerFeedback from './AgentComposerFeedback';
import LocalVoiceControls from './LocalVoiceControls';
import WorkflowReportCard from './WorkflowReportCard';

type InspectorTab = 'plan' | 'tools' | 'report' | 'logs';

function statusBadgeMeta(status: AcpManagedSessionState['status']): {
  label: string;
  dotClass: string;
  className: string;
} {
  switch (status) {
    case 'running':
      return {
        label: '执行中',
        dotClass: 'bg-primary animate-pulse',
        className: 'border-primary/30 bg-primary/10 text-primary',
      };
    case 'waiting_approval':
      return {
        label: '待审批',
        dotClass: 'bg-amber-500 animate-pulse',
        className: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      };
    case 'ready':
      return {
        label: '就绪',
        dotClass: 'bg-emerald-500',
        className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      };
    case 'connecting':
      return {
        label: '连接中',
        dotClass: 'bg-ink-3',
        className: 'border-line bg-surface-2 text-ink-2',
      };
    case 'error':
      return {
        label: '异常',
        dotClass: 'bg-rose-500',
        className: 'border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300',
      };
    case 'stopped':
    default:
      return {
        label: '已停止',
        dotClass: 'bg-ink-4',
        className: 'border-line bg-surface-2 text-ink-3',
      };
  }
}

function resolveTransportLabel(preset: string, args: string[]): '内置桥接' | '原生 ACP' {
  if (args.some((a) => a.startsWith('--rocketx-acp-bridge='))) {
    return '内置桥接';
  }
  const tpl = ACP_PRESET_TEMPLATES.find((t) => t.preset === preset);
  return tpl?.transportLabel || '原生 ACP';
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function providerDisplayLabel(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'antigravity':
      return 'Antigravity';
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude Code';
    default:
      return provider;
  }
}

function basenameOfPath(p: string): string {
  const clean = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!clean) return '未知工作区';
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

export default function AcpWorkspaceSurface() {
  const agents = useAcpAgents((s) => s.agents);
  const discovered = useAcpAgents((s) => s.discovered);
  const localSessions = useAcpAgents((s) => s.localSessions);
  const probes = useAcpAgents((s) => s.probes);
  const sessionsMap = useAcpAgents((s) => s.sessions);
  const activeSessionKey = useAcpAgents((s) => s.activeSessionKey);
  const loading = useAcpAgents((s) => s.loading);
  const discovering = useAcpAgents((s) => s.discovering);
  const discoveringLocalSessions = useAcpAgents((s) => s.discoveringLocalSessions);
  const lastError = useAcpAgents((s) => s.lastError);
  const expiredPermissions = useAcpAgents((s) => s.expiredPermissions);

  const hydrate = useAcpAgents((s) => s.hydrate);
  const discoverLocalAgents = useAcpAgents((s) => s.discoverLocalAgents);
  const discoverLocalSessions = useAcpAgents((s) => s.discoverLocalSessions);
  const adoptAllDiscoveredAgents = useAcpAgents((s) => s.adoptAllDiscoveredAgents);
  const upsertAgent = useAcpAgents((s) => s.upsertAgent);
  const removeAgent = useAcpAgents((s) => s.removeAgent);
  const probeAgent = useAcpAgents((s) => s.probeAgent);
  const startSession = useAcpAgents((s) => s.startSession);
  const loadSession = useAcpAgents((s) => s.loadSession);
  const resumeLocalSession = useAcpAgents((s) => s.resumeLocalSession);
  const sendPrompt = useAcpAgents((s) => s.sendPrompt);
  const cancelTurn = useAcpAgents((s) => s.cancelTurn);
  const setMode = useAcpAgents((s) => s.setMode);
  const resolvePermission = useAcpAgents((s) => s.resolvePermission);
  const stopSession = useAcpAgents((s) => s.stopSession);
  const setActiveSession = useAcpAgents((s) => s.setActiveSession);

  const currentWorkspaceRoot = useCodexWorkspace((s) => s.workspaceRoot);
  const workspaceRoots = useCodexWorkspace((s) => s.workspaceRoots);
  const cards = useWorkLedger((s) => s.cards);
  const workSessions = useWorkLedger((s) => s.sessions);
  const workEvidences = useWorkLedger((s) => s.evidences);
  const workLinks = useWorkLedger((s) => s.links);

  const selectedAcpAgentId = useUI((s) => s.selectedAcpAgentId);
  const setSelectedAcpAgentId = useUI((s) => s.setSelectedAcpAgentId);
  const setButlerView = useUI((s) => s.setButlerView);
  const butlerSidebarCollapsed = useUI((s) => s.butlerSidebarCollapsed);
  const toggleButlerSidebarCollapsed = useUI((s) => s.toggleButlerSidebarCollapsed);

  const externalLocalSessions = useMemo(
    () => localSessions.filter((s) => s.provider !== 'pi'),
    [localSessions],
  );
  const [historyProviderFilter, setHistoryProviderFilter] = useState<
    'all' | 'antigravity' | 'codex' | 'claude'
  >('all');
  const [resumingLocalId, setResumingLocalId] = useState<string | null>(null);

  const filteredExternalSessions = useMemo(() => {
    if (historyProviderFilter === 'all') return externalLocalSessions;
    return externalLocalSessions.filter((s) => s.provider === historyProviderFilter);
  }, [externalLocalSessions, historyProviderFilter]);

  const sessions = useMemo(
    () =>
      Object.values(sessionsMap).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [sessionsMap],
  );

  const activeSession = useMemo(
    () => (activeSessionKey ? sessionsMap[activeSessionKey] || null : null),
    [activeSessionKey, sessionsMap],
  );

  const unadoptedCount = useMemo(
    () => discovered.filter((cand) => !cand.alreadyRegistered).length,
    [discovered],
  );

  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('plan');
  const [auxiliaryPanel, setAuxiliaryPanel] = useState<'executors' | 'details' | null>(null);
  const auxiliaryPanelRef = useRef<HTMLElement>(null);
  const userId = useAuth((state) => state.user?._id ?? 'local-user');
  const composerTarget = {
    kind: 'acp' as const,
    scope: `${getServerBase() || 'same-origin'}:${userId}`,
    workspaceRoot: activeSession?.workspaceRoot ?? '',
    recipientId: activeSession?.sessionKey ?? null,
  };
  const { key: composerKey, draft } = useAgentComposerDraft(composerTarget);
  const { scrollRef: transcriptRef, onScroll: onTranscriptScroll, stickToBottom } = useStickToBottom([
    activeSession?.messages, activeSession?.streamingText, activeSession?.streamingThought,
    activeSession?.pendingPermissions,
  ], composerKey);
  const composerText = draft.text;
  const setComposerText = useCallback((value: string | ((previous: string) => string)) => {
    const store = useAgentComposerDrafts.getState();
    store.edit(composerKey, { text: typeof value === 'function' ? value(store.drafts[composerKey]?.text ?? '') : value });
  }, [composerKey]);
  const [injectMemory, setInjectMemory] = useState(true);
  const sending = Boolean(draft.pending);
  const connectionReady = Boolean(activeSession?.acpSessionId)
    && activeSession?.connectionReady !== false
    && activeSession?.status !== 'connecting'
    && activeSession?.status !== 'stopped';
  const [launching, setLaunching] = useState(false);
  const [adoptingAll, setAdoptingAll] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [nativePreview, setNativePreview] = useState<{ item: DiscoveredLocalSession; messages: LocalSessionMessage[]; loading: boolean; error: string | null } | null>(null);
  const [nativeStoppedConfirmed, setNativeStoppedConfirmed] = useState(false);
  const [thoughtExpanded, setThoughtExpanded] = useState(true);
  const [expandedToolIds, setExpandedToolIds] = useState<Record<string, boolean>>({});

  // Launch studio state
  const [launchAgentId, setLaunchAgentId] = useState<string>('');
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(
    currentWorkspaceRoot || workspaceRoots[0] || '',
  );
  const [autonomyMode, setAutonomyMode] = useState<WorkCardAutonomyMode>('confirm');
  const [linkedTodoId, setLinkedTodoId] = useState<string>('');
  const [resumeSessionId, setResumeSessionId] = useState<string>('');
  const [showResumeInput, setShowResumeInput] = useState(false);

  // Add / Edit client form modal/drawer inside rail
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formPreset, setFormPreset] = useState<AcpAgentPreset>('codex-acp');
  const [formCommand, setFormCommand] = useState('');
  const [formArgs, setFormArgs] = useState('');
  const [formCwd, setFormCwd] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formAutoApprove, setFormAutoApprove] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    if (!auxiliaryPanel) return;
    const previousFocus = document.activeElement;
    const panel = auxiliaryPanelRef.current;
    panel?.querySelector<HTMLElement>('[data-panel-close]')?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setAuxiliaryPanel(null);
      } else if (event.key === 'Tab' && panel) {
        const controls = Array.from(panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        )).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [auxiliaryPanel]);

  useEffect(() => {
    if (auxiliaryPanel === 'details' && !activeSession) setAuxiliaryPanel(null);
  }, [activeSession, auxiliaryPanel]);

  useEffect(() => {
    void hydrate();
    void discoverLocalSessions();
  }, [discoverLocalSessions, hydrate]);

  useEffect(() => {
    if (!workspaceRoot && (currentWorkspaceRoot || workspaceRoots[0])) {
      setWorkspaceRoot(currentWorkspaceRoot || workspaceRoots[0] || '');
    }
  }, [currentWorkspaceRoot, workspaceRoot, workspaceRoots]);

  useEffect(() => {
    if (selectedAcpAgentId && agents.some((a) => a.id === selectedAcpAgentId)) {
      setLaunchAgentId(selectedAcpAgentId);
      return;
    }
    if (!launchAgentId || !agents.some((a) => a.id === launchAgentId)) {
      const firstEnabled = agents.find((a) => a.enabled) || agents[0];
      if (firstEnabled) {
        setLaunchAgentId(firstEnabled.id);
      }
    }
  }, [agents, launchAgentId, selectedAcpAgentId]);

  const applyPresetTemplate = useCallback((preset: AcpAgentPreset) => {
    const tpl = ACP_PRESET_TEMPLATES.find((item) => item.preset === preset);
    setEditingAgentId(null);
    setFormPreset(preset);
    setFormName(tpl?.name || '自定义 ACP 客户端');
    setFormCommand(tpl?.command || '');
    setFormArgs((tpl?.args || []).join(' '));
    setFormCwd('');
    setFormDescription(tpl?.description || '');
    setFormAutoApprove(tpl?.defaultAutoApproveSafeReads ?? true);
    setShowProfileEditor(true);
    setAuxiliaryPanel('executors');
  }, []);

  const openEditProfile = useCallback((agent: AcpAgentProfile) => {
    setEditingAgentId(agent.id);
    setFormPreset((agent.preset as AcpAgentPreset) || 'custom');
    setFormName(agent.name);
    setFormCommand(agent.command);
    setFormArgs(agent.args.join(' '));
    setFormCwd(agent.cwd || '');
    setFormDescription(agent.description || '');
    setFormAutoApprove(agent.autoApproveSafeReads);
    setShowProfileEditor(true);
  }, []);

  const handleSaveProfile = useCallback(async () => {
    const name = formName.trim();
    const command = formCommand.trim();
    if (!name || !command) {
      setActionNotice('请填写客户端名称与启动命令。');
      return;
    }
    setSavingProfile(true);
    setActionNotice(null);
    try {
      const args = formArgs
        .trim()
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const saved = await upsertAgent({
        id: editingAgentId,
        name,
        preset: formPreset,
        command,
        args,
        cwd: formCwd.trim() || null,
        description: formDescription.trim() || null,
        enabled: true,
        autoApproveSafeReads: formAutoApprove,
      });
      setLaunchAgentId(saved.id);
      setSelectedAcpAgentId(saved.id);
      setShowProfileEditor(false);
      setEditingAgentId(null);
      toast.success(`已保存 ACP 客户端：${saved.name}`);
    } catch (err) {
      setActionNotice(
        `保存客户端配置失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSavingProfile(false);
    }
  }, [
    editingAgentId,
    formArgs,
    formAutoApprove,
    formCommand,
    formCwd,
    formDescription,
    formName,
    formPreset,
    setSelectedAcpAgentId,
    upsertAgent,
  ]);

  const handleAdoptCandidate = useCallback(
    async (candidate: AcpDiscoveredCandidate) => {
      setActionNotice(null);
      try {
        const saved = await upsertAgent({
          name: candidate.name,
          preset: candidate.preset,
          command: candidate.resolvedPath || candidate.command,
          args: candidate.args,
          enabled: true,
          autoApproveSafeReads: true,
          description: candidate.version
            ? `本机自动发现 (${candidate.version})`
            : '本机自动发现的 ACP 客户端',
        });
        setLaunchAgentId(saved.id);
        setSelectedAcpAgentId(saved.id);
        toast.success(`已接入：${saved.name}`);
      } catch (err) {
        setActionNotice(
          `接入失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [setSelectedAcpAgentId, upsertAgent],
  );

  const handleAdoptAll = useCallback(async () => {
    setAdoptingAll(true);
    setActionNotice(null);
    try {
      const added = await adoptAllDiscoveredAgents();
      if (added.length > 0) {
        setLaunchAgentId(added[0].id);
        setSelectedAcpAgentId(added[0].id);
        toast.success(`已一键接入 ${added.length} 个本机 Agent`);
      } else {
        toast.info('所有已探测到的本机客户端均已接入');
      }
    } catch (err) {
      setActionNotice(
        `批量接入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAdoptingAll(false);
    }
  }, [adoptAllDiscoveredAgents, setSelectedAcpAgentId]);

  const handleResumeDiscoveredSession = useCallback(
    async (item: DiscoveredLocalSession) => {
      setResumingLocalId(item.nativeSessionId);
      setActionNotice(null);
      try {
        await resumeLocalSession({
          provider: item.provider,
          preset: item.preset,
          nativeSessionId: item.nativeSessionId,
          title: item.title,
          workspaceRoot: item.workspaceRoot,
          sourcePath: item.sourcePath,
          sourceScope: item.sourceScope,
          executionProfileId: item.executionProfileId,
          handoffConfirmed: nativeStoppedConfirmed,
        });
        setAuxiliaryPanel(null);
      } catch (err) {
        setActionNotice(
          `恢复本机会话失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setResumingLocalId(null);
      }
    },
    [resumeLocalSession, nativeStoppedConfirmed],
  );

  const handlePromoteDiscoveredSession = useCallback(async (item: DiscoveredLocalSession) => {
    setResumingLocalId(item.nativeSessionId);
    setActionNotice(null);
    try {
      await syncLiveSessionsIntoLedger({ autoPromoteRecent: false });
      const target = useWorkLedger
        .getState()
        .sessions.find((s) => matchesDiscoveredWorkSession(s, item));
      if (!target) {
        throw new Error('未能将该本机会话写入工作账本');
      }
      const created = await promoteWorkSessionToCard(target);
      toast.success(`已转入统一看板：${created.title}`);
    } catch (err) {
      setActionNotice(
        `转入看板失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setResumingLocalId(null);
    }
  }, []);

  const handlePickWorkspace = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const picked = await openDesktopDialog({
      directory: true,
      multiple: false,
      title: '选择 ACP 会话工作区目录',
    });
    if (typeof picked === 'string' && picked.trim()) {
      setWorkspaceRoot(picked.trim());
    }
  }, []);

  const handleLaunchSession = useCallback(async () => {
    const targetAgentId = launchAgentId || agents[0]?.id;
    const root = workspaceRoot.trim() || currentWorkspaceRoot || workspaceRoots[0] || '.';
    if (!targetAgentId) {
      setActionNotice('请先通过“管理执行器”接入并选择一个执行器。');
      return;
    }
    setLaunching(true);
    setActionNotice(null);
    try {
      const linkedCard = cards.find((c) => c.id === linkedTodoId);
      if (showResumeInput && resumeSessionId.trim()) {
        await loadSession({
          agentId: targetAgentId,
          sessionId: resumeSessionId.trim(),
          workspaceRoot: root,
          linkedTodoId: linkedTodoId || null,
          autonomyMode,
          title: linkedCard?.title || undefined,
        });
      } else {
        await startSession({
          agentId: targetAgentId,
          workspaceRoot: root,
          linkedTodoId: linkedTodoId || null,
          autonomyMode,
          title: linkedCard?.title || undefined,
        });
      }
      setAuxiliaryPanel(null);
    } catch (err) {
      setActionNotice(
        `启动 ACP 会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLaunching(false);
    }
  }, [
    agents,
    autonomyMode,
    cards,
    currentWorkspaceRoot,
    launchAgentId,
    linkedTodoId,
    loadSession,
    resumeSessionId,
    showResumeInput,
    startSession,
    workspaceRoot,
    workspaceRoots,
  ]);

  const dispatchRequest = async (request: AgentComposerRequest) => {
    let submitted = false;
    stickToBottom.current = true;
    try {
      if (`${getServerBase() || 'same-origin'}:${useAuth.getState().user?._id ?? 'local-user'}` !== request.target.scope) {
        throw new Error('账号已切换，请回到原账号继续发送');
      }
      const session = useAcpAgents.getState().sessions[request.target.recipientId ?? ''];
      if (!session || !session.acpSessionId || session.connectionReady === false || session.workspaceRoot !== request.target.workspaceRoot || session.status === 'connecting' || session.status === 'stopped') {
        throw new Error('原会话或工作区已不可用，请核对发送目标');
      }
      submitted = true;
      await sendPrompt(session.sessionKey, request.text, request.options);
      useAgentComposerDrafts.getState().finish(composerKey, request.id);
    } catch (err) {
      useAgentComposerDrafts.getState().finish(composerKey, request.id, err, submitted);
    }
  };

  const handleSendPrompt = async () => {
    if (!activeSession || !connectionReady) return;
    const request = useAgentComposerDrafts.getState().begin(composerTarget, {
      injectMemory, steer: activeSession.status === 'running',
    });
    if (request) await dispatchRequest(request);
  };

  const retryRequest = (failed: AgentComposerRequest) => {
    const request = useAgentComposerDrafts.getState().begin(composerTarget, undefined, undefined, failed.id);
    if (request) void dispatchRequest(request);
  };

  const linkedCard = useMemo(
    () =>
      activeSession?.linkedTodoId
        ? cards.find((c) => c.id === activeSession.linkedTodoId) || null
        : null,
    [activeSession?.linkedTodoId, cards],
  );

  const workflowReport = useMemo(() => {
    if (!activeSession && !linkedCard) return null;
    const cardId = linkedCard?.id;
    return buildWorkflowExecutionReport({
      card: linkedCard || undefined,
      acpSession: activeSession || undefined,
      sessions: cardId ? workSessions.filter((s) => s.todoId === cardId) : [],
      evidences: cardId ? workEvidences.filter((e) => e.todoId === cardId) : [],
      links: cardId ? workLinks.filter((l) => l.todoId === cardId) : [],
    });
  }, [activeSession, linkedCard, workEvidences, workLinks, workSessions]);

  const activeStreamingDoc = useMemo(
    () => (activeSession?.streamingText ? renderMarkdownDoc(activeSession.streamingText) : null),
    [activeSession?.streamingText],
  );

  const completedPlanCount = activeSession
    ? activeSession.plan.filter((item) => item.status === 'completed').length
    : 0;

  return (
    <div className="rcx-acp-workspace flex h-full min-h-0 flex-col bg-surface-3 text-ink">
      <header className="rcx-acp-header rcx-glass-header flex shrink-0 items-start justify-between gap-3 border-b border-line bg-surface-3 px-5 py-3">
        <div className="rcx-acp-heading flex min-w-0 items-start gap-2.5">
          {butlerSidebarCollapsed ? (
            <button
              type="button"
              onClick={toggleButlerSidebarCollapsed}
              title="展开会话列表 (Ctrl+B)"
              aria-label="展开会话列表"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
            >
              <PanelLeft size={16} />
            </button>
          ) : null}
          <div className="min-w-0">
            <h1 className="break-words text-sm font-semibold leading-snug tracking-tight text-ink">
              {activeSession ? activeSession.title || activeSession.agentName : '执行会话'}
            </h1>
            {activeSession ? (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                <span className={`inline-flex items-center gap-1.5 ${statusBadgeMeta(activeSession.status).className} rounded-full border px-2 py-0.5 text-2xs font-medium`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${statusBadgeMeta(activeSession.status).dotClass}`} />
                  {statusBadgeMeta(activeSession.status).label}
                </span>
                <span>{activeSession.agentName}</span>
                <span className="break-all font-mono text-xs">{activeSession.workspaceRoot}</span>
              </div>
            ) : (
              <p className="mt-1 text-xs text-ink-3">选择执行器和项目，开始工作或继续已有会话。</p>
            )}
          </div>
        </div>

        <div className="rcx-acp-header-actions flex items-center gap-2">
          {sessions.length > 0 ? (
            <select
              aria-label="切换会话"
              value={activeSessionKey || ''}
              onChange={(event) => setActiveSession(event.target.value || null)}
              className="h-8 min-w-0 max-w-44 rounded-lg border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
            >
              <option value="" disabled>选择会话 ({sessions.length})</option>
              {sessions.map((session) => (
                <option key={session.sessionKey} value={session.sessionKey}>
                  {session.title || session.agentName} · {session.pendingPermissions.length > 0 ? `待审批 ${session.pendingPermissions.length} 项` : statusBadgeMeta(session.status).label}
                </option>
              ))}
            </select>
          ) : null}
          {activeSession ? (
            <button
              type="button"
              onClick={() => setActiveSession(null)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover"
            >
              <Plus size={13} />
              <span>新建会话</span>
            </button>
          ) : null}
          <button
            type="button"
            aria-expanded={auxiliaryPanel === 'executors'}
            aria-controls="acp-executor-management"
            onClick={() => setAuxiliaryPanel('executors')}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover"
          >
            <Cpu size={13} />
            <span>管理执行器</span>
          </button>
          {activeSession ? (
            <button
              type="button"
              aria-expanded={auxiliaryPanel === 'details'}
              aria-controls="acp-task-details"
              onClick={() => setAuxiliaryPanel('details')}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover"
            >
              <PanelRight size={13} />
              <span>任务详情</span>
            </button>
          ) : null}
          {activeSession && (activeSession.status === 'running' || activeSession.status === 'waiting_approval') ? (
            <button
              type="button"
              onClick={() => void cancelTurn(activeSession.sessionKey)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 text-xs font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
            >
              <Square size={11} />
              <span>中断</span>
            </button>
          ) : null}
          {activeSession && activeSession.status !== 'stopped' ? (
            <button
              type="button"
              onClick={() => void stopSession(activeSession.sessionKey)}
              className="inline-flex h-8 items-center rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover"
            >
              停止
            </button>
          ) : null}
        </div>
      </header>

      {loading ? <div role="status" className="border-b border-line px-5 py-2 text-xs text-ink-2">正在加载执行器与会话，已收到的内容仍可查看。</div> : null}
      {expiredPermissions.some((item) => item.accountScope === resolveButlerAccountScope()) ? (
        <div role="status" className="border-b border-warning/30 bg-warning/10 px-5 py-2 text-xs text-ink">
          有 {expiredPermissions.filter((item) => item.accountScope === resolveButlerAccountScope()).length} 条旧权限请求已失效，需要执行器重新请求。原有审批不能用于继续执行。
        </div>
      ) : null}
      {lastError || actionNotice ? (
        <div role={lastError ? 'alert' : 'status'} className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-amber-500/10 px-5 py-2 text-xs text-ink">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{lastError ? `${lastError}。连接或读取未完成，当前保留已收到的数据。` : actionNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => { if (lastError) { void hydrate(); void discoverLocalSessions(); } else setActionNotice(null); }}
            className="text-xs font-medium text-ink-3 hover:text-ink"
          >
            {lastError ? '重新加载执行器与会话' : '关闭'}
          </button>
        </div>
      ) : null}

      <div className="rcx-acp-stage min-h-0 flex-1">
        {auxiliaryPanel === 'executors' ? (
          <>
          <div className="rcx-acp-panel-backdrop" onClick={() => setAuxiliaryPanel(null)} aria-hidden="true" />
          <aside
            ref={auxiliaryPanelRef}
            id="acp-executor-management"
            role="dialog"
            aria-modal="true"
            aria-labelledby="acp-executor-management-title"
            className="rcx-acp-panel rcx-acp-manager min-h-0 flex-col border-l border-line bg-surface-2 shadow-card"
          >
          <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
            <div>
              <h2 id="acp-executor-management-title" className="text-sm font-semibold text-ink">管理执行器</h2>
              <p className="mt-1 text-xs text-ink-3">已接入 {agents.length} · 本机发现 {discovered.length}</p>
            </div>
            <button type="button" data-panel-close aria-label="关闭执行器管理" onClick={() => setAuxiliaryPanel(null)} className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"><X size={16} /></button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={discovering || discoveringLocalSessions}
                onClick={() => { void discoverLocalAgents(); void discoverLocalSessions(); }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
              >
                {discovering || discoveringLocalSessions ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                <span>重新扫描本机</span>
              </button>
              {unadoptedCount > 0 ? (
                <button type="button" disabled={adoptingAll} onClick={() => void handleAdoptAll()} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50">
                  {adoptingAll ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  <span>全部接入 ({unadoptedCount})</span>
                </button>
              ) : null}
              <button type="button" onClick={() => applyPresetTemplate('custom')} className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover">
                <Plus size={13} /><span>添加自定义</span>
              </button>
            </div>
          {/* 快捷新增 / 编辑抽屉卡 */}
          {showProfileEditor ? (
            <section className="rounded-2xl border border-primary/35 bg-surface-4 p-3.5 shadow-card">
              <div className="mb-2.5 flex items-center justify-between">
                <h2 className="text-xs font-semibold text-ink">
                  {editingAgentId ? '编辑 ACP 客户端' : '新增 ACP 客户端'}
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setShowProfileEditor(false);
                    setEditingAgentId(null);
                  }}
                  className="text-xs text-ink-3 hover:text-ink"
                >
                  取消
                </button>
              </div>
              <div className="mb-2.5 flex flex-wrap gap-1">
                {ACP_PRESET_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.preset}
                    type="button"
                    onClick={() => {
                      setFormPreset(tpl.preset);
                      if (!editingAgentId) {
                        setFormName(tpl.name);
                        setFormCommand(tpl.command);
                        setFormArgs(tpl.args.join(' '));
                        setFormDescription(tpl.description);
                        setFormAutoApprove(tpl.defaultAutoApproveSafeReads);
                      }
                    }}
                    className={`rounded-full border px-2 py-0.5 text-2xs transition ${
                      formPreset === tpl.preset
                        ? 'border-primary/40 bg-primary/15 font-medium text-primary'
                        : 'border-line bg-surface-2 text-ink-3 hover:text-ink'
                    }`}
                  >
                    {tpl.name}
                  </button>
                ))}
              </div>
              <div className="space-y-2 text-xs">
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="显示名称（如 OpenAI Codex CLI）"
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
                <input
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  placeholder="可执行命令或绝对路径"
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 font-mono text-xs text-ink outline-none focus:border-primary"
                />
                <input
                  value={formArgs}
                  onChange={(e) => setFormArgs(e.target.value)}
                  placeholder="启动参数（空格分隔）"
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 font-mono text-xs text-ink outline-none focus:border-primary"
                />
                <input
                  value={formCwd}
                  onChange={(e) => setFormCwd(e.target.value)}
                  placeholder="默认工作目录（留空则使用会话工作区）"
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
                <input
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="用途备注（可选）"
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
                <label className="flex items-center gap-2 text-xs text-ink-2">
                  <input
                    type="checkbox"
                    checked={formAutoApprove}
                    onChange={(e) => setFormAutoApprove(e.target.checked)}
                    className="rounded border-line"
                  />
                  自主模式下自动放行安全只读检索
                </label>
                <button
                  type="button"
                  disabled={savingProfile}
                  onClick={() => void handleSaveProfile()}
                  className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
                >
                  {savingProfile ? <Loader2 size={13} className="animate-spin" /> : null}
                  保存客户端配置
                </button>
              </div>
            </section>
          ) : null}

          {/* Section 1: 发现本机 Agent */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-2">
                发现本机 Agent ({discovered.length})
              </span>
              {unadoptedCount > 0 ? (
                <button
                  type="button"
                  disabled={adoptingAll}
                  onClick={() => void handleAdoptAll()}
                  className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                >
                  一键全部接入
                </button>
              ) : null}
            </div>

            {discovering && discovered.length === 0 ? (
              <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-4 p-3 text-xs text-ink-3 shadow-raise">
                <Loader2 size={13} className="animate-spin text-primary" />
                <span>正在扫描本机已安装的 AI CLI…</span>
              </div>
            ) : discovered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line bg-surface-3/60 p-3 text-xs text-ink-3">
                暂未扫描到已安装 CLI，可点击右上角「重新扫描本机」或手动添加。
              </div>
            ) : (
              <div className="space-y-1.5">
                {discovered.map((cand) => {
                  const transport = resolveTransportLabel(cand.preset, cand.args);
                  return (
                    <div
                      key={`${cand.preset}-${cand.command}`}
                      className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface-4 p-2.5 shadow-raise"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-xs font-semibold text-ink">
                            {cand.name}
                          </span>
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-2xs font-medium ${
                              transport === '原生 ACP'
                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : 'bg-primary/10 text-primary'
                            }`}
                          >
                            {transport}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-xs text-ink-3">
                          {cand.version || cand.resolvedPath || cand.command}
                        </div>
                      </div>
                      {cand.alreadyRegistered ? (
                        <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-2xs font-medium text-emerald-700 dark:text-emerald-300">
                          已接入
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleAdoptCandidate(cand)}
                          className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
                        >
                          接入
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Section 2: 已接入客户端 */}
          <section className="space-y-2 border-t border-line/70 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-2">
                已接入客户端 ({agents.length})
              </span>
              {loading ? <Loader2 size={12} className="animate-spin text-ink-3" /> : null}
            </div>
            {agents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line bg-surface-3/60 p-3 text-xs text-ink-3">
                点击上方扫描结果中的「接入」，或通过下方预设模板注册本地代理。
              </div>
            ) : (
              <div className="space-y-1.5">
                {agents.map((agent) => {
                  const probe = probes[agent.id];
                  const selected = launchAgentId === agent.id;
                  const transport = resolveTransportLabel(agent.preset, agent.args);
                  return (
                    <div
                      key={agent.id}
                      onClick={() => {
                        setLaunchAgentId(agent.id);
                        setSelectedAcpAgentId(agent.id);
                      }}
                      className={`group cursor-pointer rounded-xl border p-2.5 transition ${
                        selected
                          ? 'border-primary/45 bg-surface-4 shadow-card ring-1 ring-primary/25'
                          : 'border-line bg-surface-4 shadow-raise hover:border-line-hover'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${
                                probe
                                  ? probe.ready
                                    ? 'bg-emerald-500'
                                    : 'bg-rose-500'
                                  : agent.enabled
                                    ? 'bg-primary'
                                    : 'bg-ink-4'
                              }`}
                            />
                            <span className="truncate text-xs font-semibold text-ink">
                              {agent.name}
                            </span>
                            <span className="rounded-full border border-line bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-3">
                              {transport}
                            </span>
                          </div>
                          <div className="mt-1 truncate pl-3.5 font-mono text-xs text-ink-3">
                            {probe?.version || agent.command}
                          </div>
                        </div>
                        <div
                          className="flex shrink-0 items-center gap-0.5 opacity-75 transition-opacity group-hover:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            title="探测可执行状态"
                            onClick={() => void probeAgent(agent.id)}
                            className="rounded-md p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"
                          >
                            <Activity size={12} />
                          </button>
                          <button
                            type="button"
                            title="编辑"
                            onClick={() => openEditProfile(agent)}
                            className="rounded-md p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            title="删除"
                            onClick={() => void removeAgent(agent.id)}
                            className="rounded-md p-1 text-ink-3 hover:bg-rose-500/10 hover:text-rose-600"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>

                      {probe && !probe.ready ? (
                        <div className="mt-1.5 pl-3.5 text-xs text-rose-700 dark:text-rose-300">
                          {probe.reason || '未找到可执行文件'}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Section 4: 本机历史会话 */}
          <section className="space-y-2 border-t border-line/70 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-2">
                本机历史会话 ({externalLocalSessions.length})
              </span>
              {discoveringLocalSessions ? (
                <Loader2 size={12} className="animate-spin text-ink-3" />
              ) : null}
            </div>
            {externalLocalSessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line bg-surface-3/60 p-3 text-xs text-ink-3">
                暂无可恢复的本机 Antigravity / Codex / Claude 历史会话。
              </div>
            ) : (
              <div className="space-y-1.5">
                {externalLocalSessions.slice(0, 8).map((item) => {
                  const busy = resumingLocalId === item.nativeSessionId;
                  return (
                    <button
                      key={`${item.provider}:${item.sourceScope ?? 'default'}:${item.nativeSessionId}`}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setNativeStoppedConfirmed(false);
                        setNativePreview({ item, messages: [], loading: true, error: null });
                        void acpLocalSessionMessages({ provider: item.provider, sessionId: item.nativeSessionId, sourcePath: item.sourcePath, sourceScope: item.sourceScope, limit: 24 }).then((messages) => {
                          setNativePreview((current) => current?.item === item ? { item, messages, loading: false, error: null } : current);
                        }).catch((error: unknown) => setNativePreview((current) => current?.item === item ? { ...current, loading: false, error: `历史读取失败：${error instanceof Error ? error.message : String(error)}` } : current));
                      }}
                      className="w-full rounded-xl border border-line bg-surface-4 p-2.5 text-left transition hover:border-primary/40 disabled:opacity-60"
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="truncate text-xs font-semibold text-ink">
                          {item.title}
                        </span>
                        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                          {providerDisplayLabel(item.provider)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-ink-3">
                        <span className="truncate font-mono">
                          {basenameOfPath(item.workspaceRoot)}
                        </span>
                        <span>{item.runtimeStatus === 'running' ? '运行中 · 只读' : item.runtimeStatus === 'unknown' ? '活动状态未知 · 只读' : formatTime(item.updatedAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {nativePreview ? (
              <div className="space-y-2 rounded-xl border border-line bg-surface-4 p-3 text-xs" data-testid="native-session-preview">
                <div className="font-semibold text-ink">{nativePreview.item.title}</div>
                <div className="break-all font-mono text-ink-3">{nativePreview.item.workspaceRoot}</div>
                <div className="break-all text-ink-3">来源：{nativePreview.item.sourceScope ?? '默认本机来源'}</div>
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {nativePreview.loading ? <p className="text-ink-3">正在读取原生对话记录…</p> : nativePreview.error ? <p className="text-rose-600" role="alert">{nativePreview.error}</p> : nativePreview.messages.length ? nativePreview.messages.map((message) => <p key={message.id} className="whitespace-pre-wrap break-words text-ink-2">{message.role === 'user' ? '你：' : 'Agent：'}{message.text}</p>) : <p className="text-ink-3">暂无可读取的对话记录</p>}
                </div>
                {nativePreview.item.provider === 'codex' ? <>
                  <p className="text-ink-3">系统尚未确认原端是否停止。请先在原 Codex 停止执行；交接后请从 RocketX 继续，避免两端同时写入。</p>
                  <label className="flex items-start gap-2 text-ink-2"><input type="checkbox" checked={nativeStoppedConfirmed} onChange={(event) => setNativeStoppedConfirmed(event.target.checked)} />我已停止原端执行，将此会话交接给 RocketX</label>
                  <button type="button" disabled={!nativeStoppedConfirmed || Boolean(resumingLocalId)} onClick={() => void handleResumeDiscoveredSession(nativePreview.item)} className="rounded-lg bg-primary px-3 py-1.5 font-medium text-white disabled:opacity-50">原端已停止，接续原会话</button>
                </> : <p className="text-ink-3">当前仅查看历史；该来源尚无经过验证的原生交接通道。</p>}
                <button type="button" onClick={() => setNativePreview(null)} className="ml-2 text-ink-3">关闭预览</button>
              </div>
            ) : null}
          </section>
          </div>
          </aside>
          </>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-3">
          {!activeSession ? (
            <div className="flex-1 overflow-y-auto px-5 py-8 md:px-8">
              <div className="mx-auto max-w-2xl space-y-6">
                {/* 居中高工艺启动台 */}
                <section className="rounded-2xl border border-line bg-surface-4 p-6 shadow-card">
                  <div className="flex items-start gap-3.5 border-b border-line-soft pb-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
                      <Bot size={20} />
                    </div>
                    <div>
                      <h2 className="text-base font-semibold text-ink">
                        开始一项工作
                      </h2>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-3">
                        直连本机安装的 Codex、Antigravity、Claude Code、Kimi、Copilot 或 Gemini CLI，在统一控制台中查看实时计划、文件 Diff 与权限审批。
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 space-y-4 text-xs">
                    {/* 1. 选择目标客户端 */}
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <label className="font-semibold text-ink-2">目标 ACP 客户端</label>
                        {unadoptedCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => void handleAdoptAll()}
                            className="font-medium text-primary hover:underline"
                          >
                            一键接入本机发现的 {unadoptedCount} 个客户端
                          </button>
                        ) : null}
                      </div>
                      {agents.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {agents.map((agent) => {
                            const selected = launchAgentId === agent.id;
                            const transport = resolveTransportLabel(agent.preset, agent.args);
                            return (
                              <button
                                key={agent.id}
                                type="button"
                                onClick={() => {
                                  setLaunchAgentId(agent.id);
                                  setSelectedAcpAgentId(agent.id);
                                }}
                                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs transition ${
                                  selected
                                    ? 'border-primary bg-primary/10 font-semibold text-primary shadow-raise'
                                    : 'border-line bg-surface-2 text-ink-2 hover:border-line-hover hover:text-ink'
                                }`}
                              >
                                <span>{agent.name}</span>
                                <span className="rounded-full bg-fill-2 px-1.5 py-0.5 text-2xs font-normal text-ink-3">
                                  {transport}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-line bg-surface-2 px-3 py-2.5 text-ink-3">
                          暂无已接入执行器。打开“管理执行器”接入本机工具，或从下方预设添加。
                        </div>
                      )}
                    </div>

                    {/* 2. 工作区目录 */}
                    <div>
                      <label className="mb-1.5 block font-semibold text-ink-2">
                        工作区根目录
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          value={workspaceRoot}
                          onChange={(e) => setWorkspaceRoot(e.target.value)}
                          placeholder="输入或选择本地项目目录（如 d:\Repos\rocketchatx）"
                          className="h-9 min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 font-mono text-xs text-ink outline-none focus:border-primary"
                        />
                        {isTauriRuntime() ? (
                          <button
                            type="button"
                            onClick={() => void handlePickWorkspace()}
                            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-surface-2 px-3 text-xs font-medium text-ink-2 transition hover:bg-fill-hover hover:text-ink"
                          >
                            <FolderOpen size={14} />
                            <span>浏览目录</span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* 3. 权限与自主策略分段控件 */}
                    <div>
                      <label className="mb-1.5 block font-semibold text-ink-2">
                        权限与安全策略
                      </label>
                      <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-line-soft bg-surface-2 p-1">
                        {(
                          [
                            { key: 'confirm' as const, label: '确认审批', hint: '变更前询问' },
                            { key: 'autonomous' as const, label: '半自主', hint: '只读自动放行' },
                            { key: 'readonly' as const, label: '严格只读', hint: '拒绝写入与终端' },
                          ] as const
                        ).map((opt) => (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => setAutonomyMode(opt.key)}
                            className={`rounded-lg px-2.5 py-2 text-left transition ${
                              autonomyMode === opt.key
                                ? 'bg-surface-4 font-semibold text-ink shadow-raise ring-1 ring-line'
                                : 'text-ink-3 hover:text-ink'
                            }`}
                          >
                            <div className="text-xs font-medium">{opt.label}</div>
                            <div className="text-xs text-ink-3">{opt.hint}</div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 4. 可选关联卡片 + 恢复会话 */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1.5 block font-semibold text-ink-2">
                          关联任务卡片（可选）
                        </span>
                        <select
                          value={linkedTodoId}
                          onChange={(e) => setLinkedTodoId(e.target.value)}
                          className="h-9 w-full rounded-xl border border-line bg-surface-2 px-3 text-xs text-ink outline-none focus:border-primary"
                        >
                          <option value="">不关联具体卡片</option>
                          {cards.slice(0, 40).map((card) => (
                            <option key={card.id} value={card.id}>
                              {card.title}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div>
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="font-semibold text-ink-2">会话模式</span>
                          <button
                            type="button"
                            onClick={() => setShowResumeInput((v) => !v)}
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            <History size={12} />
                            <span>{showResumeInput ? '切换为新会话' : '恢复已有会话'}</span>
                          </button>
                        </div>
                        {showResumeInput ? (
                          <input
                            value={resumeSessionId}
                            onChange={(e) => setResumeSessionId(e.target.value)}
                            placeholder="输入要恢复的 ACP sessionId"
                            className="h-9 w-full rounded-xl border border-line bg-surface-2 px-3 font-mono text-xs text-ink outline-none focus:border-primary"
                          />
                        ) : (
                          <div className="flex h-9 items-center rounded-xl border border-line-soft bg-surface-2 px-3 text-ink-3">
                            新建洁净 ACP 协议会话并同步至工作台
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 启动按钮 */}
                    <div className="pt-1">
                      <button
                        type="button"
                        disabled={launching || !launchAgentId}
                        onClick={() => void handleLaunchSession()}
                        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-xs font-semibold text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
                      >
                        {launching ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <Play size={14} />
                        )}
                        <span>{showResumeInput ? '加载并恢复 ACP 会话' : '启动 ACP 会话'}</span>
                      </button>
                    </div>
                  </div>
                </section>

                {/* 本机历史会话：Antigravity / Codex / Claude 跨工作区发现与一键恢复 / 转入看板 */}
                <section className="rounded-2xl border border-line bg-surface-4 p-5 shadow-raise">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink">
                        <History size={14} className="text-primary" />
                        本机历史会话 ({externalLocalSessions.length})
                      </span>
                      <div className="flex flex-wrap items-center gap-1">
                        {(
                          [
                            { key: 'all', label: '全部' },
                            { key: 'antigravity', label: 'Antigravity' },
                            { key: 'codex', label: 'Codex' },
                            { key: 'claude', label: 'Claude' },
                          ] as const
                        ).map((tab) => (
                          <button
                            key={tab.key}
                            type="button"
                            onClick={() => setHistoryProviderFilter(tab.key)}
                            className={`rounded-full px-2 py-0.5 text-2xs font-medium transition ${
                              historyProviderFilter === tab.key
                                ? 'bg-primary text-white'
                                : 'bg-fill-2 text-ink-3 hover:text-ink'
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setButlerView('kanban')}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      前往统一看板
                    </button>
                  </div>

                  {filteredExternalSessions.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-line bg-surface-3/60 px-3 py-4 text-center text-xs text-ink-3">
                      {discoveringLocalSessions
                        ? '正在扫描本机历史会话…'
                        : '暂未发现匹配的本机 Antigravity / Codex / Claude 历史会话，可在“管理执行器”中重新扫描本机。'}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filteredExternalSessions.slice(0, 12).map((item) => {
                        const busy = resumingLocalId === item.nativeSessionId;
                        return (
                          <div
                            key={`${item.provider}:${item.nativeSessionId}`}
                            className="flex flex-col justify-between gap-2 rounded-xl border border-line bg-surface-3 p-3 sm:flex-row sm:items-center"
                          >
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-semibold text-primary">
                                  {providerDisplayLabel(item.provider)}
                                </span>
                                {item.runtimeStatus === 'running' && (
                                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning">
                                    运行中
                                  </span>
                                )}
                                <span className="truncate text-xs font-semibold text-ink">
                                  {item.title}
                                </span>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                                <span className="font-mono">
                                  {basenameOfPath(item.workspaceRoot)}
                                </span>
                                {item.stepCount != null && <span>{item.stepCount} 步</span>}
                                <span>{formatTime(item.updatedAt)}</span>
                              </div>
                              {item.preview && (
                                <p className="line-clamp-1 text-xs text-ink-3">
                                  {item.preview}
                                </p>
                              )}
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleResumeDiscoveredSession(item)}
                                className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
                              >
                                {busy ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <Play size={12} />
                                )}
                                <span>恢复续聊</span>
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handlePromoteDiscoveredSession(item)}
                                className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-4 px-2.5 py-1.5 text-xs font-medium text-ink-2 shadow-raise transition hover:bg-fill-hover hover:text-ink disabled:opacity-50"
                              >
                                <Plus size={12} />
                                <span>转入看板</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* 支持的全部 CLI 预设生态胶囊 */}
                <section className="rounded-2xl border border-line bg-surface-4/70 p-4">
                  <div className="mb-2.5 flex items-center justify-between text-xs">
                    <span className="font-semibold text-ink-2">支持的 ACP 客户端预设模板</span>
                    <span className="text-ink-3">点击预设即可快速手动登记</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ACP_PRESET_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.preset}
                        type="button"
                        title={tpl.description}
                        onClick={() => applyPresetTemplate(tpl.preset)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-4 px-3 py-1 text-xs text-ink-2 shadow-raise transition hover:border-primary/40 hover:text-ink"
                      >
                        <span className="font-medium text-ink">+ {tpl.name}</span>
                        {tpl.transportLabel ? (
                          <span className="rounded-full bg-fill-2 px-1.5 py-0.5 text-2xs text-ink-3">
                            {tpl.transportLabel}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1">
                <div className="rcx-acp-conversation flex min-h-0 min-w-0 flex-1 flex-col">
                  {/* 权限审批请求卡片队列 */}
                  {activeSession.pendingPermissions.length > 0 ? (
                    <div className="space-y-2 border-b border-amber-500/30 bg-amber-500/5 px-5 py-3">
                      {activeSession.pendingPermissions.map((req) => (
                        <div
                          key={req.requestId}
                          className="mx-auto max-w-3xl rounded-2xl border border-amber-500/35 bg-surface-4 p-3.5 shadow-card"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                                <ShieldAlert size={14} />
                                <span>
                                  权限请求：{req.toolCall.title || req.toolCall.kind || '工具执行'}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-ink-2">{req.reason}</p>
                              {req.toolCall.locations && req.toolCall.locations.length > 0 ? (
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                  {req.toolCall.locations.map((loc, idx) => (
                                    <span
                                      key={`${loc.path}-${idx}`}
                                      className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink-3"
                                    >
                                      {loc.path}
                                      {loc.line ? `:${loc.line}` : ''}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {req.options.map((opt) => {
                              const isAllow =
                                opt.kind === 'allow_once' || opt.kind === 'allow_always';
                              return (
                                <button
                                  key={opt.optionId}
                                  type="button"
                                  onClick={() =>
                                    void resolvePermission(
                                      activeSession.sessionKey,
                                      req.requestId,
                                      opt.optionId,
                                    )
                                  }
                                  className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                                    isAllow
                                      ? 'bg-primary text-white shadow-raise hover:bg-primary-hover'
                                      : 'border border-line bg-surface-2 text-ink-2 hover:bg-fill-hover'
                                  }`}
                                >
                                  {isAllow ? <ShieldCheck size={12} /> : null}
                                  {opt.name}
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              onClick={() =>
                                void resolvePermission(
                                  activeSession.sessionKey,
                                  req.requestId,
                                  null,
                                )
                              }
                              className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
                            >
                              拒绝并取消
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* 消息滚动区 */}
                  <div ref={transcriptRef} onScroll={onTranscriptScroll} role="log" aria-label="执行器会话记录" className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
                    <div className="mx-auto max-w-3xl space-y-4">
                      {activeSession.messages.length === 0 &&
                      !activeSession.streamingText &&
                      !activeSession.streamingThought ? (
                        <div className="rounded-2xl border border-dashed border-line bg-surface-4/60 p-6 text-center text-xs text-ink-3">
                          <div className="mb-1 text-sm font-semibold text-ink">
                            {activeSession.agentName} 已连接就绪
                          </div>
                          <div>
                            在下方输入任务目标，系统将结合工作区代码与长期记忆实时协作出结果。
                          </div>
                        </div>
                      ) : null}

                      {activeSession.messages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`rounded-2xl border p-4 ${
                            msg.role === 'user'
                              ? 'ml-10 border-primary/25 bg-primary/8'
                              : 'mr-4 border-line bg-surface-4 shadow-raise'
                          }`}
                        >
                          <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-ink-3">
                            <span className="font-semibold text-ink-2">
                              {msg.role === 'user' ? '我' : activeSession.agentName}
                            </span>
                            <span>{formatTime(msg.timestamp)}</span>
                          </div>

                          {msg.thoughts ? (
                            <details className="mb-2.5 rounded-xl border border-line-soft bg-surface-2 px-3 py-2 text-xs text-ink-3">
                              <summary className="cursor-pointer font-medium text-ink-2">
                                推理思考过程
                              </summary>
                              <pre className="mt-1.5 whitespace-pre-wrap font-sans text-xs leading-relaxed text-ink-3">
                                {msg.thoughts}
                              </pre>
                            </details>
                          ) : null}

                          {msg.role === 'assistant' ? (
                            <div className="prose prose-sm max-w-none text-xs leading-relaxed text-ink dark:prose-invert">
                              {renderMarkdownDoc(msg.text || '')}
                            </div>
                          ) : (
                            <div className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
                              {msg.text}
                            </div>
                          )}
                        </div>
                      ))}

                      {activeSession.streamingThought ? (
                        <div className="mr-4 rounded-2xl border border-line bg-surface-4 p-3.5 shadow-raise">
                          <button
                            type="button"
                            onClick={() => setThoughtExpanded((v) => !v)}
                            className="flex w-full items-center justify-between text-xs font-medium text-ink-2"
                          >
                            <span className="inline-flex items-center gap-1.5">
                              <Sparkles size={13} className="text-primary" />
                              实时推理思考
                            </span>
                            {thoughtExpanded ? (
                              <ChevronDown size={14} />
                            ) : (
                              <ChevronRight size={14} />
                            )}
                          </button>
                          {thoughtExpanded ? (
                            <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-ink-3">
                              {activeSession.streamingThought}
                            </pre>
                          ) : null}
                        </div>
                      ) : null}

                      {activeSession.streamingText ? (
                        <div className="mr-4 rounded-2xl border border-primary/30 bg-surface-4 p-4 shadow-card">
                          <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-primary">
                            <Loader2 size={12} className="animate-spin" />
                            <span>{activeSession.agentName} 正在生成回复…</span>
                          </div>
                          <div className="prose prose-sm max-w-none text-xs leading-relaxed text-ink dark:prose-invert">
                            {activeStreamingDoc}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* 底部悬浮 Composer Dock */}
                  <div className="rcx-acp-composer shrink-0 px-5 pb-4 pt-2">
                    <div className="mx-auto max-w-3xl rounded-2xl border border-line bg-surface-4 p-3 shadow-card">
                      <AgentComposerFeedback draft={draft} onRetry={retryRequest} />
                      {activeSession.error && <p role="alert" className="mb-2 whitespace-pre-wrap break-words text-xs text-danger">{activeSession.error}</p>}
                      {!connectionReady && <p role="status" className="mb-2 text-xs text-ink-3">执行连接尚未建立，要求会保留为草稿；已有记录仍可查看。</p>}
                      <LocalVoiceControls
                        targetKey={composerKey}
                        disabled={!draft.loaded || activeSession.status === 'stopped'}
                        replyText={[...activeSession.messages].reverse().find((message) => message.role === 'assistant')?.text ?? ''}
                        onTranscript={(text) => {
                          const current = useAgentComposerDrafts.getState().drafts[composerKey]?.text ?? '';
                          useAgentComposerDrafts.getState().edit(composerKey, { text: [current, text].filter(Boolean).join('\n') });
                        }}
                      />
                      {activeSession.availableCommands.length > 0 ? (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {activeSession.availableCommands.slice(0, 8).map((cmd) => (
                            <button
                              key={cmd.name}
                              type="button"
                              title={cmd.description}
                              onClick={() =>
                                setComposerText((prev) =>
                                  prev ? `${prev} /${cmd.name} ` : `/${cmd.name} `,
                                )
                              }
                              className="rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-2xs text-ink-2 hover:border-primary/40 hover:text-ink"
                            >
                              /{cmd.name}
                            </button>
                          ))}
                        </div>
                      ) : null}

                      <textarea
                        data-work-composer="acp"
                        data-work-session-id={activeSession.nativeSessionId ?? activeSession.acpSessionId ?? ''}
                        rows={2}
                        value={composerText}
                        onChange={(e) => setComposerText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                            e.preventDefault();
                            void handleSendPrompt();
                          }
                        }}
                        placeholder={
                          !connectionReady ? '可先写下要求，连接成功后再发送…' : activeSession.status === 'running'
                            ? '执行中：输入补充指导（Enter 发送）…'
                            : '向当前 ACP 客户端发送任务指令（Enter 发送，Shift+Enter 换行）…'
                        }
                        className="w-full resize-none rounded-xl border border-line-soft bg-surface-2 px-3 py-2 text-xs text-ink outline-none focus:border-primary"
                      />

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-ink-3">
                          <input
                            type="checkbox"
                            checked={injectMemory}
                            onChange={(e) => setInjectMemory(e.target.checked)}
                            className="rounded border-line"
                          />
                          自动召回相关长期记忆
                        </label>
                        <button
                          type="button"
                          disabled={
                            sending ||
                            !draft.loaded ||
                            !composerText.trim() ||
                            !connectionReady
                          }
                          onClick={() => void handleSendPrompt()}
                          className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
                        >
                          {sending ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Send size={13} />
                          )}
                          <span>
                            {activeSession.status === 'running' ? '发送补充指导' : '发送指令'}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {auxiliaryPanel === 'details' ? (
                  <>
                  <div className="rcx-acp-panel-backdrop" onClick={() => setAuxiliaryPanel(null)} aria-hidden="true" />
                  <aside
                    ref={auxiliaryPanelRef}
                    id="acp-task-details"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="acp-task-details-title"
                    className="rcx-acp-panel rcx-acp-inspector flex min-h-0 flex-col border-l border-line bg-surface-2 shadow-card"
                  >
                    <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
                      <h2 id="acp-task-details-title" className="text-sm font-semibold text-ink">任务详情</h2>
                      <button type="button" data-panel-close aria-label="关闭任务详情" onClick={() => setAuxiliaryPanel(null)} className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"><X size={16} /></button>
                    </div>
                    {activeSession.modes && activeSession.modes.availableModes.length > 0 ? (
                      <div className="shrink-0 border-b border-line px-4 py-3">
                        <h3 className="mb-2 text-xs font-medium text-ink-2">执行权限</h3>
                        <div className="flex flex-wrap gap-1.5">
                          {activeSession.modes.availableModes.map((mode) => (
                            <button
                              key={mode.id}
                              type="button"
                              title={mode.description || mode.name}
                              aria-pressed={mode.id === activeSession.modes?.currentModeId}
                              onClick={() => void setMode(activeSession.sessionKey, mode.id)}
                              className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${mode.id === activeSession.modes?.currentModeId ? 'border-primary/35 bg-primary/10 font-medium text-primary' : 'border-line bg-surface-4 text-ink-3 hover:text-ink'}`}
                            >
                              {mode.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="grid shrink-0 grid-cols-4 border-b border-line bg-surface-4/60 text-xs">
                      <button
                        type="button"
                        onClick={() => setInspectorTab('plan')}
                        className={`flex items-center justify-center gap-1 py-2.5 font-medium transition ${
                          inspectorTab === 'plan'
                            ? 'border-b-2 border-primary bg-surface-4 text-primary'
                            : 'text-ink-3 hover:text-ink'
                        }`}
                      >
                        <ListChecks size={12} />
                        <span>执行计划</span>
                        {activeSession.plan.length > 0 ? (
                          <span className="rounded-full bg-fill-2 px-1.5 text-2xs">
                            {completedPlanCount}/{activeSession.plan.length}
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        onClick={() => setInspectorTab('tools')}
                        className={`flex items-center justify-center gap-1 py-2.5 font-medium transition ${
                          inspectorTab === 'tools'
                            ? 'border-b-2 border-primary bg-surface-4 text-primary'
                            : 'text-ink-3 hover:text-ink'
                        }`}
                      >
                        <Wrench size={12} />
                        <span>工具轨迹</span>
                        {activeSession.toolCalls.length > 0 ? (
                          <span className="rounded-full bg-fill-2 px-1.5 text-2xs">
                            {activeSession.toolCalls.length}
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        onClick={() => setInspectorTab('report')}
                        className={`flex items-center justify-center gap-1 py-2.5 font-medium transition ${
                          inspectorTab === 'report'
                            ? 'border-b-2 border-primary bg-surface-4 text-primary'
                            : 'text-ink-3 hover:text-ink'
                        }`}
                      >
                        <FileText size={12} />
                        <span>工作流汇报</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setInspectorTab('logs')}
                        className={`flex items-center justify-center gap-1 py-2.5 font-medium transition ${
                          inspectorTab === 'logs'
                            ? 'border-b-2 border-primary bg-surface-4 text-primary'
                            : 'text-ink-3 hover:text-ink'
                        }`}
                      >
                        <Terminal size={12} />
                        <span>进程日志</span>
                      </button>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
                      {linkedCard ? <p className="mb-3 break-words text-xs text-ink-3">关联工作：{linkedCard.title}</p> : null}
                      {inspectorTab === 'plan' ? (
                        activeSession.plan.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-line bg-surface-4/60 p-4 text-xs text-ink-3">
                            当前会话尚未产生结构化执行计划。代理发送 ACP 计划更新后将实时展示于此。
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {activeSession.plan.map((entry, idx) => (
                              <div
                                key={`${idx}-${entry.content.slice(0, 24)}`}
                                className="rounded-xl border border-line bg-surface-4 p-3 text-xs shadow-raise"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <span className="font-medium text-ink">{entry.content}</span>
                                  <span
                                    className={`shrink-0 rounded-full border px-2 py-0.5 text-2xs ${
                                      entry.status === 'completed'
                                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                        : entry.status === 'in_progress'
                                          ? 'border-primary/30 bg-primary/10 text-primary'
                                          : 'border-line bg-surface-2 text-ink-3'
                                    }`}
                                  >
                                    {entry.status === 'completed'
                                      ? '已完成'
                                      : entry.status === 'in_progress'
                                        ? '进行中'
                                        : '待执行'}
                                  </span>
                                </div>
                                <div className="mt-1 text-xs text-ink-3">
                                  优先级：{entry.priority}
                                </div>
                              </div>
                            ))}
                          </div>
                        )
                      ) : null}

                      {inspectorTab === 'tools' ? (
                        activeSession.toolCalls.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-line bg-surface-4/60 p-4 text-xs text-ink-3">
                            暂无工具调用记录。
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {activeSession.toolCalls.map((tool) => {
                              const open = Boolean(expandedToolIds[tool.toolCallId]);
                              return (
                                <div
                                  key={tool.toolCallId}
                                  className="rounded-xl border border-line bg-surface-4 p-3 text-xs shadow-raise"
                                >
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedToolIds((prev) => ({
                                        ...prev,
                                        [tool.toolCallId]: !open,
                                      }))
                                    }
                                    className="flex w-full items-center justify-between gap-2 text-left"
                                  >
                                    <div className="min-w-0">
                                      <div className="truncate font-semibold text-ink">
                                        {tool.title || tool.toolCallId}
                                      </div>
                                      <div className="mt-0.5 text-xs text-ink-3">
                                        {tool.kind || 'other'} · {tool.status || 'pending'}
                                      </div>
                                    </div>
                                    {open ? (
                                      <ChevronDown size={14} className="shrink-0 text-ink-3" />
                                    ) : (
                                      <ChevronRight size={14} className="shrink-0 text-ink-3" />
                                    )}
                                  </button>

                                  {open ? (
                                    <div className="mt-2 space-y-2 border-t border-line-soft pt-2">
                                      {tool.locations && tool.locations.length > 0 ? (
                                        <div className="flex flex-wrap gap-1">
                                          {tool.locations.map((loc, idx) => (
                                            <span
                                              key={`${loc.path}-${idx}`}
                                              className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink-3"
                                            >
                                              {loc.path}
                                              {loc.line ? `:${loc.line}` : ''}
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}

                                      {tool.content && tool.content.length > 0 ? (
                                        <div className="space-y-1.5">
                                          {tool.content.map((block, idx) => {
                                            if (block.type === 'diff') {
                                              return (
                                                <div
                                                  key={idx}
                                                  className="rounded-lg border border-line bg-surface-2 p-2 font-mono text-xs"
                                                >
                                                  <div className="mb-1 text-ink-2">
                                                    Diff: {block.path}
                                                  </div>
                                                  {block.oldText ? (
                                                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap text-rose-700 dark:text-rose-300">
                                                      {block.oldText}
                                                    </pre>
                                                  ) : null}
                                                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-emerald-700 dark:text-emerald-300">
                                                    {block.newText}
                                                  </pre>
                                                </div>
                                              );
                                            }
                                            if (block.type === 'terminal') {
                                              return (
                                                <div
                                                  key={idx}
                                                  className="rounded border border-line bg-surface-2 px-2 py-1 font-mono text-xs text-ink-2"
                                                >
                                                  终端输出 ID: {block.terminalId}
                                                </div>
                                              );
                                            }
                                            return (
                                              <pre
                                                key={idx}
                                                className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface-2 p-2 font-mono text-xs text-ink-2"
                                              >
                                                {block.content.type === 'text'
                                                  ? block.content.text
                                                  : JSON.stringify(block.content)}
                                              </pre>
                                            );
                                          })}
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        )
                      ) : null}

                      {inspectorTab === 'report' ? (
                        workflowReport ? (
                          <WorkflowReportCard report={workflowReport} compact />
                        ) : (
                          <div className="rounded-xl border border-dashed border-line bg-surface-4/60 p-4 text-xs text-ink-3">
                            暂无可汇总的工作流汇报。
                          </div>
                        )
                      ) : null}

                      {inspectorTab === 'logs' ? (
                        activeSession.stderrLogs.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-line bg-surface-4/60 p-4 text-xs text-ink-3">
                            暂无标准错误日志输出。
                          </div>
                        ) : (
                          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-surface-4 p-3 font-mono text-xs text-ink-3">
                            {activeSession.stderrLogs.join('\n')}
                          </pre>
                        )
                      ) : null}
                    </div>
                  </aside>
                  </>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
