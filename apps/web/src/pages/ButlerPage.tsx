import { PanelLeft, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ButlerConversation from '../components/ButlerConversation';
import ButlerConversationHistory from '../components/ButlerConversationHistory';
import ButlerPluginsPage from '../components/ButlerPluginsPage';
import ButlerRoutines from '../components/ButlerRoutines';
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

/** Codex 式三工作面：任务、已安排、插件。其余能力留在任务上下文中。 */
export default function ButlerPage() {
  const activeView = useUI((state) => state.butlerView);

  return (
    <div className="butler-workspace">
      <main className="butler-workspace-stage min-h-0 min-w-0 flex-1 overflow-hidden">
        {activeView === 'routines' ? (
          <ManagedSurface><ButlerRoutines /></ManagedSurface>
        ) : activeView === 'plugins' ? (
          <ManagedSurface><ButlerPluginsPage /></ManagedSurface>
        ) : (
          <section aria-label="任务" className="h-full min-h-0">
            <ButlerConversation embedded />
          </section>
        )}
      </main>
    </div>
  );
}
