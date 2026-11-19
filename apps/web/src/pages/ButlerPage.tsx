import { ArrowLeft, PanelLeft, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { agentBackend } from '../agent/session';
import AcpWorkspaceSurface from '../components/AcpWorkspaceSurface';
import ButlerAssistantCenter from '../components/ButlerAssistantCenter';
import ButlerConversation from '../components/ButlerConversation';
import ButlerConversationBrief, { type ConversationWorkTarget } from '../components/ButlerConversationBrief';
import ButlerConversationHistory from '../components/ButlerConversationHistory';
import ButlerPluginsPage from '../components/ButlerPluginsPage';
import ButlerRoutines from '../components/ButlerRoutines';
import WorkKanbanBoard from '../components/WorkKanbanBoard';
import { getAiRuntimeStartupResolution } from '../lib/aiRuntimeBootstrap';
import { useSharedAgent } from '../stores/sharedAgent';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useUI } from '../stores/ui';
import { useAuth } from '../stores/auth';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { subscribeButlerAccountSelection } from '../platform/butlerAccountReady';

function ManagedSurface({ children }: { children: ReactNode }) {
  const activeView = useUI((state) => state.butlerView);
  const butlerSidebarCollapsed = useUI((state) => state.butlerSidebarCollapsed);
  const toggleButlerSidebarCollapsed = useUI((state) => state.toggleButlerSidebarCollapsed);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const closeNavigation = useCallback((): void => {
    setNavigationOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!navigationOpen) return;
    requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeNavigation();
      } else if (event.key === 'Tab') {
        const visible = [...(drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, a[href]') ?? [])].filter(el => el.getClientRects().length);
        if (event.shiftKey && document.activeElement === visible[0]) { event.preventDefault(); visible.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === visible.at(-1)) { event.preventDefault(); visible[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [closeNavigation, navigationOpen]);

  return (
    <div className={`butler-surface-layout${activeView === 'acp-hub' ? ' is-executor-workspace' : ''}${activeView === 'kanban' ? ' is-work-board' : ''}${butlerSidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      {!butlerSidebarCollapsed ? <ButlerConversationHistory /> : null}
      <div className="butler-managed-surface">
        {butlerSidebarCollapsed && (activeView === 'routines' || activeView === 'plugins') ? (
          <button
            type="button"
            onClick={toggleButlerSidebarCollapsed}
            title="展开会话列表 (Ctrl+B)"
            aria-label="展开会话列表"
            className="hidden lg:flex absolute left-3 top-2.5 z-20 h-7 w-7 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            <PanelLeft size={16} />
          </button>
        ) : null}
        <div className={activeView === 'kanban' ? 'butler-board-switcher' : undefined}>
        {activeView === 'kanban' && <button type="button" onClick={() => useUI.getState().setButlerView('conversation')} className="butler-board-return">
          <ArrowLeft size={15} aria-hidden="true" />返回管家
        </button>}
        <button
          ref={triggerRef}
          type="button"
          aria-label="打开任务列表"
          aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen(true)}
          className="butler-surface-mobile-nav"
        >
          <PanelLeft size={16} aria-hidden="true" />
          任务列表
        </button>
        </div>
        {children}
      </div>
      {navigationOpen ? (
        <div className="butler-conversation-mobile-drawer">
          <button
            type="button"
            tabIndex={-1}
            aria-label="关闭任务列表"
            className="butler-conversation-mobile-backdrop"
            onClick={closeNavigation}
          />
          <div ref={drawerRef} role="dialog" aria-modal="true" aria-label="任务列表" className="butler-conversation-mobile-panel">
            <button
              ref={closeRef}
              type="button"
              aria-label="关闭任务列表"
              className="butler-conversation-mobile-close"
              onClick={closeNavigation}
            >
              <X size={17} aria-hidden="true" />
            </button>
            <div className="h-full">
              <ButlerConversationHistory onNavigate={closeNavigation} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AiDisabledSurface() {
  const startupResolution = getAiRuntimeStartupResolution();
  const unavailableSelection = startupResolution.source === 'explicit-unavailable'
    ? startupResolution.configured
    : undefined;
  return (
    <section className="flex h-full items-center justify-center bg-surface" aria-label="普通对话">
      <div className="max-w-sm rounded-xl border border-line bg-surface-3 p-6 text-center">
        <div className="text-sm font-medium text-ink">
          {unavailableSelection ? '所选 AI 执行引擎当前不可用' : '当前未启用 AI 执行引擎'}
        </div>
        <p className="mt-2 text-xs leading-5 text-ink-3">
          {unavailableSelection
            ? `已保留 Pi 选择，本次没有切换到其他引擎。${startupResolution.reason ? ` ${startupResolution.reason}` : ''}`
            : '普通对话暂不可发送；已有托管记录仍可在托管状态里查看和结束。'}</p><div className="mt-4 flex flex-wrap items-center justify-center gap-2"><button type="button" onClick={() => useUI.getState().setModule('settings')} className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-white transition hover:bg-primary-hover">前往设置配置引擎</button><button type="button" onClick={() => useUI.getState().setButlerView('kanban')} className="h-8 rounded-md border border-line bg-surface-2 px-3 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-ink">打开统一看板</button></div><p className="hidden">
        </p>
      </div>
    </section>
  );
}

/** 固定展示单一原生会话面；provider 只决定具体执行引擎。 */
export default function ButlerPage() {
  const activeView = useUI((state) => state.butlerView);
  const scope = useAuth(() => resolveButlerAccountScope());
  const [initialWork, setInitialWork] = useState<(ConversationWorkTarget & { scope: string }) | null>(null);
  useEffect(() => { if (activeView !== 'kanban') setInitialWork(null); }, [activeView]);
  useEffect(() => subscribeButlerAccountSelection(() => setInitialWork(null)), []);
  const workBrief = <ButlerConversationBrief onOpen={work => {
    if (scope !== resolveButlerAccountScope()) return;
    setInitialWork({ ...work, scope });
    useUI.getState().setButlerView('kanban');
  }} />;
  const aiRuntimeProvider = useUI((state) => state.aiRuntimeProvider);
  const selectedHostedSessionKey = useUI((state) => state.selectedHostedSessionKey);
  const hostedSessionsByKey = useSharedAgent((state) => state.sessions);
  const setWorkspaceRoot = useCodexWorkspace((state) => state.setWorkspaceRoot);
  const connect = useCodexWorkspace((state) => state.connect);
  const resumeThread = useCodexWorkspace((state) => state.resumeThread);
  const piRuntime = aiRuntimeProvider === 'pi';
  const nativeButlerRuntime = piRuntime;
  const focusedHostedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!nativeButlerRuntime || activeView !== 'conversation' || !selectedHostedSessionKey) return;
    const session = hostedSessionsByKey[selectedHostedSessionKey];
    if (!session || agentBackend(session) !== 'codex') return;
    const workspaceRoot = session.workspaceRoots[0];
    if (!workspaceRoot || !session.codexThreadId) return;
    const focusKey = `${selectedHostedSessionKey}\u0000${workspaceRoot}\u0000${session.codexThreadId}`;
    if (focusedHostedSessionRef.current === focusKey) return;
    focusedHostedSessionRef.current = focusKey;
    void (async () => {
      try {
        await setWorkspaceRoot(workspaceRoot);
        await connect({ refreshThreads: false });
        await resumeThread(session.codexThreadId!);
      } catch {
        if (focusedHostedSessionRef.current === focusKey) focusedHostedSessionRef.current = null;
      }
    })();
  }, [
    activeView,
    nativeButlerRuntime,
    connect,
    hostedSessionsByKey,
    resumeThread,
    selectedHostedSessionKey,
    setWorkspaceRoot,
  ]);

  return (
    <div className="butler-workspace">
      <main className="butler-workspace-stage min-h-0 min-w-0 flex-1 overflow-hidden">
        {activeView === 'kanban' ? (
          <ManagedSurface><WorkKanbanBoard initialWork={initialWork?.scope === scope ? initialWork : null} /></ManagedSurface>
        ) : activeView === 'assistant' ? (
          <ManagedSurface><ButlerAssistantCenter /></ManagedSurface>
        ) : activeView === 'acp-hub' ? (
          <ManagedSurface><AcpWorkspaceSurface /></ManagedSurface>
        ) : piRuntime && activeView === 'routines' ? (
          <ManagedSurface><ButlerRoutines /></ManagedSurface>
        ) : piRuntime && activeView === 'plugins' ? (
          <ManagedSurface><ButlerPluginsPage /></ManagedSurface>
        ) : aiRuntimeProvider === 'none' ? (
          <ManagedSurface>{workBrief}<AiDisabledSurface /></ManagedSurface>
        ) : (
          <section aria-label="任务" className="butler-task-surface">
            <div className="butler-task-content">
              <ButlerConversation embedded workBrief={workBrief} />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
