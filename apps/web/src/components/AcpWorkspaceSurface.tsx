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
  GitCompare,
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
import { acpLocalSessionMessages, listWorkspaceFiles, type LocalSessionMessage,
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
import { applyComposerReplacement, detectComposerTrigger, type ActiveComposerToken } from '../lib/composerCommands';
import { ButlerComposerFilePopover } from './ButlerComposerPopovers';
import ButlerTerminalDrawer from './ButlerTerminalDrawer';
import ShareToRoomButton from './ShareToRoomButton';
import PullAiToChatButton from './PullAiToChatButton';
import WorkDiffDrawer from './WorkDiffDrawer';
import { useAuth } from '../stores/auth';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { useAgentComposerDraft, useAgentComposerDrafts, type AgentComposerRequest } from '../stores/agentComposerDrafts';
import AgentComposerFeedback from './AgentComposerFeedback';
import LocalVoiceControls from './LocalVoiceControls';
import WorkflowReportCard from './WorkflowReportCard';
import { t as rawT, useI18n, type ResolvedLocale } from '../i18n';
import { formatTime } from '../i18n/format';

type InspectorTab = 'plan' | 'tools' | 'report' | 'logs';

function statusBadgeMeta(
  status: AcpManagedSessionState['status'],
  tFn: typeof rawT = rawT,
): {
  label: string;
  dotClass: string;
  className: string;
} {
  switch (status) {
    case 'running':
      return {
        label: tFn('agent.acpSurface.status.running'),
        dotClass: 'bg-primary animate-pulse',
        className: 'border-primary/30 bg-primary/10 text-primary',
      };
    case 'waiting_approval':
      return {
        label: tFn('agent.acpSurface.status.waitingApproval'),
        dotClass: 'bg-amber-500 animate-pulse',
        className: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      };
    case 'ready':
      return {
        label: tFn('agent.acpSurface.status.ready'),
        dotClass: 'bg-emerald-500',
        className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      };
    case 'connecting':
      return {
        label: tFn('agent.acpSurface.status.connecting'),
        dotClass: 'bg-ink-3',
        className: 'border-line bg-surface-2 text-ink-2',
      };
    case 'error':
      return {
        label: tFn('agent.acpSurface.status.error'),
        dotClass: 'bg-rose-500',
        className: 'border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300',
      };
    case 'stopped':
    default:
      return {
        label: tFn('agent.acpSurface.status.stopped'),
        dotClass: 'bg-ink-4',
        className: 'border-line bg-surface-2 text-ink-3',
      };
  }
}

function resolveTransportKind(preset: string, args: string[]): 'bridge' | 'native' {
  if (args.some((a) => a.startsWith('--rocketx-acp-bridge='))) {
    return 'bridge';
  }
  const tpl = ACP_PRESET_TEMPLATES.find((t) => t.preset === preset);
  if (tpl?.args.some((a) => a.startsWith('--rocketx-acp-bridge='))) {
    return 'bridge';
  }
  return 'native';
}

function formatSessionTime(ts: number, locale: ResolvedLocale): string {
  if (!Number.isFinite(ts)) return '';
  try {
    return formatTime(
      ts,
      {
        hour: '2-digit',
        minute: '2-digit',
      },
      locale,
    );
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

function basenameOfPath(p: string, tFn: typeof rawT = rawT): string {
  const clean = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!clean) return tFn('agent.kanban.unknownWorkspace');
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

export default function AcpWorkspaceSurface() {
  const { t, locale } = useI18n();
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
  const setModel = useAcpAgents((s) => s.setModel);
  const enqueuePrompt = useAcpAgents((s) => s.enqueuePrompt);
  const removeQueuedPrompt = useAcpAgents((s) => s.removeQueuedPrompt);
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
  const [auxiliaryPanel, setAuxiliaryPanel] = useState<'executors' | 'details' | 'diff' | null>(null);
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
  const [acpTerminalOpen, setAcpTerminalOpen] = useState(false);
  const acpTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [acpFileToken, setAcpFileToken] = useState<ActiveComposerToken | null>(null);
  const [acpFiles, setAcpFiles] = useState<string[]>([]);
  const [acpFilesLoading, setAcpFilesLoading] = useState(false);
  const [acpFileIdx, setAcpFileIdx] = useState(0);

  useEffect(() => {
    const wsRoot = activeSession?.workspaceRoot?.trim();
    if (!acpFileToken || !isTauriRuntime() || !wsRoot) {
      setAcpFiles([]);
      return;
    }
    let cancelled = false;
    setAcpFilesLoading(true);
    void listWorkspaceFiles(wsRoot, acpFileToken.query, 40)
      .then((list) => {
        if (!cancelled) {
          setAcpFiles(list);
          setAcpFileIdx(0);
        }
      })
      .catch(() => {
        if (!cancelled) setAcpFiles([]);
      })
      .finally(() => {
        if (!cancelled) setAcpFilesLoading(false);
      });
    return () => { cancelled = true; };
  }, [acpFileToken, activeSession?.workspaceRoot]);

  const applyAcpFileSelection = (filePath: string) => {
    if (!acpFileToken) return;
    const { nextText, nextCursor } = applyComposerReplacement(composerText, acpFileToken, `@${filePath}`);
    setComposerText(nextText);
    setAcpFileToken(null);
    requestAnimationFrame(() => {
      acpTextareaRef.current?.focus();
      acpTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

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
    setFormName(tpl?.name || t('agent.acpPreset.custom.name'));
    setFormCommand(tpl?.command || '');
    setFormArgs((tpl?.args || []).join(' '));
    setFormCwd('');
    setFormDescription(tpl?.description || '');
    setFormAutoApprove(tpl?.defaultAutoApproveSafeReads ?? true);
    setShowProfileEditor(true);
    setAuxiliaryPanel('executors');
  }, [t]);

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
      setActionNotice(t('agent.acpSurface.notice.fillNameAndCommand'));
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
      toast.success(t('agent.acpSurface.toast.savedClient', { name: saved.name }));
    } catch (err) {
      setActionNotice(
        t('agent.acpSurface.notice.saveFailed', { error: err instanceof Error ? err.message : String(err) }),
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
    t,
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
            ? t('agent.acp.notes.detectedWithVersion', { version: candidate.version })
            : t('agent.acp.notes.detected'),
        });
        setLaunchAgentId(saved.id);
        setSelectedAcpAgentId(saved.id);
        toast.success(t('agent.acpSurface.toast.adoptedClient', { name: saved.name }));
      } catch (err) {
        setActionNotice(
          t('agent.acpSurface.notice.adoptFailed', { error: err instanceof Error ? err.message : String(err) }),
        );
      }
    },
    [setSelectedAcpAgentId, t, upsertAgent],
  );

  const handleAdoptAll = useCallback(async () => {
    setAdoptingAll(true);
    setActionNotice(null);
    try {
      const added = await adoptAllDiscoveredAgents();
      if (added.length > 0) {
        setLaunchAgentId(added[0].id);
        setSelectedAcpAgentId(added[0].id);
        toast.success(t('agent.acpSurface.toast.adoptedAllCount', { count: added.length }));
      } else {
        toast.info(t('agent.acpSurface.toast.allAlreadyAdopted'));
      }
    } catch (err) {
      setActionNotice(
        t('agent.acpSurface.notice.batchAdoptFailed', { error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setAdoptingAll(false);
    }
  }, [adoptAllDiscoveredAgents, setSelectedAcpAgentId, t]);

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
          t('agent.acpSurface.notice.resumeLocalFailed', { error: err instanceof Error ? err.message : String(err) }),
        );
      } finally {
        setResumingLocalId(null);
      }
    },
    [nativeStoppedConfirmed, resumeLocalSession, t],
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
        throw new Error(t('agent.acpSurface.error.cannotWriteLedger'));
      }
      const created = await promoteWorkSessionToCard(target);
      toast.success(t('agent.acpSurface.toast.promotedToBoard', { title: created.title }));
    } catch (err) {
      setActionNotice(
        t('agent.acpSurface.notice.promoteFailed', { error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setResumingLocalId(null);
    }
  }, [t]);

  const handlePickWorkspace = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const picked = await openDesktopDialog({
      directory: true,
      multiple: false,
      title: t('agent.acpSurface.pickWorkspaceTitle'),
    });
    if (typeof picked === 'string' && picked.trim()) {
      setWorkspaceRoot(picked.trim());
    }
  }, [t]);

  const handleLaunchSession = useCallback(async () => {
    const targetAgentId = launchAgentId || agents[0]?.id;
    const root = workspaceRoot.trim() || currentWorkspaceRoot || workspaceRoots[0] || '.';
    if (!targetAgentId) {
      setActionNotice(t('agent.acpSurface.notice.selectExecutorFirst'));
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
        t('agent.acpSurface.notice.launchFailed', { error: err instanceof Error ? err.message : String(err) }),
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
    t,
    workspaceRoot,
    workspaceRoots,
  ]);

  const dispatchRequest = async (request: AgentComposerRequest) => {
    let submitted = false;
    stickToBottom.current = true;
    try {
      if (`${getServerBase() || 'same-origin'}:${useAuth.getState().user?._id ?? 'local-user'}` !== request.target.scope) {
        throw new Error(t('agent.codexWorkspace.accountSwitchedSend'));
      }
      const session = useAcpAgents.getState().sessions[request.target.recipientId ?? ''];
      if (!session || !session.acpSessionId || session.connectionReady === false || session.workspaceRoot !== request.target.workspaceRoot || session.status === 'connecting' || session.status === 'stopped') {
        throw new Error(t('agent.codexWorkspace.sessionOrWorkspaceUnavailable'));
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
              title={t('agent.kanban.expandSidebarTitle')}
              aria-label={t('agent.kanban.expandSidebarAria')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
            >
              <PanelLeft size={16} />
            </button>
          ) : null}
          <div className="min-w-0">
            <h1 className="break-words text-sm font-semibold leading-snug tracking-tight text-ink">
              {activeSession ? activeSession.title || activeSession.agentName : t('agent.acpSurface.header.fallbackTitle')}
            </h1>
            {activeSession ? (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                <span className={`inline-flex items-center gap-1.5 ${statusBadgeMeta(activeSession.status, t).className} rounded-full border px-2 py-0.5 text-2xs font-medium`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${statusBadgeMeta(activeSession.status, t).dotClass}`} />
                  {statusBadgeMeta(activeSession.status, t).label}
                </span>
                <span>{activeSession.agentName}</span>
                <span className="break-all font-mono text-xs">{activeSession.workspaceRoot}</span>
              </div>
            ) : (
              <p className="mt-1 text-xs text-ink-3">{t('agent.acpSurface.header.subtitle')}</p>
            )}
          </div>
        </div>

        <div className="rcx-acp-header-actions flex items-center gap-2">
          {sessions.length > 0 ? (
            <select
              aria-label={t('agent.acpSurface.header.switchSessionAria')}
              value={activeSessionKey || ''}
              onChange={(event) => setActiveSession(event.target.value || null)}
              className="h-8 min-w-0 max-w-44 rounded-lg border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
            >
              <option value="" disabled>{t('agent.acpSurface.header.selectSessionOption', { count: sessions.length })}</option>
              {sessions.map((session) => (
                <option key={session.sessionKey} value={session.sessionKey}>
                  {session.title || session.agentName} · {session.pendingPermissions.length > 0 ? t('agent.acpSurface.header.pendingApprovalCount', { count: session.pendingPermissions.length }) : statusBadgeMeta(session.status, t).label}
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
              <span>{t('agent.acpSurface.header.newSessionBtn')}</span>
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
            <span>{t('agent.acpSurface.header.manageExecutorsBtn')}</span>
          </button>
          {activeSession && activeSession.workspaceRoot?.trim() && isTauriRuntime() ? (
            <>
              <button
                type="button"
                aria-expanded={acpTerminalOpen}
                onClick={() => setAcpTerminalOpen((p) => !p)}
                title={t('agent.terminal.buttonTitle')}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover"
              >
                <Terminal size={13} aria-hidden="true" />
                <span>{t('agent.terminal.buttonLabel')}</span>
              </button>
              <button
                type="button"
                aria-expanded={auxiliaryPanel === 'diff'}
                onClick={() => setAuxiliaryPanel((p) => (p === 'diff' ? null : 'diff'))}
                title={t('agent.diff.buttonTitle')}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover"
              >
                <GitCompare size={13} aria-hidden="true" />
                <span>{t('agent.diff.buttonLabel')}</span>
              </button>
            </>
          ) : null}
          {activeSession ? (
            <>
              <ShareToRoomButton
                payload={{
                  kind: 'acp_session',
                  sessionKey: activeSession.sessionKey,
                  agentId: activeSession.agentId,
                  agentName: activeSession.agentName,
                  title: activeSession.title,
                  status: activeSession.status,
                  summary:
                    [...activeSession.messages].reverse().find((m) => m.role === 'assistant')?.text.slice(0, 240)
                    || activeSession.plan.map((p) => p.content).slice(0, 3).join(' · ')
                    || activeSession.title,
                  pendingApproval:
                    activeSession.pendingPermissions[0]?.toolCall.title
                    || activeSession.pendingPermissions[0]?.reason,
                  workspaceRoot: activeSession.workspaceRoot,
                }}
                bindableTarget={{
                  targetKind: 'acp_session',
                  targetId: activeSession.sessionKey,
                  label: `${activeSession.agentName}: ${activeSession.title}`,
                }}
              />
              <PullAiToChatButton
                source="acp_agent"
                agentKind="acp"
                agentId={activeSession.agentId}
                agentName={activeSession.agentName}
                acpSessionKey={activeSession.sessionKey}
                workspaceRoot={activeSession.workspaceRoot}
                summary={
                  [...activeSession.messages].reverse().find((m) => m.role === 'assistant')?.text.slice(0, 240)
                  || activeSession.title
                }
              />
            </>
          ) : null}
          {activeSession ? (
            <button
              type="button"
              aria-expanded={auxiliaryPanel === 'details'}
              aria-controls="acp-task-details"
              onClick={() => setAuxiliaryPanel('details')}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover"
            >
              <PanelRight size={13} />
              <span>{t('agent.acpSurface.header.taskDetailsBtn')}</span>
            </button>
          ) : null}
          {activeSession && (activeSession.status === 'running' || activeSession.status === 'waiting_approval') ? (
            <button
              type="button"
              onClick={() => void cancelTurn(activeSession.sessionKey)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 text-xs font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
            >
              <Square size={11} />
              <span>{t('agent.acpSurface.header.interruptBtn')}</span>
            </button>
          ) : null}
          {activeSession && activeSession.status !== 'stopped' ? (
            <button
              type="button"
              onClick={() => void stopSession(activeSession.sessionKey)}
              className="inline-flex h-8 items-center rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover"
            >
              {t('agent.acpSurface.header.stopBtn')}
            </button>
          ) : null}
        </div>
      </header>

      {loading ? <div role="status" className="border-b border-line px-5 py-2 text-xs text-ink-2">{t('agent.acpSurface.loadingBanner')}</div> : null}
      {expiredPermissions.some((item) => item.accountScope === resolveButlerAccountScope()) ? (
        <div role="status" className="border-b border-warning/30 bg-warning/10 px-5 py-2 text-xs text-ink">
          {t('agent.acpSurface.expiredPermissionsBanner', { count: expiredPermissions.filter((item) => item.accountScope === resolveButlerAccountScope()).length })}
        </div>
      ) : null}
      {lastError || actionNotice ? (
        <div role={lastError ? 'alert' : 'status'} className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-amber-500/10 px-5 py-2 text-xs text-ink">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{lastError ? t('agent.acpSurface.errorBannerSuffix', { error: lastError }) : actionNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => { if (lastError) { void hydrate(); void discoverLocalSessions(); } else setActionNotice(null); }}
            className="text-xs font-medium text-ink-3 hover:text-ink"
          >
            {lastError ? t('agent.acpSurface.reloadBtn') : t('common.close')}
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
              <h2 id="acp-executor-management-title" className="text-sm font-semibold text-ink">{t('agent.acpSurface.executors.title')}</h2>
              <p className="mt-1 text-xs text-ink-3">{t('agent.acpSurface.executors.subtitle', { adopted: agents.length, discovered: discovered.length })}</p>
            </div>
            <button type="button" data-panel-close aria-label={t('agent.acpSurface.executors.closeAria')} onClick={() => setAuxiliaryPanel(null)} className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"><X size={16} /></button>
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
                <span>{t('agent.acpSurface.executors.rescanBtn')}</span>
              </button>
              {unadoptedCount > 0 ? (
                <button type="button" disabled={adoptingAll} onClick={() => void handleAdoptAll()} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50">
                  {adoptingAll ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  <span>{t('agent.acpSurface.executors.adoptAllCountBtn', { count: unadoptedCount })}</span>
                </button>
              ) : null}
              <button type="button" onClick={() => applyPresetTemplate('custom')} className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 hover:bg-fill-hover">
                <Plus size={13} /><span>{t('agent.acpSurface.executors.addCustomBtn')}</span>
              </button>
            </div>
          {/* 快捷新增 / 编辑抽屉卡 */}
          {showProfileEditor ? (
            <section className="rounded-2xl border border-primary/35 bg-surface-4 p-3.5 shadow-card">
              <div className="mb-2.5 flex items-center justify-between">
                <h2 className="text-xs font-semibold text-ink">
                  {editingAgentId ? t('agent.acpSurface.executors.editFormTitle') : t('agent.acpSurface.executors.addFormTitle')}
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setShowProfileEditor(false);
                    setEditingAgentId(null);
                  }}
                  className="text-xs text-ink-3 hover:text-ink"
                >
                  {t('common.cancel')}
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
                  placeholder={t('agent.acpSurface.executors.namePlaceholder')}
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
                <input
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  placeholder={t('agent.acpSurface.executors.commandPlaceholder')}
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 font-mono text-xs text-ink outline-none focus:border-primary"
                />
                <input
                  value={formArgs}
                  onChange={(e) => setFormArgs(e.target.value)}
                  placeholder={t('agent.acpSurface.executors.argsPlaceholder')}
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 font-mono text-xs text-ink outline-none focus:border-primary"
                />
                <input
                  value={formCwd}
                  onChange={(e) => setFormCwd(e.target.value)}
                  placeholder={t('agent.acpSurface.executors.cwdPlaceholder')}
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
                <input
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder={t('agent.acpSurface.executors.descPlaceholder')}
                  className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
                <label className="flex items-center gap-2 text-xs text-ink-2">
                  <input
                    type="checkbox"
                    checked={formAutoApprove}
                    onChange={(e) => setFormAutoApprove(e.target.checked)}
                    className="rounded border-line"
                  />
                  {t('agent.acpSurface.executors.autoApproveReads')}
                </label>
                <button
                  type="button"
                  disabled={savingProfile}
                  onClick={() => void handleSaveProfile()}
                  className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
                >
                  {savingProfile ? <Loader2 size={13} className="animate-spin" /> : null}
                  {t('agent.acpSurface.executors.saveProfileBtn')}
                </button>
              </div>
            </section>
          ) : null}

          {/* Section 1: 发现本机 Agent */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-2">
                {t('agent.acpSurface.discovered.heading', { count: discovered.length })}
              </span>
              {unadoptedCount > 0 ? (
                <button
                  type="button"
                  disabled={adoptingAll}
                  onClick={() => void handleAdoptAll()}
                  className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                >
                  {t('agent.acpSurface.discovered.adoptAllBtn')}
                </button>
              ) : null}
            </div>

            {discovering && discovered.length === 0 ? (
              <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-4 p-3 text-xs text-ink-3 shadow-raise">
                <Loader2 size={13} className="animate-spin text-primary" />
                <span>{t('agent.acpSurface.discovered.scanning')}</span>
              </div>
            ) : discovered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line bg-surface-3/60 p-3 text-xs text-ink-3">
                {t('agent.acpSurface.discovered.empty')}
              </div>
            ) : (
              <div className="space-y-1.5">
                {discovered.map((cand) => {
                  const transportKind = resolveTransportKind(cand.preset, cand.args);
                  const transport = t(transportKind === 'bridge' ? 'agent.acpPreset.transport.bridge' : 'agent.acpPreset.transport.native');
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
                              transportKind === 'native'
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
                          {t('agent.acpSurface.discovered.adoptedBadge')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleAdoptCandidate(cand)}
                          className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
                        >
                          {t('agent.acpSurface.discovered.adoptBtn')}
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
                {t('agent.acpSurface.adopted.heading', { count: agents.length })}
              </span>
              {loading ? <Loader2 size={12} className="animate-spin text-ink-3" /> : null}
            </div>
            {agents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line bg-surface-3/60 p-3 text-xs text-ink-3">
                {t('agent.acpSurface.adopted.empty')}
              </div>
            ) : (
              <div className="space-y-1.5">
                {agents.map((agent) => {
                  const probe = probes[agent.id];
                  const selected = launchAgentId === agent.id;
                  const transportKind = resolveTransportKind(agent.preset, agent.args);
                  const transport = t(transportKind === 'bridge' ? 'agent.acpPreset.transport.bridge' : 'agent.acpPreset.transport.native');
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
                            title={t('agent.acpSurface.adopted.probeTitle')}
                            onClick={() => void probeAgent(agent.id)}
                            className="rounded-md p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"
                          >
                            <Activity size={12} />
                          </button>
                          <button
                            type="button"
                            title={t('common.edit')}
                            onClick={() => openEditProfile(agent)}
                            className="rounded-md p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            title={t('common.delete')}
                            onClick={() => void removeAgent(agent.id)}
                            className="rounded-md p-1 text-ink-3 hover:bg-rose-500/10 hover:text-rose-600"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>

                      {probe && !probe.ready ? (
                        <div className="mt-1.5 pl-3.5 text-xs text-rose-700 dark:text-rose-300">
                          {probe.reason || t('agent.acpSurface.adopted.executableMissing')}
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
                {t('agent.acpSurface.localHistory.heading', { count: externalLocalSessions.length })}
              </span>
              {discoveringLocalSessions ? (
                <Loader2 size={12} className="animate-spin text-ink-3" />
              ) : null}
            </div>
            {externalLocalSessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line bg-surface-3/60 p-3 text-xs text-ink-3">
                {t('agent.acpSurface.localHistory.empty')}
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
                        }).catch((error: unknown) => setNativePreview((current) => current?.item === item ? { ...current, loading: false, error: t('agent.acpSurface.localHistory.readError', { error: error instanceof Error ? error.message : String(error) }) } : current));
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
                          {basenameOfPath(item.workspaceRoot, t)}
                        </span>
                        <span>{item.runtimeStatus === 'running' ? t('agent.acpSurface.localHistory.runningReadonly') : item.runtimeStatus === 'unknown' ? t('agent.acpSurface.localHistory.unknownReadonly') : formatSessionTime(item.updatedAt, locale)}</span>
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
                <div className="break-all text-ink-3">{t('agent.acpSurface.localHistory.sourceLine', { scope: nativePreview.item.sourceScope ?? t('agent.acpSurface.localHistory.defaultLocalSource') })}</div>
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {nativePreview.loading ? <p className="text-ink-3">{t('agent.acpSurface.localHistory.loadingTranscript')}</p> : nativePreview.error ? <p className="text-rose-600" role="alert">{nativePreview.error}</p> : nativePreview.messages.length ? nativePreview.messages.map((message) => <p key={message.id} className="whitespace-pre-wrap break-words text-ink-2">{message.role === 'user' ? t('agent.acpSurface.localHistory.youPrefix') : t('agent.acpSurface.localHistory.agentPrefix')}{message.text}</p>) : <p className="text-ink-3">{t('agent.acpSurface.localHistory.noReadableMessages')}</p>}
                </div>
                {nativePreview.item.provider === 'codex' ? <>
                  <p className="text-ink-3">{t('agent.acpSurface.localHistory.codexConfirmHint')}</p>
                  <label className="flex items-start gap-2 text-ink-2"><input type="checkbox" checked={nativeStoppedConfirmed} onChange={(event) => setNativeStoppedConfirmed(event.target.checked)} />{t('agent.acpSurface.localHistory.codexConfirmCheckbox')}</label>
                  <button type="button" disabled={!nativeStoppedConfirmed || Boolean(resumingLocalId)} onClick={() => void handleResumeDiscoveredSession(nativePreview.item)} className="rounded-lg bg-primary px-3 py-1.5 font-medium text-white disabled:opacity-50">{t('agent.acpSurface.localHistory.resumeOriginalBtn')}</button>
                </> : <p className="text-ink-3">{t('agent.acpSurface.localHistory.readonlyOnlyHint')}</p>}
                <button type="button" onClick={() => setNativePreview(null)} className="ml-2 text-ink-3">{t('agent.acpSurface.localHistory.closePreviewBtn')}</button>
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
                        {t('agent.acpSurface.launchpad.title')}
                      </h2>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-3">
                        {t('agent.acpSurface.launchpad.desc')}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 space-y-4 text-xs">
                    {/* 1. 选择目标客户端 */}
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <label className="font-semibold text-ink-2">{t('agent.acpSurface.launchpad.targetClientLabel')}</label>
                        {unadoptedCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => void handleAdoptAll()}
                            className="font-medium text-primary hover:underline"
                          >
                            {t('agent.acpSurface.launchpad.adoptAllBannerBtn', { count: unadoptedCount })}
                          </button>
                        ) : null}
                      </div>
                      {agents.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {agents.map((agent) => {
                            const selected = launchAgentId === agent.id;
                            const transportKind = resolveTransportKind(agent.preset, agent.args);
                            const transport = t(transportKind === 'bridge' ? 'agent.acpPreset.transport.bridge' : 'agent.acpPreset.transport.native');
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
                          {t('agent.acpSurface.launchpad.noExecutorsEmpty')}
                        </div>
                      )}
                    </div>

                    {/* 2. 工作区目录 */}
                    <div>
                      <label className="mb-1.5 block font-semibold text-ink-2">
                        {t('agent.acpSurface.launchpad.workspaceRootLabel')}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          value={workspaceRoot}
                          onChange={(e) => setWorkspaceRoot(e.target.value)}
                          placeholder={t('agent.acpSurface.launchpad.workspacePlaceholder')}
                          className="h-9 min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 font-mono text-xs text-ink outline-none focus:border-primary"
                        />
                        {isTauriRuntime() ? (
                          <button
                            type="button"
                            onClick={() => void handlePickWorkspace()}
                            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-surface-2 px-3 text-xs font-medium text-ink-2 transition hover:bg-fill-hover hover:text-ink"
                          >
                            <FolderOpen size={14} />
                            <span>{t('agent.acpSurface.launchpad.browseDirBtn')}</span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* 3. 权限与自主策略分段控件 */}
                    <div>
                      <label className="mb-1.5 block font-semibold text-ink-2">
                        {t('agent.acpSurface.launchpad.autonomyLabel')}
                      </label>
                      <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-line-soft bg-surface-2 p-1">
                        {(
                          [
                            { key: 'confirm' as const, labelKey: 'agent.acpSurface.launchpad.autonomyConfirmLabel' as const, hintKey: 'agent.acpSurface.launchpad.autonomyConfirmHint' as const },
                            { key: 'autonomous' as const, labelKey: 'agent.acpSurface.launchpad.autonomyAutoLabel' as const, hintKey: 'agent.acpSurface.launchpad.autonomyAutoHint' as const },
                            { key: 'readonly' as const, labelKey: 'agent.acpSurface.launchpad.autonomyReadonlyLabel' as const, hintKey: 'agent.acpSurface.launchpad.autonomyReadonlyHint' as const },
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
                            <div className="text-xs font-medium">{t(opt.labelKey)}</div>
                            <div className="text-xs text-ink-3">{t(opt.hintKey)}</div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 4. 可选关联卡片 + 恢复会话 */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1.5 block font-semibold text-ink-2">
                          {t('agent.acpSurface.launchpad.linkedCardLabel')}
                        </span>
                        <select
                          value={linkedTodoId}
                          onChange={(e) => setLinkedTodoId(e.target.value)}
                          className="h-9 w-full rounded-xl border border-line bg-surface-2 px-3 text-xs text-ink outline-none focus:border-primary"
                        >
                          <option value="">{t('agent.acpSurface.launchpad.noLinkedCardOption')}</option>
                          {cards.slice(0, 40).map((card) => (
                            <option key={card.id} value={card.id}>
                              {card.title}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div>
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="font-semibold text-ink-2">{t('agent.acpSurface.launchpad.sessionModeLabel')}</span>
                          <button
                            type="button"
                            onClick={() => setShowResumeInput((v) => !v)}
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            <History size={12} />
                            <span>{showResumeInput ? t('agent.acpSurface.launchpad.switchToNewSession') : t('agent.acpSurface.launchpad.resumeExistingSession')}</span>
                          </button>
                        </div>
                        {showResumeInput ? (
                          <input
                            value={resumeSessionId}
                            onChange={(e) => setResumeSessionId(e.target.value)}
                            placeholder={t('agent.acpSurface.launchpad.resumeIdPlaceholder')}
                            className="h-9 w-full rounded-xl border border-line bg-surface-2 px-3 font-mono text-xs text-ink outline-none focus:border-primary"
                          />
                        ) : (
                          <div className="flex h-9 items-center rounded-xl border border-line-soft bg-surface-2 px-3 text-ink-3">
                            {t('agent.acpSurface.launchpad.cleanSessionHint')}
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
                        <span>{showResumeInput ? t('agent.acpSurface.launchpad.loadAndResumeBtn') : t('agent.acpSurface.launchpad.startSessionBtn')}</span>
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
                        {t('agent.acpSurface.localHistory.heading', { count: externalLocalSessions.length })}
                      </span>
                      <div className="flex flex-wrap items-center gap-1">
                        {(
                          [
                            { key: 'all', label: t('agent.acpSurface.launchpad.filterAll') },
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
                      {t('agent.acpSurface.launchpad.goKanbanBtn')}
                    </button>
                  </div>

                  {filteredExternalSessions.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-line bg-surface-3/60 px-3 py-4 text-center text-xs text-ink-3">
                      {discoveringLocalSessions
                        ? t('agent.acpSurface.launchpad.scanningHistory')
                        : t('agent.acpSurface.launchpad.noMatchingHistory')}
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
                                    {t('agent.acpSurface.status.running')}
                                  </span>
                                )}
                                <span className="truncate text-xs font-semibold text-ink">
                                  {item.title}
                                </span>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                                <span className="font-mono">
                                  {basenameOfPath(item.workspaceRoot, t)}
                                </span>
                                {item.stepCount != null && <span>{t('agent.acpSurface.launchpad.stepsCount', { count: item.stepCount })}</span>}
                                <span>{formatSessionTime(item.updatedAt, locale)}</span>
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
                                <span>{t('agent.acpSurface.launchpad.resumeContinueBtn')}</span>
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handlePromoteDiscoveredSession(item)}
                                className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-4 px-2.5 py-1.5 text-xs font-medium text-ink-2 shadow-raise transition hover:bg-fill-hover hover:text-ink disabled:opacity-50"
                              >
                                <Plus size={12} />
                                <span>{t('agent.acpSurface.launchpad.promoteToBoardBtn')}</span>
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
                    <span className="font-semibold text-ink-2">{t('agent.acpSurface.launchpad.presetsTitle')}</span>
                    <span className="text-ink-3">{t('agent.acpSurface.launchpad.presetsHint')}</span>
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
                                  {t('agent.acpSurface.permission.requestTitle', {
                                    title: req.toolCall.title || req.toolCall.kind || t('agent.acpSurface.permission.toolFallback'),
                                  })}
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
                              {t('agent.acpSurface.permission.declineAndCancel')}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* 消息滚动区 */}
                  <div ref={transcriptRef} onScroll={onTranscriptScroll} role="log" aria-label={t('agent.acpSurface.transcript.aria')} className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
                    <div className="mx-auto max-w-3xl space-y-4">
                      {activeSession.messages.length === 0 &&
                      !activeSession.streamingText &&
                      !activeSession.streamingThought ? (
                        <div className="rounded-2xl border border-dashed border-line bg-surface-4/60 p-6 text-center text-xs text-ink-3">
                          <div className="mb-1 text-sm font-semibold text-ink">
                            {t('agent.acpSurface.transcript.connectedReady', { name: activeSession.agentName })}
                          </div>
                          <div>
                            {t('agent.acpSurface.transcript.connectedHint')}
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
                              {msg.role === 'user' ? t('agent.acpSurface.transcript.meSpeaker') : activeSession.agentName}
                            </span>
                            <span>{formatSessionTime(msg.timestamp, locale)}</span>
                          </div>

                          {msg.thoughts ? (
                            <details className="mb-2.5 rounded-xl border border-line-soft bg-surface-2 px-3 py-2 text-xs text-ink-3">
                              <summary className="cursor-pointer font-medium text-ink-2">
                                {t('agent.acpSurface.transcript.reasoningSummary')}
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
                              {t('agent.acpSurface.transcript.liveReasoning')}
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
                            <span>{t('agent.acpSurface.transcript.generating', { name: activeSession.agentName })}</span>
                          </div>
                          <div className="prose prose-sm max-w-none text-xs leading-relaxed text-ink dark:prose-invert">
                            {activeStreamingDoc}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* 底部悬浮 Composer Dock */}
                  {acpTerminalOpen && activeSession.workspaceRoot?.trim() && isTauriRuntime() ? (
                    <ButlerTerminalDrawer
                      workspaceRoot={activeSession.workspaceRoot}
                      open={acpTerminalOpen}
                      onClose={() => setAcpTerminalOpen(false)}
                    />
                  ) : null}
                  <div className="rcx-acp-composer shrink-0 px-5 pb-4 pt-2">
                    <div
                      onDragOver={(e) => {
                        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
                      }}
                      onDrop={(e) => {
                        const dropped = Array.from(e.dataTransfer.files);
                        if (!dropped.length) return;
                        e.preventDefault();
                        const refs = dropped.map((f) => `@${f.name}`).join(' ');
                        setComposerText((prev) => (prev.trimEnd() ? `${prev.trimEnd()} ${refs} ` : `${refs} `));
                      }}
                      className="mx-auto max-w-3xl rounded-2xl border border-line bg-surface-4 p-3 shadow-card"
                    >
                      <AgentComposerFeedback draft={draft} onRetry={retryRequest} />
                      {activeSession.error && <p role="alert" className="mb-2 whitespace-pre-wrap break-words text-xs text-danger">{activeSession.error}</p>}
                      {!connectionReady && <p role="status" className="mb-2 text-xs text-ink-3">{t('agent.acpSurface.composer.disconnectedDraftHint')}</p>}
                      {activeSession.queuedPrompts && activeSession.queuedPrompts.length > 0 ? (
                        <div className="mb-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs">
                          <div className="mb-1 font-medium text-ink-2">
                            {t('agent.acpSurface.composer.queuedCount', { count: activeSession.queuedPrompts.length })}
                          </div>
                          <div className="space-y-1">
                            {activeSession.queuedPrompts.map((q) => (
                              <div key={q.id} className="flex items-center justify-between gap-2 text-ink-3">
                                <span className="truncate">{q.text}</span>
                                <button
                                  type="button"
                                  onClick={() => removeQueuedPrompt(activeSession.sessionKey, q.id)}
                                  className="shrink-0 text-primary hover:underline"
                                >
                                  {t('agent.acpSurface.composer.removeQueued')}
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <LocalVoiceControls
                        targetKey={composerKey}
                        disabled={!draft.loaded || activeSession.status === 'stopped'}
                        replyText={[...activeSession.messages].reverse().find((message) => message.role === 'assistant')?.text ?? ''}
                        onTranscript={(text) => {
                          const current = useAgentComposerDrafts.getState().drafts[composerKey]?.text ?? '';
                          useAgentComposerDrafts.getState().edit(composerKey, { text: [current, text].filter(Boolean).join('\n') });
                        }}
                      />
                      <ButlerComposerFilePopover
                        open={acpFileToken?.kind === 'file'}
                        loading={acpFilesLoading}
                        files={acpFiles}
                        activeIndex={acpFileIdx}
                        onSelect={applyAcpFileSelection}
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
                        ref={acpTextareaRef}
                        data-work-composer="acp"
                        data-work-session-id={activeSession.nativeSessionId ?? activeSession.acpSessionId ?? ''}
                        rows={2}
                        value={composerText}
                        onChange={(e) => {
                          const val = e.target.value;
                          const pos = e.target.selectionStart ?? val.length;
                          const tok = detectComposerTrigger(val, pos);
                          setAcpFileToken(tok?.kind === 'file' ? tok : null);
                          setComposerText(val);
                        }}
                        onKeyDown={(e) => {
                          if (acpFileToken?.kind === 'file') {
                            if (e.key === 'ArrowDown' && acpFiles.length > 0) {
                              e.preventDefault();
                              setAcpFileIdx((i) => (i + 1) % acpFiles.length);
                              return;
                            }
                            if (e.key === 'ArrowUp' && acpFiles.length > 0) {
                              e.preventDefault();
                              setAcpFileIdx((i) => (i - 1 + acpFiles.length) % acpFiles.length);
                              return;
                            }
                            if ((e.key === 'Enter' || e.key === 'Tab') && acpFiles[acpFileIdx]) {
                              e.preventDefault();
                              applyAcpFileSelection(acpFiles[acpFileIdx]);
                              return;
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setAcpFileToken(null);
                              return;
                            }
                          }
                          if (e.key === 'Escape' && (activeSession.status === 'running' || activeSession.status === 'waiting_approval')) {
                            e.preventDefault();
                            void cancelTurn(activeSession.sessionKey);
                            return;
                          }
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                            e.preventDefault();
                            void handleSendPrompt();
                          }
                        }}
                        placeholder={
                          !connectionReady ? t('agent.acpSurface.composer.placeholderDisconnected') : activeSession.status === 'running'
                            ? t('agent.acpSurface.composer.placeholderSteer')
                            : t('agent.acpSurface.composer.placeholderIdle')
                        }
                        className="w-full resize-none rounded-xl border border-line-soft bg-surface-2 px-3 py-2 text-xs text-ink outline-none focus:border-primary"
                      />

                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="flex items-center gap-1.5 text-xs text-ink-3">
                            <input
                              type="checkbox"
                              checked={injectMemory}
                              onChange={(e) => setInjectMemory(e.target.checked)}
                              className="rounded border-line"
                            />
                            {t('agent.acpSurface.composer.recallMemory')}
                          </label>
                          {activeSession.models && activeSession.models.availableModels.length > 0 ? (
                            <select
                              aria-label={t('agent.acpSurface.composer.modelAria')}
                              value={activeSession.models.currentModelId}
                              disabled={!connectionReady}
                              onChange={(e) => {
                                const modelId = e.target.value;
                                void setModel(activeSession.sessionKey, modelId)
                                  .then(() => toast.success(t('agent.acpSurface.composer.modelUpdated', { model: modelId })))
                                  .catch((err) => toast.error(err));
                              }}
                              className="h-7 rounded-lg border border-line bg-surface-2 px-2 text-xs text-ink outline-none focus:border-primary"
                            >
                              {activeSession.models.availableModels.map((m) => (
                                <option key={m.modelId} value={m.modelId}>{m.name || m.modelId}</option>
                              ))}
                            </select>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {activeSession.status === 'running' ? (
                            <button
                              type="button"
                              disabled={!draft.loaded || !composerText.trim() || !connectionReady}
                              onClick={() => {
                                enqueuePrompt(activeSession.sessionKey, composerText);
                                setComposerText('');
                              }}
                              className="inline-flex h-8 items-center rounded-xl border border-line bg-surface-2 px-3 text-xs font-medium text-ink-2 hover:bg-fill-hover hover:text-ink disabled:opacity-50"
                            >
                              {t('agent.acpSurface.composer.enqueueBtn')}
                            </button>
                          ) : null}
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
                              {activeSession.status === 'running' ? t('agent.acpSurface.composer.sendSteerBtn') : t('agent.acpSurface.composer.sendInstructionBtn')}
                            </span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {auxiliaryPanel === 'diff' && activeSession.workspaceRoot?.trim() ? (
                  <>
                    <div className="rcx-acp-panel-backdrop" onClick={() => setAuxiliaryPanel(null)} aria-hidden="true" />
                    <div className="rcx-acp-panel flex min-h-0 flex-col">
                      <WorkDiffDrawer
                        workspaceRoot={activeSession.workspaceRoot}
                        open
                        onClose={() => setAuxiliaryPanel(null)}
                      />
                    </div>
                  </>
                ) : null}

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
                      <h2 id="acp-task-details-title" className="text-sm font-semibold text-ink">{t('agent.acpSurface.details.title')}</h2>
                      <button type="button" data-panel-close aria-label={t('agent.acpSurface.details.closeAria')} onClick={() => setAuxiliaryPanel(null)} className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"><X size={16} /></button>
                    </div>
                    {activeSession.modes && activeSession.modes.availableModes.length > 0 ? (
                      <div className="shrink-0 border-b border-line px-4 py-3">
                        <h3 className="mb-2 text-xs font-medium text-ink-2">{t('agent.acpSurface.details.executionPermissions')}</h3>
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
                        <span>{t('agent.acpSurface.details.tabPlan')}</span>
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
                        <span>{t('agent.acpSurface.details.tabTools')}</span>
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
                        <span>{t('agent.acpSurface.details.tabReport')}</span>
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
                        <span>{t('agent.acpSurface.details.tabLogs')}</span>
                      </button>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
                      {linkedCard ? <p className="mb-3 break-words text-xs text-ink-3">{t('agent.acpSurface.details.linkedWorkLine', { title: linkedCard.title })}</p> : null}
                      {inspectorTab === 'plan' ? (
                        activeSession.plan.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-line bg-surface-4/60 p-4 text-xs text-ink-3">
                            {t('agent.acpSurface.details.noPlan')}
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
                                      ? t('agent.acpSurface.details.planCompleted')
                                      : entry.status === 'in_progress'
                                        ? t('agent.acpSurface.details.planInProgress')
                                        : t('agent.acpSurface.details.planPending')}
                                  </span>
                                </div>
                                <div className="mt-1 text-xs text-ink-3">
                                  {t('agent.acpSurface.details.planPriority', { priority: entry.priority })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )
                      ) : null}

                      {inspectorTab === 'tools' ? (
                        activeSession.toolCalls.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-line bg-surface-4/60 p-4 text-xs text-ink-3">
                            {t('agent.acpSurface.details.noTools')}
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
                                                  {t('agent.acpSurface.details.terminalOutputId', { id: block.terminalId })}
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
                            {t('agent.acpSurface.details.noReport')}
                          </div>
                        )
                      ) : null}

                      {inspectorTab === 'logs' ? (
                        activeSession.stderrLogs.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-line bg-surface-4/60 p-4 text-xs text-ink-3">
                            {t('agent.acpSurface.details.noLogs')}
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
