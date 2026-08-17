import { open } from '@tauri-apps/plugin-dialog';
import { Bot, Check, ChevronLeft, Copy, Loader2, Play, Share2, Square, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { agentSessionCardSupersedesLocal, type AgentSessionCard } from '../agent/card';
import type { DshStartConfiguration } from '../agent/dsh/HostedDshController';
import { agentBackend, type AgentBackend, type AgentSession } from '../agent/session';
import { permissionRequestSummary } from '../agent/safety';
import {
  autoHostEnvironmentId,
  roomHostingWorkspaceRoot,
  setRoomAutoHosting,
  setRoomHostingWorkspace,
} from '../lib/agentHosting';
import { isTauriRuntime } from '../lib/client';
import { useStickToBottom } from '../lib/stickToBottom';
import { toast } from '../stores/toast';
import { useChat } from '../stores/chat';
import {
  prepareSharedDshStartConfiguration,
  releaseSharedDshStartConfiguration,
  useSharedAgent,
} from '../stores/sharedAgent';
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
import DshQuestionCard from './DshQuestionCard';

function approvalSummary(method: string, params: unknown): string {
  const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  if (typeof value.command === 'string') return value.command;
  if (Array.isArray(value.command)) return value.command.filter((part) => typeof part === 'string').join(' ');
  if (typeof value.fileChanges === 'object' && value.fileChanges !== null) {
    return Object.keys(value.fileChanges).join('\n');
  }
  const permissionLines = permissionRequestSummary(value.permissions ?? value.additionalPermissions);
  if (permissionLines.length > 0) return permissionLines.join('\n');
  if (typeof value.grantRoot === 'string') return `写入目录：${value.grantRoot}`;
  if (typeof value.reason === 'string') return value.reason;
  return method;
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function backendLabel(backend: AgentBackend): string {
  return backend === 'deepseek' ? 'DeepSeek' : 'Codex';
}

function backendDisplayName(backend: AgentBackend | null): string {
  return backend ? backendLabel(backend) : '无 AI';
}

function permissionPresetLabel(permissionPreset?: 'ask' | 'auto' | 'full'): string {
  return permissionPreset === 'ask' ? '询问审批' : permissionPreset === 'auto' ? '替我审批' : permissionPreset === 'full' ? '完全访问' : '未写入权限';
}

function codexRuntimeSummary(
  model?: string,
  effort?: string | null,
  permissionPreset?: 'ask' | 'auto' | 'full',
): string {
  return `${model || '未写入模型'} · ${effort ?? '未写入推理'} · ${permissionPresetLabel(permissionPreset)}`;
}

function effortLabel(effort: string): string {
  return ({ low: '低', medium: '中', high: '高', xhigh: '超高' } as Record<string, string>)[effort] ?? effort;
}

type DshModelSelection = NonNullable<DshStartConfiguration['models']['defaultSelection']>;

function dshModelKey(selection: Pick<DshModelSelection, 'provider' | 'model'>): string {
  return JSON.stringify([selection.provider, selection.model]);
}

const dshReleaseTimers = new Map<string, number>();

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
  const [projectOverride, setProjectOverride] = useState<string>();
  const [runtimeModelOverride, setRuntimeModelOverride] = useState<string>();
  const [runtimeEffortOverride, setRuntimeEffortOverride] = useState<string | null>();
  const [runtimePermissionOverride, setRuntimePermissionOverride] = useState<AgentSession['runtimePermissionPreset']>();
  const [dshConfiguration, setDshConfiguration] = useState<DshStartConfiguration | null>(null);
  const [dshConfigurationStatus, setDshConfigurationStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [dshConfigurationError, setDshConfigurationError] = useState('');
  const [dshModelOverride, setDshModelOverride] = useState<DshModelSelection>();
  const [dshAgentOverride, setDshAgentOverride] = useState<string>();
  const [dshPermissionOverride, setDshPermissionOverride] = useState<string>();
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
  const allDshQuestions = useSharedAgent((state) => state.dshQuestions);
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
  const dshQuestions = useMemo(
    () => allDshQuestions.filter((item) => item.tmid === tmid),
    [allDshQuestions, tmid],
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
  const resolveDshQuestion = useSharedAgent((state) => state.resolveDshQuestion);
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
  const selectedBackend: AgentBackend | null = configuredProvider === 'deepseek'
    ? 'deepseek'
    : configuredProvider === 'codex'
      ? 'codex'
      : null;
  const hostingAlreadyExists = !!(session && session.status !== 'ended')
    || agentSessionCardSupersedesLocal(session, remoteCard);
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
    setDshConfiguration(null);
    setDshConfigurationStatus('idle');
    setDshConfigurationError('');
    setDshModelOverride(undefined);
    setDshAgentOverride(undefined);
    setDshPermissionOverride(undefined);
    setStartFailure('');
  }, [rid, tmid]);

  useEffect(() => {
    if (!desktopRuntime || selectedBackend !== 'codex' || !currentProject || models.length > 0) return;
    void refreshCatalog().catch((reason) => toast.error(reason, '读取 AI 托管模型失败'));
  }, [currentProject, desktopRuntime, models.length, refreshCatalog, selectedBackend]);

  useEffect(() => {
    let cancelled = false;
    setDshModelOverride(undefined);
    setDshAgentOverride(undefined);
    setDshPermissionOverride(undefined);
    if (!desktopRuntime || selectedBackend !== 'deepseek' || !tmid || !selectedProject || hostingAlreadyExists) {
      setDshConfiguration(null);
      setDshConfigurationStatus('idle');
      setDshConfigurationError('');
      if (tmid) void releaseSharedDshStartConfiguration(tmid);
      return () => { cancelled = true; };
    }
    setDshConfiguration(null);
    setDshConfigurationStatus('loading');
    setDshConfigurationError('');
    void prepareSharedDshStartConfiguration(tmid, selectedProject)
      .then((configuration) => {
        if (cancelled) return;
        setDshConfiguration(configuration);
        setDshConfigurationStatus('ready');
      })
      .catch((reason) => {
        if (cancelled) return;
        setDshConfigurationError(reason instanceof Error ? reason.message : String(reason));
        setDshConfigurationStatus('error');
      });
    return () => { cancelled = true; };
  }, [desktopRuntime, hostingAlreadyExists, selectedBackend, selectedProject, tmid]);

  useEffect(() => {
    if (!tmid) return undefined;
    const pending = dshReleaseTimers.get(tmid);
    if (pending !== undefined) window.clearTimeout(pending);
    dshReleaseTimers.delete(tmid);
    return () => {
      const timer = window.setTimeout(() => {
        dshReleaseTimers.delete(tmid);
        void releaseSharedDshStartConfiguration(tmid);
      }, 0);
      dshReleaseTimers.set(tmid, timer);
    };
  }, [tmid]);

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
        starting: '正在启动',
        ready: '待命',
        running: '正在工作',
        'waiting-approval': '等待审批',
        interrupted: '已中断',
        ended: '已结束',
      }[visibleSession.status]
    : '';
  const currentBackend = visibleSession && visibleSession.status !== 'ended'
    ? agentBackend(visibleSession)
    : remoteSession
      ? remoteBackend(remoteSession)
      : selectedBackend;
  const providerCompatible = !!visibleSession && configuredProvider === agentBackend(visibleSession);
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
  const nextCodexRuntimeSummary = `开启配置：${codexRuntimeSummary(
    hostingModel,
    hostingEffort,
    hostingPermissionPreset,
  )}`;
  const activeCodexRuntimeSummary = session
    ? codexRuntimeSummary(session.runtimeModel, session.runtimeEffort, session.runtimePermissionPreset)
    : '未加载当前托管会话快照';
  const dshDefaultSelection = dshConfiguration?.models.defaultSelection;
  const dshDefaultModel = dshConfiguration?.models.groups
    .find((group) => group.id === dshDefaultSelection?.provider)
    ?.models.find((model) => model.id === dshDefaultSelection?.model);
  const dshEffectiveSelection = dshModelOverride ?? dshDefaultSelection;
  const dshEffectiveModelGroup = dshConfiguration?.models.groups.find((group) => group.id === dshEffectiveSelection?.provider);
  const dshEffectiveModel = dshEffectiveModelGroup?.models.find((model) => model.id === dshEffectiveSelection?.model);
  const dshEffectiveEffort = dshEffectiveSelection?.reasoningEffort
    ?? dshEffectiveModel?.reasoning?.defaultEffort;
  const dshDefaultAgent = dshConfiguration?.agentPresets.find((preset) => preset.id === dshConfiguration.defaultAgentPreset);
  const dshEffectiveAgent = dshConfiguration?.agentPresets.find((preset) => preset.id === dshAgentOverride)
    ?? dshDefaultAgent;
  const dshEffectivePermission = dshConfiguration?.permission?.options.find((option) => (
    option.id === (dshPermissionOverride ?? dshConfiguration.permission?.defaultPreset)
  ));
  const nextDshRuntimeSummary = dshConfigurationStatus === 'ready'
    ? `开启配置：${dshEffectiveModel?.name ?? dshEffectiveSelection?.model ?? 'DSH 默认模型'} · ${
      dshEffectiveAgent?.name ?? dshEffectiveAgent?.id ?? '默认 Agent'
    } · ${dshEffectivePermission?.name ?? dshConfiguration?.permission?.defaultPreset ?? '默认权限'}`
    : dshConfigurationStatus === 'error'
      ? '启动配置读取失败'
      : '正在读取 DSH 启动配置';
  const startBlockReason = !selectedBackend
    ? '当前未启用 AI，请在设置中选择 Codex 或 DSH 并重启应用。'
    : !selectedProject
      ? '这台设备尚未添加托管项目；项目目录是本机配置，不会随账号自动同步。'
      : selectedBackend === 'codex' && !hostingModel
        ? '尚未读取到可用 Codex 模型，请检查 Codex 配置或稍后重试。'
        : selectedBackend === 'deepseek' && dshConfigurationStatus === 'error'
          ? `DSH 启动配置尚未就绪：${dshConfigurationError || '读取模型、Agent 或权限失败'}`
          : selectedBackend === 'deepseek' && dshConfigurationStatus !== 'ready'
            ? 'DSH 启动配置尚未就绪，正在读取模型、Agent 和权限。'
            : null;
  const activeDshRuntimeSummary = session
    ? `${session.dshModelSelection?.model ?? 'DSH 默认模型'} · ${
      session.dshAgentPreset ?? '默认 Agent'
    } · ${session.dshPermissionPreset ?? '默认权限'}`
    : nextDshRuntimeSummary;
  const backendSummary = currentBackend === 'deepseek'
    ? (session ? activeDshRuntimeSummary : nextDshRuntimeSummary)
    : currentBackend === 'codex'
      ? (session ? activeCodexRuntimeSummary : nextCodexRuntimeSummary)
      : '当前启动为“无 AI”，只能查看既有托管信息，不能新开会话。';

  const addHostingProject = async (): Promise<void> => {
    const path = await open({ directory: true, multiple: false, title: '选择 AI 托管项目' });
    if (typeof path !== 'string') return;
    const environmentState = useAgentEnvironments.getState();
    const environment = environmentState.ensureEnvironment({ path });
    if (environmentIsBusy(environment.id, environmentState.bindings)) {
      throw new Error('这个项目正被活动讨论使用，请先结束对应的 AI 托管');
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
              title="返回话题"
              onClick={() => setPanel({ kind: 'thread', mid: tmid })}
              className="rounded p-1 text-ink-2 hover:bg-fill-hover"
            >
              <ChevronLeft size={16} />
            </button>
          ) : null}
          <Bot size={16} className="text-primary" />
          AI 托管
        </span>
      }
    >
      <div className="flex items-center justify-between gap-3 border-b border-line bg-fill-1 px-4 py-2.5 text-xs">
        <div className="min-w-0">
          <div className="font-medium text-ink">AI 托管配置</div>
          <div className="mt-0.5 truncate text-ink-3" title={`${backendDisplayName(currentBackend)} · ${backendSummary}`}>
            {backendDisplayName(currentBackend)} · {backendSummary}
          </div>
        </div>
        <button
          type="button"
          onClick={() => openButlerConversation(tmid)}
          className="shrink-0 rounded-md border border-line bg-surface px-2.5 py-1.5 text-ink-2 hover:bg-fill-hover"
        >
          在 AI 管家中查看
        </button>
      </div>
      {error ? <div className="border-b border-line bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div> : null}
      {remoteSession ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary">
            <Bot size={28} />
          </div>
          <div>
            <div className="font-medium text-ink">@{remoteSession.hostUsername} 正在另一台设备托管</div>
            <div className="mt-1 text-xs leading-5 text-ink-3">
              这是当前房间的同一条托管会话；本设备不会重复启动 AI。
            </div>
          </div>
          <div className="w-full max-w-sm space-y-3 rounded-lg border border-line bg-fill-1 p-4 text-left text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">状态</span>
              <span className="text-xs text-ink">{remoteSession.status === 'interrupted' ? '已中断' : '正在工作'}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">后端</span>
              <span className="text-xs text-ink">{backendLabel(remoteBackend(remoteSession))}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">项目</span>
              <span className="truncate text-xs text-ink" title={remoteSession.environmentName}>
                {remoteSession.environmentName || '未指定项目'}
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="shrink-0 text-ink-3">当前任务</span>
              <span className="text-right text-xs text-ink">
                {remoteSession.currentTaskLabel
                  || (remoteSession.workItem ? `#${remoteSession.workItem.id} ${remoteSession.workItem.title}` : '等待房间指令')}
              </span>
            </div>
          </div>
          <div className="text-xs text-ink-3">
            {remoteSession.status === 'interrupted'
              ? '请由当前宿主设备恢复后，再继续发送 @ai 指令。'
              : '房间成员仍可在消息中使用 @ai；恢复和结束由当前宿主设备控制。'}
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
                ? `为工作项 #${binding.workItemId} 开启 AI 托管`
                : roomSession
                  ? '在当前房间开启 AI 托管'
                  : '在当前话题开启 AI 托管'}
            </div>
            <div className="mt-1 text-xs leading-5 text-ink-3">
              房间侧栏和 AI 管家引用同一条托管会话；AI 托管只使用专用工作项目。
            </div>
          </div>
          {!desktopRuntime ? (
            <div className="rounded-md border border-line bg-fill-1 px-3 py-2 text-xs text-ink-3">
              共享 Agent 仅支持 RocketX 桌面端。
            </div>
          ) : (
            <>
              <div className="w-full max-w-sm">
                <div className="mb-3 text-left text-xs text-ink-3">
                  <span className="mb-1 block">运行时：{backendDisplayName(selectedBackend)}</span>
                  <div className="mt-1 text-ink-3">
                    {selectedBackend === 'deepseek'
                      ? nextDshRuntimeSummary
                      : selectedBackend === 'codex'
                        ? nextCodexRuntimeSummary
                        : '当前启动为“无 AI”，只能查看既有托管信息，不能新开会话。'}
                  </div>
                </div>
                <label className="block text-left text-xs text-ink-3">
                  <span className="mb-1 block">托管项目</span>
                  <select
                    aria-label="AI 托管项目"
                    value={selectedProject ?? ''}
                    onChange={(event) => setProjectOverride(event.target.value)}
                    className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                  >
                    {!selectedProject ? <option value="">尚未添加项目</option> : null}
                    {availableProjects.map((environment) => (
                      <option key={environment.id} value={environment.path}>
                        {environment.name || projectName(environment.path)}
                        {environment.path === roomProject ? '（此群）' : environment.path === currentProject ? '（当前）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedBackend === 'codex' ? (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="col-span-2 block text-left text-xs text-ink-3">
                      <span className="mb-1 block">模型</span>
                      <select
                        aria-label="AI 托管模型"
                        value={hostingModel}
                        onChange={(event) => {
                          const model = models.find((item) => item.model === event.target.value || item.id === event.target.value);
                          setRuntimeModelOverride(event.target.value);
                          setRuntimeEffortOverride(model?.defaultReasoningEffort ?? null);
                        }}
                        className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                      >
                        {models.length === 0 ? <option value="">正在读取模型…</option> : null}
                        {models.filter((model) => !model.hidden).map((model) => (
                          <option key={model.id} value={model.model}>{model.displayName}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-left text-xs text-ink-3">
                      <span className="mb-1 block">推理强度</span>
                      <select
                        aria-label="AI 托管推理强度"
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
                      <span className="mb-1 block">权限</span>
                      <select
                        aria-label="AI 托管权限"
                        value={hostingPermissionPreset}
                        onChange={(event) => setRuntimePermissionOverride(event.target.value as AgentSession['runtimePermissionPreset'])}
                        className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                      >
                        <option value="ask">询问审批</option>
                        <option value="auto">替我审批</option>
                        <option value="full">完全访问</option>
                      </select>
                    </label>
                  </div>
                ) : null}
                {selectedBackend === 'deepseek' ? (
                  <div className="mt-3">
                    {dshConfigurationStatus === 'loading' || dshConfigurationStatus === 'idle' ? (
                      <div className="flex h-20 items-center justify-center gap-2 rounded-md border border-line bg-fill-1 text-xs text-ink-3">
                        <Loader2 size={14} className="animate-spin" /> 正在读取 DSH 模型、Agent 和权限…
                      </div>
                    ) : dshConfigurationStatus === 'error' ? (
                      <div className="rounded-md border border-danger/30 bg-danger/10 p-3 text-left text-xs text-danger">
                        <div>{dshConfigurationError || '读取 DSH 启动配置失败'}</div>
                        <button
                          type="button"
                          onClick={() => {
                            if (!tmid || !selectedProject) return;
                            setDshConfigurationStatus('loading');
                            setDshConfigurationError('');
                            void releaseSharedDshStartConfiguration(tmid)
                              .then(() => prepareSharedDshStartConfiguration(tmid, selectedProject))
                              .then((configuration) => {
                                setDshConfiguration(configuration);
                                setDshConfigurationStatus('ready');
                              })
                              .catch((reason) => {
                                setDshConfigurationError(reason instanceof Error ? reason.message : String(reason));
                                setDshConfigurationStatus('error');
                              });
                          }}
                          className="mt-2 rounded border border-danger/40 px-2 py-1 hover:bg-danger/10"
                        >
                          重试
                        </button>
                      </div>
                    ) : dshConfiguration ? (
                      <div className="grid grid-cols-2 gap-3">
                        <label className="col-span-2 block text-left text-xs text-ink-3">
                          <span className="mb-1 block">模型</span>
                          <select
                            aria-label="DSH AI 托管模型"
                            value={dshModelOverride ? dshModelKey(dshModelOverride) : ''}
                            onChange={(event) => {
                              if (!event.target.value) {
                                setDshModelOverride(undefined);
                                return;
                              }
                              const [provider, modelId] = JSON.parse(event.target.value) as [string, string];
                              const model = dshConfiguration.models.groups
                                .find((group) => group.id === provider)
                                ?.models.find((item) => item.id === modelId);
                              setDshModelOverride({
                                provider,
                                model: modelId,
                                ...(model?.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}),
                              });
                            }}
                            className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                          >
                            <option value="">
                              沿用 DSH 默认（{dshDefaultModel?.name ?? dshDefaultSelection?.model ?? '当前模型'}）
                            </option>
                            {dshConfiguration.models.groups.flatMap((group) => group.models.map((model) => (
                              <option key={`${group.id}:${model.id}`} value={dshModelKey({ provider: group.id, model: model.id })}>
                                {group.name} · {model.name}
                              </option>
                            )))}
                          </select>
                        </label>
                        <label className="block text-left text-xs text-ink-3">
                          <span className="mb-1 block">推理强度</span>
                          <select
                            aria-label="DSH AI 托管推理强度"
                            value={dshEffectiveEffort ?? ''}
                            disabled={!dshModelOverride || !dshEffectiveModel?.reasoning?.efforts.length}
                            onChange={(event) => setDshModelOverride((current) => (
                              current ? { ...current, reasoningEffort: event.target.value || undefined } : current
                            ))}
                            className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary disabled:opacity-60"
                          >
                            {!dshEffectiveModel?.reasoning?.efforts.length ? <option value="">模型默认</option> : null}
                            {dshEffectiveModel?.reasoning?.efforts.map((effort) => (
                              <option key={effort.id} value={effort.id}>{effort.name}</option>
                            ))}
                          </select>
                        </label>
                        <label className="block text-left text-xs text-ink-3">
                          <span className="mb-1 block">Agent</span>
                          <select
                            aria-label="DSH AI 托管 Agent"
                            value={dshAgentOverride ?? ''}
                            onChange={(event) => setDshAgentOverride(event.target.value || undefined)}
                            className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                          >
                            <option value="">
                              沿用 DSH 默认（{dshDefaultAgent?.name ?? dshDefaultAgent?.id ?? '当前 Agent'}）
                            </option>
                            {dshConfiguration.agentPresets.map((preset) => (
                              <option key={preset.id} value={preset.id} disabled={!!preset.broken}>
                                {preset.name ?? preset.id}{preset.broken ? `（不可用：${preset.broken}）` : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="col-span-2 block text-left text-xs text-ink-3">
                          <span className="mb-1 block">权限</span>
                          <select
                            aria-label="DSH AI 托管权限"
                            value={dshPermissionOverride ?? ''}
                            onChange={(event) => setDshPermissionOverride(event.target.value || undefined)}
                            className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                          >
                            <option value="">
                              沿用 DSH 默认（{dshEffectivePermission?.name ?? dshConfiguration.permission?.defaultPreset ?? '当前权限'}）
                            </option>
                            {dshConfiguration.permission?.options.map((option) => (
                              <option key={option.id} value={option.id}>{option.name}</option>
                            ))}
                          </select>
                        </label>
                        {dshModelOverride ? (
                          <div className="col-span-2 text-left text-xs leading-4 text-warning">
                            DSH 当前接口会把这次显式模型选择同步为后续会话的默认模型。
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button
                disabled={
                  starting
                  || !selectedBackend
                  || (!!selectedProject && selectedBackend === 'codex' && !hostingModel)
                  || (!!selectedProject && selectedBackend === 'deepseek' && dshConfigurationStatus !== 'ready')
                }
                onClick={() => {
                  if (!selectedProject) {
                    void addHostingProject().catch((reason) => toast.error(reason, '无法添加托管项目'));
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
                    dshModelSelection: dshModelOverride,
                    dshAgentPreset: dshAgentOverride,
                    dshPermissionPreset: dshPermissionOverride,
                  };
                  setStartFailure('');
                  setStartingTmid(tmid);
                  void start(rid, tmid, startOptions)
                    .then(() => {
                      if (tmid.startsWith('room:')) setRoomHostingWorkspace(rid, selectedProject);
                    })
                    .catch((startError) => {
                      setStartFailure(startError instanceof Error ? startError.message : String(startError));
                      toast.error(startError, '开启 AI 托管失败');
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
                  ? '正在开启…'
                  : !selectedBackend
                    ? '当前未启用 AI'
                    : !selectedProject
                      ? '添加托管项目'
                      : '开启 AI 托管'}
              </button>
              {startFailure ? (
                <div role="alert" className="w-full max-w-sm rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-left text-xs leading-5 text-danger">
                  无法开启 AI 托管：{startFailure}
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
              <span className="text-ink-3">状态</span>
              <span className="rounded bg-fill-1 px-2 py-0.5 text-xs text-ink">{statusLabel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-3">后端</span>
              <span className="rounded bg-fill-1 px-2 py-0.5 text-xs text-ink">{backendLabel(agentBackend(session))}</span>
            </div>
            <div className="text-xs text-ink-3">
              {currentBackend === 'deepseek' ? activeDshRuntimeSummary : activeCodexRuntimeSummary}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-3">指挥范围</span>
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
                {session.access === 'host-only' ? '仅自己' : '房间成员'}
              </button>
            </div>
            {session.codexThreadId ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-3">Codex 任务</span>
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    title={`复制 codex resume ${session.codexThreadId}，在 Codex 命令行里接着这次对话`}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(`codex resume ${session.codexThreadId}`)
                        .then(() => toast.success('已复制。建议结束托管后再在 Codex 里继续，两边同时写同一次对话会打架'));
                    }}
                    className="flex min-w-0 items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover"
                  >
                    <Copy size={12} />
                    <span className="truncate">codex resume</span>
                  </button>
                  <button
                    title="在 Codex App 打开新任务并填好托管记录，由你按回车发出"
                    disabled={transferring || session.status === 'running'}
                    onClick={() => {
                      setTransferring(true);
                      void transferToCodexApp(tmid)
                        .then((result) => {
                          if (result === 'unavailable') {
                            throw new Error('无法打开 Codex App，也无法复制对话记录');
                          }
                          toast.success(
                            result === 'opened-existing'
                              ? '已在 Codex App 接续当前任务'
                              : result === 'opened'
                              ? '已打开 Codex App，完整记录已填入，请确认后发送'
                              : result === 'opened-with-copy'
                                ? '对话较长：已打开 Codex App 并复制完整记录，请粘贴后发送'
                                : 'Codex App 打开失败，完整记录已复制',
                          );
                        })
                        .catch((error) => toast.error(error, '在 Codex App 打开失败'))
                        .finally(() => setTransferring(false));
                    }}
                    className="flex shrink-0 items-center gap-1 rounded bg-fill-1 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
                  >
                    {transferring ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
                    在 Codex App 打开
                  </button>
                </div>
              </div>
            ) : null}
            <div className="truncate text-xs text-ink-3" title={session.workspaceRoots[0]}>
              {session.workspaceRoots[0]}
            </div>
            {!providerCompatible ? (
              <div className="rounded-md bg-warning-light px-2.5 py-2 text-xs leading-5 text-ink-2">
                这条托管会话使用 {backendLabel(agentBackend(session))}；当前执行引擎为 {backendDisplayName(selectedBackend)}。
                会话记录仍保留，切回对应引擎并重启后可恢复。
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
                <span className="font-medium text-ink">进入本房间时自动开启托管</span>
                <span className="mt-0.5 block text-xs text-ink-3">
                  仅在这台设备生效；已有其他人托管时不会抢占。
                </span>
              </span>
            </label>
            <div className="flex gap-2">
              {session.status === 'interrupted' ? (
                <button
                  disabled={resuming || !providerCompatible}
                  title={!providerCompatible ? `需要启用 ${backendLabel(agentBackend(session))} 后恢复` : undefined}
                  onClick={() => {
                    setResumingTmid(tmid);
                    void resume(tmid)
                      .catch((resumeError) => toast.error(resumeError, '恢复 AI 托管失败'))
                      .finally(() => setResumingTmid((current) => (current === tmid ? null : current)));
                  }}
                  className="flex flex-1 items-center justify-center gap-1 rounded border border-primary px-2 py-1.5 text-xs text-primary disabled:opacity-50"
                >
                  {resuming ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  {resuming ? '恢复中…' : '恢复'}
                </button>
              ) : null}
              <button
                disabled={resuming}
                onClick={() => void end(tmid)}
                className="flex flex-1 items-center justify-center gap-1 rounded border border-line px-2 py-1.5 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
              >
                <Square size={12} /> 结束
              </button>
            </div>
          </div>

          {(members.length > 0 || approvals.length > 0 || inputs.length > 0 || dshQuestions.length > 0) && (
            <div className="space-y-3 border-b border-line bg-warning-light/30 p-4">
              {members.map((request) => (
                <div key={request.id} className="rounded-md border border-line bg-surface-3 p-3 text-xs">
                  <div className="font-medium text-ink">@{request.command.username} 请求指挥 Agent</div>
                  <div className="mt-1 line-clamp-3 text-ink-3">{request.command.text}</div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => void approveMember(request.id, true)}
                      className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-white"
                    >
                      <Check size={12} /> 放行本次任务
                    </button>
                    <button
                      onClick={() => void approveMember(request.id, false)}
                      className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                    >
                      <X size={12} /> 拒绝
                    </button>
                  </div>
                </div>
              ))}
              {approvals.map((approval) => (
                <div key={approval.id} className="rounded-md border border-line bg-surface-3 p-3 text-xs">
                  <div className="font-medium text-ink">等你在这台电脑上批准</div>
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-ink-3">
                    {approvalSummary(approval.method, approval.params)}
                  </pre>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => void resolveApproval(approval.id, 'decline')}
                      className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                    >
                      <X size={12} /> 拒绝
                    </button>
                    {approval.method.startsWith('item/') ? (
                      <button
                        onClick={() => void resolveApproval(approval.id, 'accept-session')}
                        className="flex items-center gap-1 rounded border border-line px-2 py-1 text-ink-2"
                      >
                        <Check size={12} /> 本次任务允许
                      </button>
                    ) : null}
                    <button
                      onClick={() => void resolveApproval(approval.id, 'accept')}
                      className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-white"
                    >
                      <Check size={12} /> 允许一次
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
              {dshQuestions.map((question) => (
                <DshQuestionCard
                  key={question.id}
                  question={question}
                  respondQuestion={(answers) => resolveDshQuestion(question.id, answers)}
                />
              ))}
            </div>
          )}

          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-2 text-xs font-medium text-ink-2">它做了哪些操作</div>
            {traces.length === 0 ? (
              <div className="py-8 text-center text-xs text-ink-3">还没有人下过指令。在这个话题里发一条 @ai 开头的消息，它就开始干活。</div>
            ) : (
              <div className="space-y-2">
                {traces.map((item) => (
                  <div key={item.id} className="rounded bg-fill-1 px-2.5 py-2 text-xs text-ink-2">
                    <span className="mr-2 text-ink-3">{new Date(item.at).toLocaleTimeString()}</span>
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
