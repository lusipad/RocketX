import { Bot, Check, ChevronLeft, Copy, Loader2, Play, Share2, Square, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { agentSessionCardSupersedesLocal, type AgentSessionCard } from '../agent/card';
import { agentBackend, type AgentBackend, type AgentSession } from '../agent/session';
import { permissionRequestSummary } from '../agent/safety';
import {
  autoHostEnvironmentId,
  roomHostingWorkspaceRoot,
  setRoomAutoHosting,
  setRoomHostingWorkspace,
} from '../lib/agentHosting';
import { isTauriRuntime } from '../lib/client';
import { openDesktopDialog } from '../platform/desktopDialog';
import { useStickToBottom } from '../lib/stickToBottom';
import { toast } from '../stores/toast';
import { useChat } from '../stores/chat';
import { useSharedAgent } from '../stores/sharedAgent';
import {
  environmentIsBusy,
  findEnvironmentByPath,
  proposedAgentBranch,
  useAgentEnvironments,
} from '../stores/agentEnvironments';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useUI } from '../stores/ui';
import PanelShell from './PanelShell';
import ButlerErrandInputCard from './ButlerErrandInputCard';
import { t as rawT, useI18n } from '../i18n';
import { formatTime } from '../i18n/format';

function approvalSummary(method: string, params: unknown): string {
  const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  if (typeof value.command === 'string') return value.command;
  if (Array.isArray(value.command)) return value.command.filter((part) => typeof part === 'string').join(' ');
  if (typeof value.fileChanges === 'object' && value.fileChanges !== null) {
    return Object.keys(value.fileChanges).join('\n');
  }
  const permissionLines = permissionRequestSummary(value.permissions ?? value.additionalPermissions);
  if (permissionLines.length > 0) return permissionLines.join('\n');
  if (typeof value.grantRoot === 'string') return rawT('agent.codexApproval.writeDir', { path: value.grantRoot });
  if (typeof value.reason === 'string') return value.reason;
  return method;
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function backendLabel(backend: AgentBackend): string {
  return backend === 'deepseek' ? rawT('agent.panel.backendDeepseek') : 'Pi';
}

function backendDisplayName(backend: AgentBackend | null): string {
  return backend ? backendLabel(backend) : rawT('agent.panel.backendNone');
}

function permissionPresetLabel(permissionPreset?: 'ask' | 'auto' | 'full'): string {
  return permissionPreset === 'ask' ? rawT('agent.panel.perm.ask') : permissionPreset === 'auto' ? rawT('agent.panel.perm.auto') : permissionPreset === 'full' ? rawT('agent.panel.perm.full') : rawT('agent.panel.perm.unset');
}

function codexRuntimeSummary(
  model?: string,
  effort?: string | null,
  permissionPreset?: 'ask' | 'auto' | 'full',
): string {
  return rawT('agent.panel.runtimeSummary', {
    model: model || rawT('agent.panel.noModel'),
    effort: effort ?? rawT('agent.panel.noEffort'),
    perm: permissionPresetLabel(permissionPreset),
  });
}

function effortLabel(effort: string): string {
  return ({
    low: rawT('agent.panel.effort.low'),
    medium: rawT('agent.panel.effort.medium'),
    high: rawT('agent.panel.effort.high'),
    xhigh: rawT('agent.panel.effort.xhigh'),
  } as Record<string, string>)[effort] ?? effort;
}

function remoteBackend(card: AgentSessionCard): AgentBackend {
  return card.backend === 'deepseek' ? 'deepseek' : 'codex';
}

export default function AgentPanel({
  sessionKey,
  resizable = false,
}: {
  sessionKey?: string;
  resizable?: boolean;
} = {}) {
  const { t, locale } = useI18n();
  const [projectOverride, setProjectOverride] = useState<string>();
  const [runtimeModelOverride, setRuntimeModelOverride] = useState<string>();
  const [runtimeEffortOverride, setRuntimeEffortOverride] = useState<string | null>();
  const [runtimePermissionOverride, setRuntimePermissionOverride] = useState<AgentSession['runtimePermissionPreset']>();
  const [autoHost, setAutoHost] = useState(false);
  const panel = useChat((state) => state.rightPanel);
  const tmid = sessionKey ?? (panel?.kind === 'agent' ? panel.tmid : null);
  const setPanel = useChat((state) => state.setPanel);
  const rid = useChat((state) => state.activeRid);
  const session = useSharedAgent((state) => (tmid ? state.sessions[tmid] as AgentSession | undefined : undefined));
  const remoteCard = useSharedAgent((state) => (tmid ? state.remoteCards[tmid] : undefined));
  const bindings = useAgentEnvironments((state) => state.bindings);
  const binding = bindings.find((item) => item.sessionKey === tmid && item.status === 'active');
  const environments = useAgentEnvironments((state) => state.environments);
  const currentProject = useCodexWorkspace((state) => state.workspaceRoot);
  const boundEnvironment = environments.find((item) => item.id === binding?.environmentId);
  const availableProjects = environments.filter((environment) => (
    environment.enabled
    && (
      environment.id === binding?.environmentId
      || !environmentIsBusy(environment.id, bindings)
    )
  ));
  const roomProject = rid ? roomHostingWorkspaceRoot(rid) : undefined;
  const projectEnvironment = findEnvironmentByPath(availableProjects, projectOverride ?? '')
    ?? (boundEnvironment?.enabled ? findEnvironmentByPath(availableProjects, boundEnvironment.path) : undefined)
    ?? findEnvironmentByPath(availableProjects, roomProject ?? '')
    ?? findEnvironmentByPath(availableProjects, currentProject)
    ?? availableProjects[0];
  const selectedProject = projectEnvironment?.path;
  const sessionTraces = useSharedAgent((state) => (tmid ? state.traces[tmid] : undefined));
  const allApprovals = useSharedAgent((state) => state.approvals);
  const allInputs = useSharedAgent((state) => state.inputs);
  const allMemberRequests = useSharedAgent((state) => state.memberRequests);
  const traces = sessionTraces ?? [];
  const approvals = useMemo(
    () => allApprovals.filter((item) => item.tmid === tmid),
    [allApprovals, tmid],
  );
  const inputs = useMemo(
    () => allInputs.filter((item) => item.tmid === tmid),
    [allInputs, tmid],
  );
  const members = useMemo(
    () => allMemberRequests.filter((item) => item.tmid === tmid),
    [allMemberRequests, tmid],
  );
  const globalError = useSharedAgent((state) => state.error);
  const start = useSharedAgent((state) => state.startSession);
  const approveMember = useSharedAgent((state) => state.approveMemberRequest);
  const resolveApproval = useSharedAgent((state) => state.resolveApproval);
  const resolveInput = useSharedAgent((state) => state.resolveInput);
  const setAccess = useSharedAgent((state) => state.setAccess);
  const resume = useSharedAgent((state) => state.resumeSession);
  const end = useSharedAgent((state) => state.endSession);
  const transferToCodexApp = useSharedAgent((state) => state.transferToCodexApp);
  const selectedModel = useCodexWorkspace((state) => state.selectedModel);
  const selectedEffort = useCodexWorkspace((state) => state.selectedEffort);
  const permissionPreset = useCodexWorkspace((state) => state.permissionPreset);
  const models = useCodexWorkspace((state) => state.models);
  const refreshCatalog = useCodexWorkspace((state) => state.refreshCatalog);
  const openButlerConversation = useUI((state) => state.openButlerConversation);
  const configuredProvider = useUI((state) => state.aiRuntimeProvider);
  const selectedBackend: AgentBackend | null = configuredProvider === 'pi' ? 'codex' : null;
  const [transferring, setTransferring] = useState(false);
  const [startFailure, setStartFailure] = useState('');
  const [startingTmid, setStartingTmid] = useState<string | null>(null);
  const [resumingTmid, setResumingTmid] = useState<string | null>(null);
  const desktopRuntime = isTauriRuntime();
  // 托管运行时新过程不断追加：贴底跟随，滚上去查旧记录时不打扰（issue #90 同类）
  // 依赖用 store 里的原始引用，traces 的 `?? []` 每次渲染都是新数组
  const { scrollRef, onScroll } = useStickToBottom([sessionTraces]);

  useEffect(() => {
    setAutoHost(!!rid && !!autoHostEnvironmentId(rid));
  }, [rid, session?.environmentId]);

  useEffect(() => {
    setProjectOverride(undefined);
    setRuntimeModelOverride(undefined);
    setRuntimeEffortOverride(undefined);
    setRuntimePermissionOverride(undefined);
    setStartFailure('');
  }, [rid, tmid]);

  useEffect(() => {
    if (!desktopRuntime || selectedBackend !== 'codex' || !currentProject || models.length > 0) return;
    void refreshCatalog().catch((reason) => toast.error(reason, t('agent.panel.loadModelsFailed')));
  }, [currentProject, desktopRuntime, models.length, refreshCatalog, selectedBackend, t]);

  if (!tmid || !rid) return null;
  const roomSession = tmid.startsWith('room:');
  const remoteSession = agentSessionCardSupersedesLocal(session, remoteCard) ? remoteCard : undefined;
  const starting = startingTmid === tmid;
  const resuming = resumingTmid === tmid;
  const visibleSession = remoteSession ? undefined : session;
  const error = visibleSession?.status !== 'ended'
    ? visibleSession?.lastError ?? (!visibleSession && !remoteSession ? globalError : null)
    : null;
  const statusLabel = visibleSession
    ? {
        starting: t('agent.hosted.status.starting'),
        ready: t('agent.hosted.status.ready'),
        running: t('agent.hosted.status.running'),
        'waiting-approval': t('agent.hosted.status.waitingApproval'),
        interrupted: t('agent.hosted.status.interrupted'),
        ended: t('agent.hosted.status.ended'),
      }[visibleSession.status]
    : '';
  const currentBackend = visibleSession && visibleSession.status !== 'ended'
    ? agentBackend(visibleSession)
    : remoteSession
      ? remoteBackend(remoteSession)
      : selectedBackend;
  const providerCompatible = !!visibleSession
    && configuredProvider === 'pi'
    && agentBackend(visibleSession) === 'codex';
  const hostingModel = runtimeModelOverride ?? selectedModel;
  const hostingModelDetails = models.find((model) => model.model === hostingModel || model.id === hostingModel);
  const requestedHostingEffort = runtimeEffortOverride !== undefined
    ? runtimeEffortOverride
    : selectedEffort;
  const hostingEffort = requestedHostingEffort
    && hostingModelDetails?.supportedReasoningEfforts.some((item) => item.reasoningEffort === requestedHostingEffort)
    ? requestedHostingEffort
    : hostingModelDetails?.defaultReasoningEffort ?? requestedHostingEffort;
  const hostingPermissionPreset = runtimePermissionOverride ?? permissionPreset;
  const nextCodexRuntimeSummary = t('agent.panel.nextRuntimeSummary', {
    summary: codexRuntimeSummary(
      hostingModel,
      hostingEffort,
      hostingPermissionPreset,
    ),
  });
  const activeCodexRuntimeSummary = session
    ? codexRuntimeSummary(session.runtimeModel, session.runtimeEffort, session.runtimePermissionPreset)
    : t('agent.panel.noActiveSnapshot');
  const startBlockReason = !selectedBackend
    ? t('agent.panel.block.noAi')
    : !selectedProject
      ? t('agent.panel.block.noProject')
      : !hostingModel
        ? t('agent.panel.block.noModel')
        : null;
  const backendSummary = currentBackend === 'deepseek'
    ? t('agent.panel.legacyDshReadonly')
    : currentBackend === 'codex'
      ? (session ? activeCodexRuntimeSummary : nextCodexRuntimeSummary)
      : t('agent.panel.noAiSummary');

  const addHostingProject = async (): Promise<void> => {
    const path = await openDesktopDialog({ directory: true, multiple: false, title: t('agent.panel.pickProjectTitle') });
    if (typeof path !== 'string') return;
    const environmentState = useAgentEnvironments.getState();
    const environment = environmentState.ensureEnvironment({ path });
    if (environmentIsBusy(environment.id, environmentState.bindings)) {
      throw new Error(t('agent.panel.projectBusyError'));
    }
    if (!environment.enabled) {
      useAgentEnvironments.getState().updateEnvironment(environment.id, { enabled: true });
    }
    setProjectOverride(environment.path);
    setStartFailure('');
  };

  return (
    <PanelShell
      resizable={resizable}
      title={
        <span className="flex items-center gap-2">
          {!roomSession ? (
            <button
              title={t('agent.panel.backToThread')}
              onClick={() => setPanel({ kind: 'thread', mid: tmid })}
              className="rounded p-1 text-ink-2 hover:bg-fill-hover"
            >
              <ChevronLeft size={16} />
            </button>
          ) : null}
          <Bot size={16} className="text-primary" />
          {t('agent.panel.title')}
        </span>
      }
    >
      <div className="flex items-center justify-between gap-3 border-b border-line bg-fill-1 px-4 py-2.5 text-xs">
        <div className="min-w-0">
          <div className="font-medium text-ink">{t('agent.panel.configHeading')}</div>
          <div className="mt-0.5 truncate text-ink-3" title={`${backendDisplayName(currentBackend)} · ${backendSummary}`}>
            {backendDisplayName(currentBackend)} · {backendSummary}
          </div>
        </div>
        <button
          type="button"
          onClick={() => openButlerConversation(tmid)}
          className="shrink-0 rounded-md border border-line bg-surface px-2.5 py-1.5 text-ink-2 hover:bg-fill-hover"
        >
          {t('agent.panel.openInButler')}
        </button>
      </div>
      {error ? <div className="border-b border-line bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div> : null}
      {remoteSession ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary">
            <Bot size={28} />
          </div>
          <div>
            <div className="font-medium text-ink">{t('agent.panel.remoteHostingTitle', { username: remoteSession.hostUsername })}</div>
            <div className="mt-1 text-xs leading-5 text-ink-3">
              {t('agent.panel.remoteHostingDesc')}
            </div>
          </div>
          <div className="w-full max-w-sm space-y-3 rounded-lg border border-line bg-fill-1 p-4 text-left text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">{t('agent.panel.statusLabel')}</span>
              <span className="text-xs text-ink">{remoteSession.status === 'interrupted' ? t('agent.hosted.status.interrupted') : t('agent.hosted.status.running')}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">{t('agent.panel.backendLabel')}</span>
              <span className="text-xs text-ink">{backendLabel(remoteBackend(remoteSession))}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">{t('agent.panel.projectLabel')}</span>
              <span className="truncate text-xs text-ink" title={remoteSession.environmentName}>
                {remoteSession.environmentName || t('agent.hosted.noProject')}
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="shrink-0 text-ink-3">{t('agent.panel.currentTaskLabel')}</span>
              <span className="text-right text-xs text-ink">
                {remoteSession.currentTaskLabel
                  || (remoteSession.workItem ? `#${remoteSession.workItem.id} ${remoteSession.workItem.title}` : t('agent.hosted.waitingCommand'))}
              </span>
            </div>
          </div>
          <div className="text-xs text-ink-3">
            {remoteSession.status === 'interrupted'
              ? t('agent.panel.remoteInterruptedHint')
              : t('agent.panel.remoteActiveHint')}
          </div>
        </div>
      ) : !session || session.status === 'ended' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex min-h-full flex-col items-center justify-center gap-3 p-5 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary">
            <Bot size={28} />
          </div>
          <div>
            <div className="font-medium text-ink">
              {binding
                ? t('agent.panel.startForWorkItem', { id: binding.workItemId })
                : roomSession
                  ? t('agent.panel.startForRoom')
                  : t('agent.panel.startForThread')}
            </div>
            <div className="mt-1 text-xs leading-5 text-ink-3">
              {t('agent.panel.singleSessionHint')}
            </div>
          </div>
          {!desktopRuntime ? (
            <div className="rounded-md border border-line bg-fill-1 px-3 py-2 text-xs text-ink-3">
              {t('agent.shared.desktopOnly')}
            </div>
          ) : (
            <>
              <div className="w-full max-w-sm">
                <div className="mb-3 text-left text-xs text-ink-3">
                  <span className="mb-1 block">{t('agent.panel.runtimeLine', { name: backendDisplayName(selectedBackend) })}</span>
                  <div className="mt-1 text-ink-3">
                    {selectedBackend === 'codex'
                      ? nextCodexRuntimeSummary
                      : t('agent.panel.noAiSummary')}
                  </div>
                </div>
                <label className="block text-left text-xs text-ink-3">
                  <span className="mb-1 block">{t('agent.panel.hostedProjectLabel')}</span>
                  <select
                    aria-label={t('agent.panel.hostedProjectAria')}
                    value={selectedProject ?? ''}
                    onChange={(event) => setProjectOverride(event.target.value)}
                    className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                  >
                    {!selectedProject ? <option value="">{t('agent.panel.noProjectsOption')}</option> : null}
                    {availableProjects.map((environment) => (
                      <option key={environment.id} value={environment.path}>
                        {environment.name || projectName(environment.path)}
                        {environment.path === roomProject ? t('agent.panel.roomTag') : environment.path === currentProject ? t('agent.panel.currentTag') : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedBackend === 'codex' ? (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="col-span-2 block text-left text-xs text-ink-3">
                      <span className="mb-1 block">{t('agent.panel.modelLabel')}</span>
                      <select
                        aria-label={t('agent.panel.modelAria')}
                        value={hostingModel}
                        onChange={(event) => {
                          const model = models.find((item) => item.model === event.target.value || item.id === event.target.value);
                          setRuntimeModelOverride(event.target.value);
                          setRuntimeEffortOverride(model?.defaultReasoningEffort ?? null);
                        }}
                        className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                      >
                        {models.length === 0 ? <option value="">{t('agent.panel.loadingModelsOption')}</option> : null}
                        {models.filter((model) => !model.hidden).map((model) => (
                          <option key={model.id} value={model.model}>{model.displayName}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-left text-xs text-ink-3">
                      <span className="mb-1 block">{t('agent.panel.reasoningEffortLabel')}</span>
                      <select
                        aria-label={t('agent.panel.reasoningEffortAria')}
                        value={hostingEffort ?? ''}
                        onChange={(event) => setRuntimeEffortOverride(event.target.value || null)}
                        disabled={!hostingModelDetails || hostingModelDetails.supportedReasoningEfforts.length === 0}
                        className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary disabled:opacity-50"
                      >
                        {hostingModelDetails?.supportedReasoningEfforts.map((effort) => (
                          <option key={effort.reasoningEffort} value={effort.reasoningEffort}>
                            {effortLabel(effort.reasoningEffort)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-left text-xs text-ink-3">
                      <span className="mb-1 block">{t('agent.panel.permissionLabel')}</span>
                      <select
                        aria-label={t('agent.panel.permissionAria')}
                        value={hostingPermissionPreset}
                        onChange={(event) => setRuntimePermissionOverride(event.target.value as AgentSession['runtimePermissionPreset'])}
                        className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                      >
                        <option value="ask">{t('agent.panel.perm.ask')}</option>
                        <option value="auto">{t('agent.panel.perm.auto')}</option>
                        <option value="full">{t('agent.panel.perm.full')}</option>
                      </select>
                    </label>
                  </div>
                ) : null}
              </div>
              <button
                disabled={
                  starting
                  || !selectedBackend
                  || (!!selectedProject && !hostingModel)
                }
                onClick={() => {
                  if (!selectedProject) {
                    void addHostingProject().catch((reason) => toast.error(reason, t('agent.panel.addProjectFailed')));
                    return;
                  }
                  if (!selectedBackend) return;
                  const startOptions = {
                    workspaceRoot: selectedProject,
                    replyTmid: tmid.startsWith('room:') ? undefined : tmid,
                    environmentId: projectEnvironment?.id,
                    environmentName: projectEnvironment?.name,
                    workItem: binding ? { id: binding.workItemId, project: binding.adoProject, title: binding.workItemTitle } : undefined,
                    proposedBranch: binding && projectEnvironment
                      ? proposedAgentBranch(projectEnvironment.branchPrefix, binding.workItemId, binding.workItemTitle)
                      : undefined,
                    baseBranch: projectEnvironment?.defaultBaseBranch,
                    backend: selectedBackend,
                    runtimeModel: hostingModel || undefined,
                    runtimeEffort: hostingEffort,
                    runtimePermissionPreset: hostingPermissionPreset,
                  };
                  setStartFailure('');
                  setStartingTmid(tmid);
                  void start(rid, tmid, startOptions)
                    .then(() => {
                      if (tmid.startsWith('room:')) setRoomHostingWorkspace(rid, selectedProject);
                    })
                    .catch((startError) => {
                      setStartFailure(startError instanceof Error ? startError.message : String(startError));
                      toast.error(startError, t('agent.panel.startFailedToast'));
                    })
                    .finally(() => setStartingTmid((current) => (current === tmid ? null : current)));
                }}
                title={startBlockReason ?? undefined}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {starting
                  ? <Loader2 size={14} className="animate-spin" />
                  : selectedBackend && selectedProject
                    ? <Play size={14} />
                    : <Bot size={14} />}
                {starting
                  ? t('agent.panel.startingBtn')
                  : !selectedBackend
                    ? t('agent.hosting.aiDisabled')
                    : !selectedProject
                      ? t('agent.panel.addProjectBtn')
                      : t('agent.panel.startHostingBtn')}
              </button>
              {startFailure ? (
                <div role="alert" className="w-full max-w-sm rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-left text-xs leading-5 text-danger">
                  {t('agent.panel.startFailurePrefix', { error: startFailure })}
                </div>
              ) : startBlockReason ? (
                <div role="status" className="w-full max-w-sm rounded-md border border-line bg-fill-1 px-3 py-2 text-left text-xs leading-5 text-ink-3">
                  {startBlockReason}
                </div>
              ) : null}
            </>
          )}
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-3 border-b border-line p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ink-3">{t('agent.panel.statusLabel')}</span>
              <span className="rounded bg-fill-1 px-2 py-0.5 text-xs text-ink">{statusLabel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-3">{t('agent.panel.backendLabel')}</span>
              <span className="rounded bg-fill-1 px-2 py-0.5 text-xs text-ink">{backendLabel(agentBackend(session))}</span>
            </div>
            <div className="text-xs text-ink-3">
              {currentBackend === 'deepseek' ? t('agent.panel.legacyDshReadonly') : activeCodexRuntimeSummary}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">{t('agent.panel.commandScopeLabel')}</span>
              <button
                onClick={() =>
                  void setAccess(
                    tmid,
                    session.access === 'host-only' ? 'room-members' : 'host-only',
                  )
                }
                className="flex items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2"
              >
                <Users size={14} />
                {session.access === 'host-only' ? t('agent.panel.accessHostOnly') : t('agent.panel.accessRoomMembers')}
              </button>
            </div>
            {session.codexThreadId ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-3">{t('agent.panel.codexTaskLabel')}</span>
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    title={t('agent.panel.copyResumeTitle', { threadId: session.codexThreadId })}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(`codex resume ${session.codexThreadId}`)
                        .then(() => toast.success(t('agent.panel.copiedResumeHint')));
                    }}
                    className="flex min-w-0 items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover"
                  >
                    <Copy size={12} />
                    <span className="truncate">codex resume</span>
                  </button>
                  <button
                    title={t('agent.panel.openCodexAppTitle')}
                    disabled={transferring || session.status === 'running'}
                    onClick={() => {
                      setTransferring(true);
                      void transferToCodexApp(tmid)
                        .then((result) => {
                          if (result === 'unavailable') {
                            throw new Error(t('agent.panel.openAndCopyUnavailable'));
                          }
                          toast.success(
                            result === 'opened-existing'
                              ? t('agent.panel.codexOpenedExisting')
                              : result === 'opened'
                              ? t('agent.panel.codexOpenedFilled')
                              : result === 'opened-with-copy'
                                ? t('agent.panel.codexOpenedWithCopy')
                                : t('agent.shared.openFailedCopied'),
                          );
                        })
                        .catch((error) => toast.error(error, t('agent.panel.openCodexAppFailed')))
                        .finally(() => setTransferring(false));
                    }}
                    className="flex shrink-0 items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
                  >
                    {transferring ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
                    {t('agent.panel.openInCodexAppBtn')}
                  </button>
                </div>
              </div>
            ) : null}
            <div className="truncate text-xs text-ink-3" title={session.workspaceRoots[0]}>
              {session.workspaceRoots[0]}
            </div>
            {!providerCompatible ? (
              <div className="rounded-md bg-warning-light px-2.5 py-2 text-xs leading-5 text-ink-2">
                {t('agent.panel.incompatibleRuntimeNotice', {
                  sessionBackend: backendLabel(agentBackend(session)),
                  selectedBackend: backendDisplayName(selectedBackend),
                })}
              </div>
            ) : null}
            <label className="flex items-start gap-2 rounded-md bg-fill-1 px-2.5 py-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={autoHost}
                disabled={!session.environmentId}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setRoomAutoHosting(rid, enabled ? session.environmentId : undefined);
                  setAutoHost(enabled);
                }}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-ink">{t('agent.panel.autoHostLabel')}</span>
                <span className="mt-0.5 block text-xs text-ink-3">
                  {t('agent.panel.autoHostHint')}
                </span>
              </span>
            </label>
            <div className="flex gap-2">
              {session.status === 'interrupted' ? (
                <button
                  disabled={resuming || !providerCompatible}
                  title={!providerCompatible ? t('agent.panel.resumeRequiresTitle', { backend: backendLabel(agentBackend(session)) }) : undefined}
                  onClick={() => {
                    setResumingTmid(tmid);
                    void resume(tmid)
                      .catch((resumeError) => toast.error(resumeError, t('agent.panel.resumeFailedToast')))
                      .finally(() => setResumingTmid((current) => (current === tmid ? null : current)));
                  }}
                  className="flex flex-1 items-center justify-center gap-1 rounded border border-primary px-2 py-1.5 text-xs text-primary disabled:opacity-50"
                >
                  {resuming ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  {resuming ? t('agent.panel.resumingBtn') : t('agent.panel.resumeBtn')}
                </button>
              ) : null}
              <button
                disabled={resuming}
                onClick={() => void end(tmid)}
                className="flex flex-1 items-center justify-center gap-1 rounded border border-line px-2 py-1.5 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
              >
                <Square size={12} /> {t('agent.panel.endBtn')}
              </button>
            </div>
          </div>

          {(members.length > 0 || approvals.length > 0 || inputs.length > 0) && (
            <div className="space-y-3 border-b border-line bg-warning-light/30 p-4">
              {members.map((request) => (
                <div key={request.id} className="rounded-md border border-line bg-surface-3 p-3 text-xs">
                  <div className="font-medium text-ink">{t('agent.panel.memberRequestTitle', { username: request.command.username })}</div>
                  <div className="mt-1 line-clamp-3 text-ink-3">{request.command.text}</div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => void approveMember(request.id, true)}
                      className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-white"
                    >
                      <Check size={12} /> {t('agent.panel.allowMemberTaskBtn')}
                    </button>
                    <button
                      onClick={() => void approveMember(request.id, false)}
                      className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                    >
                      <X size={12} /> {t('agent.nativeScene.decision.decline')}
                    </button>
                  </div>
                </div>
              ))}
              {approvals.map((approval) => (
                <div key={approval.id} className="rounded-md border border-line bg-surface-3 p-3 text-xs">
                  <div className="font-medium text-ink">{t('agent.panel.approvalWaitingTitle')}</div>
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-ink-3">
                    {approvalSummary(approval.method, approval.params)}
                  </pre>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => void resolveApproval(approval.id, 'decline')}
                      className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                    >
                      <X size={12} /> {t('agent.nativeScene.decision.decline')}
                    </button>
                    {approval.method.startsWith('item/') ? (
                      <button
                        onClick={() => void resolveApproval(approval.id, 'accept-session')}
                        className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                      >
                        <Check size={12} /> {t('agent.panel.allowSessionBtn')}
                      </button>
                    ) : null}
                    <button
                      onClick={() => void resolveApproval(approval.id, 'accept')}
                      className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-white"
                    >
                      <Check size={12} /> {t('agent.panel.allowOnceBtn')}
                    </button>
                  </div>
                </div>
              ))}
              {inputs.map((input) => (
                <ButlerErrandInputCard
                  key={input.id}
                  input={input}
                  onResolve={(response) => resolveInput(input.id, response)}
                />
              ))}
            </div>
          )}

          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-2 text-xs font-medium text-ink-2">{t('agent.panel.tracesHeading')}</div>
            {traces.length === 0 ? (
              <div className="py-8 text-center text-xs text-ink-3">{t('agent.panel.tracesEmpty')}</div>
            ) : (
              <div className="space-y-2">
                {traces.map((item) => (
                  <div key={item.id} className="rounded bg-fill-1 px-2.5 py-2 text-xs text-ink-2">
                    <span className="mr-2 text-ink-3">{formatTime(item.at, undefined, locale)}</span>
                    {item.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </PanelShell>
  );
}
