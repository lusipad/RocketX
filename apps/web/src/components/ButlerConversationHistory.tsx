import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  Blocks,
  Bot,
  CalendarClock,
  ChevronRight,
  Cpu,
  FolderMinus,
  FolderOpen,
  GitPullRequest,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquareKanban,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { openCodexNewThread, openCodexSurface } from '../agent/codexTransfer';
import { getServerBase, isTauriRuntime } from '../lib/client';
import { pinyinMatch, usePinyinReady } from '../lib/pinyin';
import { openDesktopDialog } from '../platform/desktopDialog';
import {
  HOSTED_SESSION_STATUS_LABEL,
  type HostedSessionItem,
  useHostedSessionItems,
} from '../lib/hostedSessions';
import {
  environmentIsBusy,
  findEnvironmentByPath,
  normalizeEnvironmentPath,
  useAgentEnvironments,
} from '../stores/agentEnvironments';
import { useAuth } from '../stores/auth';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { useChat } from '../stores/chat';
import { isSystemCodexWorkspace, useCodexWorkspace } from '../stores/codexWorkspace';
import { useSharedAgent } from '../stores/sharedAgent';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import { useWorkLedger } from '../stores/workLedger';
import ButlerProjectConfigDialog, { type ButlerProjectConfigPatch } from './ButlerProjectConfigDialog';
import { ConfirmDialog } from './Dialog';

const THREAD_PREVIEW_LIMIT = 5;

interface HostedSessionGroup {
  key: string;
  label: string;
  projectPath?: string;
  sessions: HostedSessionItem[];
  lastUpdated: number;
  activeCount: number;
}

function threadTitle(name: string | null, preview: string): string {
  return name?.trim() || preview.trim() || '新对话';
}

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function workspaceKey(path: string): string {
  return normalizeEnvironmentPath(path);
}

function ageLabel(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp * 1_000);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`;
  return `${Math.floor(elapsed / 86_400_000)} 天`;
}

export default function ButlerConversationHistory({ onNavigate }: { onNavigate?: () => void }) {
  const userId = useAuth((state) => state.user?._id);
  const localMode = useAuth((state) => state.localMode);
  const activeView = useUI((state) => state.butlerView);
  const aiRuntimeProvider = useUI((state) => state.aiRuntimeProvider);
  const setButlerView = useUI((state) => state.setButlerView);
  const selectedHostedSessionKey = useUI((state) => state.selectedHostedSessionKey);
  const setSelectedHostedSessionKey = useUI((state) => state.setSelectedHostedSessionKey);
  const setModule = useUI((state) => state.setModule);
  const setWorkbenchTab = useUI((state) => state.setWorkbenchTab);
  const hostedSessionsByKey = useSharedAgent((state) => state.sessions);
  const hostedRemoteCardsByKey = useSharedAgent((state) => state.remoteCards);
  const rooms = useChat((state) => state.rooms);
  const subscriptions = useChat((state) => state.subscriptions);
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const workspaceRoots = useCodexWorkspace((state) => state.workspaceRoots);
  const defaultWorkspaceRoot = useCodexWorkspace((state) => state.defaultWorkspaceRoot);
  const butlerWorkspaceRoot = useCodexWorkspace((state) => state.butlerWorkspaceRoot);
  const status = useCodexWorkspace((state) => state.status);
  const error = useCodexWorkspace((state) => state.error);
  const threads = useCodexWorkspace((state) => state.threads);
  const threadStates = useCodexWorkspace((state) => state.threadStates);
  const activeThreadId = useCodexWorkspace((state) => state.activeThreadId);
  const activeTurnId = useCodexWorkspace((state) => state.activeTurnId);
  const models = useCodexWorkspace((state) => state.models);
  const selectedModel = useCodexWorkspace((state) => state.selectedModel);
  const activeModel = models.find((model) => model.model === selectedModel || model.id === selectedModel);
  const activeCardCount = useWorkLedger((state) => state.cards.filter((c) => !c.done).length);
  const hydrate = useCodexWorkspace((state) => state.hydrate);
  const ensureDefaultWorkspace = useCodexWorkspace((state) => state.ensureDefaultWorkspace);
  const setWorkspaceRoot = useCodexWorkspace((state) => state.setWorkspaceRoot);
  const removeWorkspaceRoot = useCodexWorkspace((state) => state.removeWorkspaceRoot);
  const connect = useCodexWorkspace((state) => state.connect);
  const startThread = useCodexWorkspace((state) => state.startThread);
  const resumeThread = useCodexWorkspace((state) => state.resumeThread);
  const refreshFromCodex = useCodexWorkspace((state) => state.refreshFromCodex);
  const handoffToCodex = useCodexWorkspace((state) => state.handoffToCodex);
  const renameThread = useCodexWorkspace((state) => state.renameThread);
  const archiveThread = useCodexWorkspace((state) => state.archiveThread);
  const environments = useAgentEnvironments((state) => state.environments);
  const bindings = useAgentEnvironments((state) => state.bindings);
  const ensureEnvironment = useAgentEnvironments((state) => state.ensureEnvironment);
  const updateEnvironment = useAgentEnvironments((state) => state.updateEnvironment);
  const removeEnvironment = useAgentEnvironments((state) => state.removeEnvironment);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [openingCodex, setOpeningCodex] = useState(false);
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [workspaceToRemove, setWorkspaceToRemove] = useState<string | null>(null);
  const [workspaceToConfigure, setWorkspaceToConfigure] = useState<string | null>(null);
  const [collapsedWorkspace, setCollapsedWorkspace] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [moreFeaturesOpen, setMoreFeaturesOpen] = useState(() => ['assistant', 'acp-hub', 'routines', 'plugins'].includes(activeView));
  const [hostedSectionExpandedOverride, setHostedSectionExpandedOverride] = useState<boolean | null>(null);
  const pinyinReady = usePinyinReady();
  const [expandedHostedGroups, setExpandedHostedGroups] = useState<Record<string, boolean>>({});
  const desktopRuntime = isTauriRuntime();
  const piRuntime = aiRuntimeProvider === 'pi';
  const nativeRuntime = piRuntime;
  const workspaceScope = userId ? `${getServerBase() || 'same-origin'}:${userId}` : 'local:workspace';
  const hostedSessions = useHostedSessionItems(hostedSessionsByKey, hostedRemoteCardsByKey);
  const hostedSessionCount = hostedSessions.length;
  const hostedActiveSessionCount = hostedSessions.filter((session) => session.status !== 'ended').length;
  const hostedSectionExpandedDefault = hostedSessionCount === 0 || selectedHostedSessionKey !== null;
  const hostedSectionExpanded = hostedSectionExpandedOverride ?? hostedSectionExpandedDefault;

  useEffect(() => {
    if (!nativeRuntime) return;
    hydrate(workspaceScope);
  }, [hydrate, nativeRuntime, workspaceScope]);

  useEffect(() => {
    if (!nativeRuntime || !desktopRuntime || !workspaceRoot || status !== 'idle') return;
    void connect().catch(() => undefined);
  }, [connect, desktopRuntime, nativeRuntime, status, workspaceRoot]);

  useEffect(() => {
    setHistoryExpanded(false);
  }, [workspaceRoot]);

  useEffect(() => {
    if (['assistant', 'acp-hub', 'routines', 'plugins'].includes(activeView)) setMoreFeaturesOpen(true);
  }, [activeView]);

  useEffect(() => {
    if (selectedHostedSessionKey) setHostedSectionExpandedOverride(null);
  }, [selectedHostedSessionKey]);

  useEffect(() => {
    if (!menuThreadId && !renamingThreadId) return;
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && (event.target as HTMLElement).closest('.codex-native-thread-actions')) return;
      setMenuThreadId(null);
      if (event instanceof KeyboardEvent) setRenamingThreadId(null);
    };
    document.addEventListener('keydown', close, true);
    document.addEventListener('mousedown', close, true);
    return () => {
      document.removeEventListener('keydown', close, true);
      document.removeEventListener('mousedown', close, true);
    };
  }, [menuThreadId, renamingThreadId]);

  const hostedCodexThreadIds = useMemo(() => new Set(hostedSessions.flatMap((session) => (
    session.local?.codexThreadId ? [session.local.codexThreadId] : []
  ))), [hostedSessions]);
  const personalThreads = useMemo(
    () => threads.filter((thread) => !hostedCodexThreadIds.has(thread.id)),
    [hostedCodexThreadIds, threads],
  );
  const currentWorkspaceThreads = useMemo(
    () => personalThreads.filter((thread) => workspaceKey(thread.cwd) === workspaceKey(workspaceRoot)),
    [personalThreads, workspaceRoot],
  );
  const systemWorkspaceRoots = useMemo(() => workspaceRoots.filter((path) => isSystemCodexWorkspace(
    path,
    defaultWorkspaceRoot,
    butlerWorkspaceRoot,
  )), [butlerWorkspaceRoot, defaultWorkspaceRoot, workspaceRoots]);
  const hostingProjectPaths = useMemo(() => {
    const paths = environments.map((environment) => environment.path);
    if (
      workspaceRoot
      && !isSystemCodexWorkspace(workspaceRoot, defaultWorkspaceRoot, butlerWorkspaceRoot)
      && !findEnvironmentByPath(environments, workspaceRoot)
    ) paths.unshift(workspaceRoot);
    return [...new Set(paths)];
  }, [butlerWorkspaceRoot, defaultWorkspaceRoot, environments, workspaceRoot]);
  const threadCounts = useMemo(() => new Map([...systemWorkspaceRoots, ...hostingProjectPaths].map((path) => [
    path,
    personalThreads.filter((thread) => workspaceKey(thread.cwd) === workspaceKey(path)).length,
  ])), [hostingProjectPaths, personalThreads, systemWorkspaceRoots]);
  const visibleThreads = useMemo(() => {
    const normalized = query.trim();
    if (!normalized) return currentWorkspaceThreads;
    return currentWorkspaceThreads.filter((thread) => pinyinMatch(normalized, thread.name ?? '', thread.preview));
  }, [currentWorkspaceThreads, query, pinyinReady]);
  const displayedThreads = useMemo(() => {
    if (query.trim() || historyExpanded || visibleThreads.length <= THREAD_PREVIEW_LIMIT) return visibleThreads;
    const recent = visibleThreads.slice(0, THREAD_PREVIEW_LIMIT);
    const active = visibleThreads.find((thread) => thread.id === activeThreadId);
    return active && !recent.some((thread) => thread.id === active.id) ? [...recent, active] : recent;
  }, [activeThreadId, historyExpanded, query, visibleThreads]);
  const hiddenThreadCount = Math.max(0, visibleThreads.length - displayedThreads.length);
  const configuredEnvironment = workspaceToConfigure
    ? findEnvironmentByPath(environments, workspaceToConfigure)
    : undefined;
  const configuredEnvironmentBusy = configuredEnvironment
    ? environmentIsBusy(configuredEnvironment.id, bindings)
    : false;
  const projectEntries = useMemo(() => [
    ...systemWorkspaceRoots.map((path) => {
      const systemDefault = path === defaultWorkspaceRoot;
      const systemButler = path === butlerWorkspaceRoot;
      return {
        path,
        kind: systemDefault ? 'temporary' : systemButler ? 'butler' : 'hosting',
        label: systemDefault ? '临时会话' : systemButler ? '管家会话' : workspaceName(path),
        tooltipPath: undefined,
        removable: false,
        configurable: false,
        busy: false,
      } as const;
    }),
    ...hostingProjectPaths.map((path) => {
      const environment = findEnvironmentByPath(environments, path);
      const label = environment?.name || workspaceName(path);
      return {
        path,
        kind: 'hosting' as const,
        label,
        tooltipPath: environment?.name && environment.name !== path ? path : undefined,
        removable: true,
        configurable: true,
        busy: environment ? environmentIsBusy(environment.id, bindings) : false,
      };
    }),
  ], [
    bindings,
    butlerWorkspaceRoot,
    defaultWorkspaceRoot,
    environments,
    hostingProjectPaths,
    systemWorkspaceRoots,
  ]);
  const visibleProjectEntries = projectEntries.filter((entry) => entry.kind === 'hosting'
    || (threadCounts.get(entry.path) ?? 0) > 0
    || (entry.path === workspaceRoot && Boolean(activeThreadId)));
  const firstHostingProjectIndex = visibleProjectEntries.findIndex((entry) => entry.kind === 'hosting');
  const hostedSessionGroups = useMemo(() => {
    const groups = new Map<string, HostedSessionGroup>();

    for (const session of hostedSessions) {
      const projectPath = session.projectPath?.trim();
      const key = projectPath
        ? `path:${workspaceKey(projectPath)}`
        : `name:${session.project.trim().toLocaleLowerCase('zh-CN') || '未指定项目'}`;
      const label = session.project.trim() || session.projectPath?.split(/[\\/]/).filter(Boolean).at(-1) || '未指定项目';
      const group = groups.get(key);
      if (group) {
        group.sessions.push(session);
        group.lastUpdated = Math.max(group.lastUpdated, session.updatedAt);
        if (session.status !== 'ended') group.activeCount += 1;
        continue;
      }
      groups.set(key, {
        key,
        label,
        projectPath,
        sessions: [session],
        lastUpdated: session.updatedAt,
        activeCount: session.status === 'ended' ? 0 : 1,
      });
    }

    return [...groups.values()].sort((left, right) => (
      Number(right.activeCount > 0) - Number(left.activeCount > 0)
      || right.lastUpdated - left.lastUpdated
    ));
  }, [hostedSessions]);
  const renderThreadHistory = () => (
    <nav
      aria-label="Codex 对话历史"
      className="!min-h-0 !flex-none !overflow-visible !pt-0 !pr-0 !pb-1 !pl-5"
    >
      <ul>
        {displayedThreads.map((thread) => {
          const selected = thread.id === activeThreadId;
          const runtimeState = threadStates[thread.id];
          const running = runtimeState
            ? ['connecting', 'running', 'waiting-input'].includes(runtimeState.status)
              || Boolean(runtimeState.activeTurnId)
            : thread.status.type === 'active' || (selected && Boolean(activeTurnId));
          const waiting = runtimeState?.status === 'waiting-input';
          return (
            <li key={thread.id} className="codex-native-thread-row">
              {renamingThreadId === thread.id ? (
                <form
                  className="codex-native-thread-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void renameThread(thread.id, renameValue)
                      .then(() => { setRenamingThreadId(null); setMenuThreadId(null); })
                      .catch((reason) => toast.error(reason, '无法重命名对话'));
                  }}
                >
                  <input autoFocus aria-label="对话名称" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
                  <button type="submit" disabled={!renameValue.trim()}>保存</button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="codex-native-thread-main"
                    onClick={() => {
                      setButlerView('conversation');
                      onNavigate?.();
                      if (!selected) void resumeThread(thread.id).catch((reason) => toast.error(reason, '无法打开对话'));
                    }}
                    aria-current={selected ? 'page' : undefined}
                  >
                    <span
                      className={`butler-conversation-history-status ${running ? 'is-running' : ''}`}
                      title={waiting ? '等待确认' : running ? '运行中' : undefined}
                    />
                    <span className="butler-conversation-history-title">{threadTitle(thread.name, thread.preview)}</span>
                    <time dateTime={new Date(thread.updatedAt * 1_000).toISOString()}>{ageLabel(thread.updatedAt)}</time>
                  </button>
                  <div className="codex-native-thread-actions">
                    <button
                      type="button"
                      aria-label={`更多对话操作：${threadTitle(thread.name, thread.preview)}`}
                      aria-expanded={menuThreadId === thread.id}
                      onClick={() => setMenuThreadId((current) => current === thread.id ? null : thread.id)}
                    >
                      <MoreHorizontal size={14} aria-hidden="true" />
                    </button>
                    {menuThreadId === thread.id ? (
                      <div role="menu" aria-label="对话操作">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setRenameValue(threadTitle(thread.name, thread.preview));
                            setRenamingThreadId(thread.id);
                            setMenuThreadId(null);
                          }}
                        >
                          <Pencil size={13} aria-hidden="true" />重命名
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => void archiveThread(thread.id)
                            .then(() => setMenuThreadId(null))
                            .catch((reason) => toast.error(reason, '无法归档对话'))}
                        >
                          <Archive size={13} aria-hidden="true" />归档
                        </button>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {!query.trim() && visibleThreads.length > THREAD_PREVIEW_LIMIT ? (
        <button
          type="button"
          className="codex-native-thread-expand"
          aria-expanded={historyExpanded}
          onClick={() => setHistoryExpanded((current) => !current)}
        >
          {historyExpanded ? '收起较早对话' : `展开其余 ${hiddenThreadCount} 个`}
        </button>
      ) : null}
      {desktopRuntime && status === 'unavailable' ? <p className="butler-codex-task-empty">{error}</p> : null}
      {(!desktopRuntime || status !== 'unavailable') && visibleThreads.length === 0 ? (
        <p className="butler-codex-task-empty">
          {!desktopRuntime ? '请使用 RocketX 桌面端运行 AI 管家任务' : '还没有对话'}
        </p>
      ) : null}
    </nav>
  );

  const chooseWorkspace = async (): Promise<boolean> => {
    if (!isTauriRuntime()) throw new Error('网页版没有本地 Pi 执行面，请使用 RocketX 桌面端');
    const path = await openDesktopDialog({ directory: true, multiple: false, title: '选择工作区' });
    if (typeof path !== 'string') return false;
    ensureEnvironment({ path });
    await setWorkspaceRoot(path);
    await connect();
    setCollapsedWorkspace(null);
    return true;
  };

  const selectWorkspace = async (path: string): Promise<void> => {
    if (path === workspaceRoot) {
      setCollapsedWorkspace((current) => current === path ? null : path);
      return;
    }
    setCollapsedWorkspace(null);
    await setWorkspaceRoot(path);
    await connect();
  };

  const saveProjectConfig = (path: string, patch: ButlerProjectConfigPatch): void => {
    const environment = findEnvironmentByPath(useAgentEnvironments.getState().environments, path);
    if (environment) {
      updateEnvironment(environment.id, patch);
      return;
    }
    const created = ensureEnvironment({
      path,
      name: patch.name,
      adoProjects: patch.adoProjects,
      defaultBaseBranch: patch.defaultBaseBranch,
      branchPrefix: patch.branchPrefix,
    });
    if (!patch.enabled) updateEnvironment(created.id, { enabled: false });
  };

  const removeProject = async (path: string): Promise<void> => {
    const environment = findEnvironmentByPath(useAgentEnvironments.getState().environments, path);
    if (environment && environmentIsBusy(environment.id, useAgentEnvironments.getState().bindings)) {
      throw new Error('该项目正在被活动讨论使用，请先结束 Agent 会话');
    }
    const runtimeState = useCodexWorkspace.getState();
    if (runtimeState.workspaceRoot === path) {
      const fallback = runtimeState.butlerWorkspaceRoot || await runtimeState.ensureDefaultWorkspace();
      if (fallback) {
        await setWorkspaceRoot(fallback);
        await connect();
      }
    }
    if (environment) removeEnvironment(environment.id);
    await removeWorkspaceRoot(path);
    setCollapsedWorkspace(null);
  };

  const createConversation = async (): Promise<void> => {
    const accountScope = resolveButlerAccountScope();
    const runtimeScope = useCodexWorkspace.getState().scope;
    const isCurrentAccount = () => resolveButlerAccountScope() === accountScope
      && useCodexWorkspace.getState().scope === runtimeScope;
    try {
      await ensureDefaultWorkspace();
      if (!isCurrentAccount()) return;
      const butlerRoot = useCodexWorkspace.getState().butlerWorkspaceRoot;
      if (!butlerRoot) throw new Error('系统管家工作区尚未准备好');
      if (useCodexWorkspace.getState().workspaceRoot !== butlerRoot) {
        await setWorkspaceRoot(butlerRoot);
        if (!isCurrentAccount()) return;
        await connect();
      } else if (useCodexWorkspace.getState().status === 'idle') {
        await connect();
      }
      if (!isCurrentAccount()) return;
      await startThread();
      if (!isCurrentAccount()) return;
      setButlerView('conversation');
      onNavigate?.();
    } catch (reason) {
      if (isCurrentAccount()) toast.error(reason, '无法新建对话');
    }
  };

  const openCodex = async (): Promise<void> => {
    setOpeningCodex(true);
    try {
      let result;
      if (activeView === 'routines') result = await openCodexSurface('scheduled');
      else if (activeView === 'plugins') result = await openCodexSurface('plugins');
      else if (activeThreadId) {
        result = await handoffToCodex();
        if (result === 'unavailable') await refreshFromCodex().catch(() => undefined);
      } else result = workspaceRoot ? await openCodexNewThread('', workspaceRoot) : 'unavailable';
      if (result === 'unavailable') throw new Error('Codex App 没有响应');
    } catch (reason) {
      toast.error(reason, '无法切换到 Codex App');
    } finally {
      setOpeningCodex(false);
    }
  };

  const hostedSessionsNavigation = (
    <section
      className={`butler-hosted-sessions${nativeRuntime ? '' : ' is-standalone'}`}
      aria-label="共享 AI 托管"
      hidden={(!userId && hostedSessionCount === 0) || undefined}
    >
      <button
        type="button"
        className="butler-hosted-section-toggle"
        aria-expanded={hostedSectionExpanded}
        aria-label={`AI 托管，${hostedActiveSessionCount > 0 ? `${hostedActiveSessionCount} 条活动，` : ''}${hostedSessionCount} 条会话`}
        onClick={() => setHostedSectionExpandedOverride((current) => !(current ?? hostedSectionExpandedDefault))}
      >
        <ChevronRight size={13} className={hostedSectionExpanded ? 'is-expanded' : undefined} aria-hidden="true" />
        <Bot size={14} aria-hidden="true" />
        <span>AI 托管</span>
        <small>{hostedActiveSessionCount > 0 ? `${hostedActiveSessionCount} 活动 · ${hostedSessionCount}` : hostedSessionCount}</small>
      </button>
      {hostedSectionExpanded ? (
        <nav aria-label="AI 托管会话" className="butler-hosted-session-list">
          {hostedSessionGroups.length === 0 ? (
            <p className="butler-hosted-session-empty">还没有房间托管会话。</p>
          ) : hostedSessionGroups.map((group) => {
            const defaultExpanded = group.sessions.some((session) => session.key === selectedHostedSessionKey);
            const expanded = expandedHostedGroups[group.key] ?? defaultExpanded;
            const groupSummary = group.activeCount > 0
              ? `${group.activeCount} 活动 · ${group.sessions.length} 条`
              : `${group.sessions.length} 条 · 已结束`;
            return (
              <section
                key={group.key}
                className="butler-hosted-session-group"
                aria-label={`托管项目：${group.label}`}
              >
                <button
                  type="button"
                  className="butler-hosted-session-group-toggle"
                  aria-expanded={expanded}
                  aria-label={`${group.label}，${groupSummary}托管会话`}
                  title={group.projectPath}
                  onClick={() => {
                    setExpandedHostedGroups((current) => ({
                      ...current,
                      [group.key]: !(current[group.key] ?? defaultExpanded),
                    }));
                  }}
                >
                  <ChevronRight size={13} className={expanded ? 'is-expanded' : undefined} aria-hidden="true" />
                  <FolderOpen size={14} aria-hidden="true" />
                  <span>{group.label}</span>
                  <small>{groupSummary}</small>
                </button>
                {expanded ? (
                  <ul className="butler-hosted-session-items">
                    {group.sessions.map((session) => {
                      const room = subscriptions[session.rid] ?? rooms[session.rid];
                      const name = session.roomNameSnapshot || room?.fname || room?.name || session.rid || '未知房间';
                      const selected = selectedHostedSessionKey === session.key
                        || (!selectedHostedSessionKey && session.key === hostedSessions[0]?.key);
                      return (
                        <li key={session.key}>
                          <button
                            type="button"
                            data-session-key={session.key}
                            aria-current={selected ? 'page' : undefined}
                            aria-label={`${name}，${session.backend === 'deepseek' ? 'DeepSeek' : 'Codex'}，${HOSTED_SESSION_STATUS_LABEL[session.status]}，${session.task}`}
                            onClick={() => {
                              setButlerView('conversation');
                              setSelectedHostedSessionKey(session.key);
                              onNavigate?.();
                            }}
                            className="butler-hosted-session-row"
                          >
                            <span className={`butler-hosted-session-dot is-${session.status}`} aria-hidden="true" />
                            <span className="butler-hosted-session-row-main">
                              <span className="butler-hosted-session-room">{name}</span>
                              <span className="butler-hosted-session-task" title={session.task}>{session.task}</span>
                            </span>
                            <span className="butler-hosted-session-status">{HOSTED_SESSION_STATUS_LABEL[session.status]}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </nav>
      ) : null}
    </section>
  );

  if (!nativeRuntime) {
    return (
      <aside className="butler-conversation-history" aria-label="AI 管家导航">
        <div className="butler-codex-product-switcher flex h-[52px] min-h-[52px] items-center justify-between border-b border-line px-3.5">
          <button
            type="button"
            className="butler-codex-back-rocketx"
            aria-label="返回 RocketX"
            onClick={() => setModule('messages')}
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <div className="butler-codex-product-title"><strong>AI 管家</strong></div>
        </div>
        <div className="mx-3 my-2.5 rounded-xl border border-line bg-surface-4 p-3 text-xs leading-5 text-ink-2 shadow-raise">
          配置模型后，就可以向管家交代事情。已有工作和会话仍可查看，私人房间 AI 会话同样仅你可见。
          <button
            type="button"
            onClick={() => { setModule('settings'); onNavigate?.(); }}
            className="mt-2.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
          >
            <Bot size={13} />
            配置管家
          </button>
        </div>
        {aiRuntimeProvider === 'none' ? (
          <div className="mx-3 mb-2 space-y-1 text-xs">
            <button
              type="button"
              aria-current={activeView === 'kanban' ? 'page' : undefined}
              onClick={() => { setButlerView('kanban'); onNavigate?.(); }}
              className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 transition ${
                activeView === 'kanban'
                  ? 'bg-surface-4 font-semibold text-ink shadow-raise ring-1 ring-line'
                  : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              }`}
            >
              <span className="flex items-center gap-2"><SquareKanban size={13} />我的工作</span>
            </button>
            <button
              type="button"
              aria-current={activeView === 'assistant' ? 'page' : undefined}
              onClick={() => { setButlerView('assistant'); onNavigate?.(); }}
              className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 transition ${
                activeView === 'assistant'
                  ? 'bg-surface-4 font-semibold text-ink shadow-raise ring-1 ring-line'
                  : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              }`}
            >
              <span className="flex items-center gap-2"><Sparkles size={13} />个人助理</span>
            </button>
            <button
              type="button"
              aria-current={activeView === 'acp-hub' ? 'page' : undefined}
              onClick={() => { setButlerView('acp-hub'); onNavigate?.(); }}
              className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 transition ${
                activeView === 'acp-hub'
                  ? 'bg-surface-4 font-semibold text-ink shadow-raise ring-1 ring-line'
                  : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              }`}
            >
              <span className="flex items-center gap-2"><Cpu size={13} />ACP 客户端</span>
            </button>
          </div>
        ) : null}
        {hostedSessionCount > 0 ? hostedSessionsNavigation : null}
      </aside>
    );
  }

  return (
    <aside className="butler-conversation-history work-first-navigation" aria-label="AI 管家导航">
      <div className="butler-codex-product-switcher flex h-[52px] min-h-[52px] items-center justify-between border-b border-line px-3.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {!localMode ? (
            <button
              type="button"
              className="butler-codex-back-rocketx p-1 -ml-1 text-ink-3 hover:text-ink transition-colors rounded-md hover:bg-fill-hover"
              aria-label="返回 RocketX"
              onClick={() => setModule('messages')}
            >
              <ArrowLeft size={15} aria-hidden="true" />
            </button>
          ) : null}
          <div className="butler-codex-product-title flex items-center gap-1.5 truncate">
            <strong className="text-sm font-semibold text-ink">AI 管家</strong>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={searchOpen ? '关闭对话搜索' : '搜索对话'}
            aria-pressed={searchOpen}
            onClick={() => setSearchOpen((current) => !current)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 hover:bg-fill-hover hover:text-ink transition-colors"
          >
            <Search size={14} aria-hidden="true" />
          </button>
          {desktopRuntime && !piRuntime ? (
            <button
              type="button"
              aria-label="切换到 Codex App"
              disabled={openingCodex || (
                activeView === 'conversation' && Boolean(activeThreadId) && (Boolean(activeTurnId) || status === 'external')
              )}
              onClick={() => void openCodex()}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 hover:bg-fill-hover hover:text-ink transition-colors"
            >
              {openingCodex
                ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <ArrowUpRight size={13} aria-hidden="true" />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => useUI.getState().toggleButlerSidebarCollapsed()}
            title="收起会话列表 (Ctrl+B)"
            aria-label="收起会话列表"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 hover:bg-fill-hover hover:text-ink transition-colors"
          >
            <PanelLeft size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      <header className="px-2.5 pt-2.5 pb-1.5">
        <button
          type="button"
          disabled={!desktopRuntime}
          onClick={() => void createConversation()}
          aria-label="新管家对话"
          className="flex h-8.5 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover active:scale-[0.99] disabled:opacity-50"
        >
          <MessageSquarePlus size={14} className="text-white" aria-hidden="true" />
          <span className="text-white">新管家对话</span>
        </button>
        {searchOpen ? (
          <label className="butler-codex-task-search mt-2">
            <Search size={14} aria-hidden="true" />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索对话"
              placeholder="搜索对话"
            />
          </label>
        ) : null}
      </header>

      <nav className="butler-codex-surface-nav work-first-primary-nav" aria-label="AI 协作">
        <button
          type="button"
          aria-current={activeView === 'conversation' ? 'page' : undefined}
          className={`flex h-8.5 w-full items-center justify-between rounded-lg px-2.5 text-xs transition-colors ${
            activeView === 'conversation'
              ? 'bg-fill-active font-medium text-ink'
              : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
          }`}
          onClick={() => {
            setButlerView('conversation');
            onNavigate?.();
          }}
        >
          <span className="flex items-center gap-2.5">
            <Bot size={15} className={activeView === 'conversation' ? 'text-primary' : 'text-ink-3'} aria-hidden="true" />
            <span>管家</span>
          </span>
        </button>

        <button
          type="button"
          aria-current={activeView === 'kanban' ? 'page' : undefined}
          className={`flex h-8.5 w-full items-center justify-between rounded-lg px-2.5 text-xs transition-colors ${
            activeView === 'kanban'
              ? 'bg-fill-active font-medium text-ink'
              : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
          }`}
          onClick={() => {
            setButlerView('kanban');
            onNavigate?.();
          }}
        >
          <span className="flex items-center gap-2.5">
            <SquareKanban size={15} className={activeView === 'kanban' ? 'text-primary' : 'text-ink-3'} aria-hidden="true" />
            <span>我的工作</span>
          </span>
          {activeCardCount > 0 ? (
            <span className="rounded-full bg-primary-light px-1.5 py-0.5 text-2xs font-semibold text-primary">
              {activeCardCount}
            </span>
          ) : null}
        </button>

        <details className="work-first-more-features" open={moreFeaturesOpen} onToggle={(event) => setMoreFeaturesOpen(event.currentTarget.open)}>
          <summary><MoreHorizontal size={15} aria-hidden="true" /><span>更多功能</span><ChevronRight size={13} aria-hidden="true" /></summary>
          <div className="work-first-secondary-nav">
        <button
          type="button"
          aria-current={activeView === 'assistant' ? 'page' : undefined}
          className={`flex h-8.5 w-full items-center justify-between rounded-lg px-2.5 text-xs transition-colors ${
            activeView === 'assistant'
              ? 'bg-fill-active font-medium text-ink'
              : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
          }`}
          onClick={() => {
            setButlerView('assistant');
            onNavigate?.();
          }}
          title="个人助理晨晚报与长期回顾库"
        >
          <span className="flex items-center gap-2.5">
            <Sparkles size={15} className={activeView === 'assistant' ? 'text-primary' : 'text-ink-3'} aria-hidden="true" />
            <span>简报与记忆</span>
          </span>
        </button>

        <button
          type="button"
          aria-current={activeView === 'acp-hub' ? 'page' : undefined}
          className={`flex h-8.5 w-full items-center justify-between rounded-lg px-2.5 text-xs transition-colors ${
            activeView === 'acp-hub'
              ? 'bg-fill-active font-medium text-ink'
              : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
          }`}
          onClick={() => {
            setButlerView('acp-hub');
            onNavigate?.();
          }}
          title="本地 ACP Agent 客户端控制中心"
        >
          <span className="flex items-center gap-2.5">
            <Cpu size={15} className={activeView === 'acp-hub' ? 'text-primary' : 'text-ink-3'} aria-hidden="true" />
            <span>执行器与会话</span>
          </span>
        </button>

        <div className="my-1 h-px bg-line-soft" />

        <button
          type="button"
          aria-current={activeView === 'routines' ? 'page' : undefined}
          className={`flex h-8.5 w-full items-center justify-between rounded-lg px-2.5 text-xs transition-colors ${
            activeView === 'routines'
              ? 'bg-fill-active font-medium text-ink'
              : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
          }`}
          onClick={() => { setButlerView('routines'); onNavigate?.(); }}
          title="已安排任务"
        >
          <span className="flex items-center gap-2.5">
            <CalendarClock size={15} className={activeView === 'routines' ? 'text-primary' : 'text-ink-3'} aria-hidden="true" />
            <span>已安排</span>
          </span>
        </button>

        <button
          type="button"
          aria-current={activeView === 'plugins' ? 'page' : undefined}
          className={`flex h-8.5 w-full items-center justify-between rounded-lg px-2.5 text-xs transition-colors ${
            activeView === 'plugins'
              ? 'bg-fill-active font-medium text-ink'
              : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
          }`}
          onClick={() => { setButlerView('plugins'); onNavigate?.(); }}
          title="扩展插件"
        >
          <span className="flex items-center gap-2.5">
            <Blocks size={15} className={activeView === 'plugins' ? 'text-primary' : 'text-ink-3'} aria-hidden="true" />
            <span>插件</span>
          </span>
        </button>

        <button
          type="button"
          className="flex h-8.5 w-full items-center justify-between rounded-lg px-2.5 text-xs text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
          onClick={() => {
            setWorkbenchTab('prs');
            setModule('workbench');
            onNavigate?.();
          }}
          title="拉取请求"
        >
          <span className="flex items-center gap-2.5">
            <GitPullRequest size={15} className="text-ink-3" aria-hidden="true" />
            <span>拉取请求</span>
          </span>
        </button>
        <button
          type="button"
          className="flex h-8.5 w-full items-center gap-2.5 rounded-lg px-2.5 text-xs text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
          disabled={!desktopRuntime}
          onClick={() => void chooseWorkspace().catch((reason) => toast.error(reason, '无法添加项目目录'))}
        >
          <FolderOpen size={15} className="text-ink-3" aria-hidden="true" />添加项目目录
        </button>
          </div>
        </details>
      </nav>

      {hostedSessionCount > 0 ? hostedSessionsNavigation : null}

      {visibleProjectEntries.length > 0 ? <div className="butler-codex-thread-heading">
        <span>最近对话与项目</span>
        <button
          type="button"
          aria-label="添加托管项目"
          title="添加托管项目"
          disabled={!desktopRuntime}
          onClick={() => void chooseWorkspace().catch((reason) => toast.error(reason, '无法添加项目目录'))}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div> : null}

      <div className="butler-codex-project-list !max-h-none !min-h-0 !flex-1" aria-label="项目目录">
        {visibleProjectEntries.map((entry, index) => {
          const active = entry.path === workspaceRoot;
          const expanded = active && collapsedWorkspace !== entry.path;
          return (
            <Fragment key={entry.path}>
              {index === firstHostingProjectIndex ? (
                <div className="butler-codex-project-kind" aria-label="工作项目">个人项目</div>
              ) : null}
              <section aria-label={`项目：${entry.label}`} data-workspace-kind={entry.kind}>
                <div className="butler-codex-workspace-row" data-actions={entry.configurable ? '2' : undefined}>
                  <button
                    type="button"
                    className="butler-codex-workspace-picker"
                    data-active={active || undefined}
                    aria-expanded={expanded}
                    onClick={() => void selectWorkspace(entry.path).catch((reason) => toast.error(reason, '无法切换项目目录'))}
                  >
                    <ChevronRight className={expanded ? 'is-expanded' : undefined} size={13} aria-hidden="true" />
                    {active && status === 'connecting'
                      ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <FolderOpen size={14} aria-hidden="true" />}
                    <span title={entry.tooltipPath}>{entry.kind === 'hosting' && !findEnvironmentByPath(environments, entry.path)?.enabled ? `${entry.label}（已停用）` : entry.label}</span>
                    <small>{threadCounts.get(entry.path) ?? 0}</small>
                  </button>
                  {entry.configurable ? (
                    <div className="butler-codex-workspace-actions">
                      <button
                        type="button"
                        aria-label={`项目配置：${entry.label}`}
                        title="项目配置"
                        onClick={() => {
                          setMenuThreadId(null);
                          setWorkspaceToConfigure(entry.path);
                        }}
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`移除项目：${entry.label}`}
                        title={entry.busy ? '活动讨论结束后才能移除项目' : '移除项目'}
                        disabled={entry.busy}
                        onClick={() => {
                          setMenuThreadId(null);
                          setWorkspaceToRemove(entry.path);
                        }}
                      >
                        <FolderMinus size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </div>
                {expanded ? renderThreadHistory() : null}
              </section>
            </Fragment>
          );
        })}
      </div>

      <div className="border-t border-line px-2.5 py-2">
        <button
          type="button"
          onClick={() => {
            setModule('settings');
            onNavigate?.();
          }}
          className="flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left text-xs text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
          title="点击进入设置调整 AI 引擎与模型"
          aria-label="管家设置"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                status === 'ready' || status === 'running' || status === 'waiting-input'
                  ? 'bg-success'
                  : status === 'connecting'
                    ? 'bg-warning animate-pulse'
                    : 'bg-ink-4'
              }`}
            />
            <span className="truncate font-medium text-ink">
              管家设置
              <span className="text-ink-3">
                {' · '}{activeModel?.displayName || selectedModel || '配置模型'}
              </span>
            </span>
          </div>
          <Settings size={13} className="shrink-0 text-ink-3" />
        </button>
      </div>

      {workspaceToRemove ? (
        <ConfirmDialog
          title={`移除项目“${workspaceName(workspaceToRemove)}”？`}
          message={`只会从 RocketX 的项目列表中移除 ${workspaceToRemove}，不会删除磁盘目录或 Codex 会话。若该项目正在运行任务，本机连接会停止。`}
          confirmLabel="移除项目"
          onConfirm={() => {
            const target = workspaceToRemove;
            void removeProject(target)
              .then(() => {
                setCollapsedWorkspace(null);
                toast.success(`已从项目列表移除 ${workspaceName(target)}`);
              })
              .catch((reason) => toast.error(reason, '无法移除项目'));
          }}
          onClose={() => setWorkspaceToRemove(null)}
        />
      ) : null}
      {workspaceToConfigure ? (
        <ButlerProjectConfigDialog
          path={workspaceToConfigure}
          environment={configuredEnvironment}
          busy={configuredEnvironmentBusy}
          onClose={() => setWorkspaceToConfigure(null)}
          onSave={(patch) => {
            try {
              saveProjectConfig(workspaceToConfigure, patch);
              setWorkspaceToConfigure(null);
              toast.success('项目配置已保存');
            } catch (reason) {
              toast.error(reason, '保存项目配置失败');
            }
          }}
        />
      ) : null}
    </aside>
  );
}
