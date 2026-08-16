import { PanelLeft, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { agentBackend } from '../agent/session';
import ButlerConversation from '../components/ButlerConversation';
import ButlerConversationHistory from '../components/ButlerConversationHistory';
import DshConversation from '../components/DshConversation';
import ButlerPluginsPage from '../components/ButlerPluginsPage';
import ButlerRoutines from '../components/ButlerRoutines';
import { getAiRuntimeStartupResolution } from '../lib/aiRuntimeBootstrap';
import { useSharedAgent } from '../stores/sharedAgent';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useUI } from '../stores/ui';

function ManagedSurface({ children }: { children: ReactNode }) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const closeNavigation = useCallback((): void => {
    setNavigationOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!navigationOpen) return;
    requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeNavigation();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [closeNavigation, navigationOpen]);

  return (
    <div className="butler-surface-layout">
      <ButlerConversationHistory />
      <div className="butler-managed-surface">
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
          <div role="dialog" aria-modal="true" aria-label="任务列表" className="butler-conversation-mobile-panel">
            <button
              ref={closeRef}
              type="button"
              aria-label="关闭任务列表"
              className="butler-conversation-mobile-close"
              onClick={closeNavigation}
            >
              <X size={17} aria-hidden="true" />
            </button>
            <div className="h-full" onClickCapture={(event) => {
              if ((event.target as HTMLElement).closest('button')) closeNavigation();
            }}>
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
            ? `已保留 ${unavailableSelection === 'codex' ? 'Codex' : 'DSH'} 选择，本次没有切换到其他引擎。${startupResolution.reason ? ` ${startupResolution.reason}` : ''}`
            : '普通对话暂不可发送；已有托管记录仍可在托管状态里查看和结束。'}
        </p>
      </div>
    </section>
  );
}

/** 固定展示单一原生会话面；provider 只决定具体执行引擎。 */
export default function ButlerPage() {
  const activeView = useUI((state) => state.butlerView);
  const aiRuntimeProvider = useUI((state) => state.aiRuntimeProvider);
  const selectedHostedSessionKey = useUI((state) => state.selectedHostedSessionKey);
  const hostedSessionsByKey = useSharedAgent((state) => state.sessions);
  const setWorkspaceRoot = useCodexWorkspace((state) => state.setWorkspaceRoot);
  const connect = useCodexWorkspace((state) => state.connect);
  const resumeThread = useCodexWorkspace((state) => state.resumeThread);
  const codexRuntime = aiRuntimeProvider === 'codex';
  const focusedHostedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!codexRuntime || activeView !== 'conversation' || !selectedHostedSessionKey) return;
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
    codexRuntime,
    connect,
    hostedSessionsByKey,
    resumeThread,
    selectedHostedSessionKey,
    setWorkspaceRoot,
  ]);

  return (
    <div className="butler-workspace">
      <main className="butler-workspace-stage min-h-0 min-w-0 flex-1 overflow-hidden">
        {aiRuntimeProvider === 'deepseek' ? (
          <DshConversation />
        ) : codexRuntime && activeView === 'routines' ? (
          <ManagedSurface><ButlerRoutines /></ManagedSurface>
        ) : codexRuntime && activeView === 'plugins' ? (
          <ManagedSurface><ButlerPluginsPage /></ManagedSurface>
        ) : aiRuntimeProvider === 'none' ? (
          <ManagedSurface><AiDisabledSurface /></ManagedSurface>
        ) : (
          <section aria-label="任务" className="butler-task-surface">
            <div className="butler-task-content">
              <ButlerConversation embedded />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
