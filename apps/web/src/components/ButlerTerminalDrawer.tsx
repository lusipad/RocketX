import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import {
  Check,
  Copy,
  Eraser,
  MessageSquareQuote,
  Plus,
  RotateCw,
  Square,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { useT } from '../i18n';
import { isTauriRuntime } from '../lib/client';
import {
  killButlerPty,
  resizeButlerPty,
  snapshotButlerPty,
  startButlerPty,
  writeButlerPty,
} from '../platform/desktopCommands';
import { listenButlerPtyExit, listenButlerPtyOutput } from '../platform/desktopEvents';
import { toast } from '../stores/toast';

export interface PtyCommandSpec {
  id: string;
  label: string;
  command: string;
  args?: string[];
}

interface TerminalTabState {
  id: string;
  terminalId: string | null;
  label: string;
  command?: string;
  args?: string[];
  exited: boolean;
  exitCode: number | null;
  error?: string;
}

export interface ButlerTerminalDrawerProps {
  workspaceRoot: string;
  open: boolean;
  onClose: () => void;
  initialCommand?: PtyCommandSpec | null;
  onQuoteSelection?: (selectedText: string) => void;
}

export default function ButlerTerminalDrawer({
  workspaceRoot,
  open,
  onClose,
  initialCommand = null,
  onQuoteSelection,
}: ButlerTerminalDrawerProps) {
  const t = useT();
  const [tabs, setTabs] = useState<TerminalTabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [drawerHeight, setDrawerHeight] = useState(176);
  const hostRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const xtermMapRef = useRef<Map<string, { term: XTerm; fit: FitAddon }>>(new Map());
  const mountedTerminalsRef = useRef<Set<string>>(new Set());
  const terminalToTabRef = useRef<Map<string, string>>(new Map());
  const prevWorkspaceRef = useRef<string>(workspaceRoot);
  const handledCmdIdRef = useRef<string | null>(null);
  const autoSpawnedWorkspaceRef = useRef<string | null>(null);
  const tabCounterRef = useRef(0);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [activeTabId, tabs],
  );

  const createTab = useCallback(async (spec?: PtyCommandSpec | null) => {
    if (!isTauriRuntime() || !workspaceRoot.trim()) return;
    const localId = `pty-tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nextNumber = ++tabCounterRef.current;
    const label = spec?.label || t('agent.terminal.tabLabel', { index: nextNumber });
    const stub: TerminalTabState = {
      id: localId,
      terminalId: null,
      label,
      command: spec?.command,
      args: spec?.args,
      exited: false,
      exitCode: null,
    };
    setTabs((prev) => [...prev, stub]);
    setActiveTabId(localId);

    try {
      const terminalId = await startButlerPty({
        workspaceRoot,
        command: spec?.command ?? null,
        args: spec?.args ?? null,
        cols: 100,
        rows: 18,
      });
      mountedTerminalsRef.current.add(terminalId);
      terminalToTabRef.current.set(terminalId, localId);
      setTabs((prev) =>
        prev.map((tab) => (tab.id === localId ? { ...tab, terminalId } : tab)),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setTabs((prev) =>
        prev.map((tab) => (tab.id === localId ? { ...tab, exited: true, error: msg } : tab)),
      );
    }
  }, [t, tabs.length, workspaceRoot]);

  // Spawn initial interactive shell or handle explicit CLI launch request
  useEffect(() => {
    if (!open || !isTauriRuntime() || !workspaceRoot.trim()) return;
    if (initialCommand && handledCmdIdRef.current !== initialCommand.id) {
      handledCmdIdRef.current = initialCommand.id;
      void createTab(initialCommand);
      return;
    }
    if (tabs.length === 0 && autoSpawnedWorkspaceRef.current !== workspaceRoot) {
      autoSpawnedWorkspaceRef.current = workspaceRoot;
      void createTab(null);
    }
  }, [createTab, initialCommand, open, tabs.length, workspaceRoot]);

  // Subscribe to real-time Tauri PTY output & exit events
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlistenOut: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    void listenButlerPtyOutput((payload) => {
      if (disposed) return;
      const tabId = terminalToTabRef.current.get(payload.terminalId);
      if (!tabId) return;
      const entry = xtermMapRef.current.get(tabId);
      if (entry) {
        entry.term.write(payload.data);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenOut = fn;
    });

    void listenButlerPtyExit((payload) => {
      if (disposed) return;
      const tabId = terminalToTabRef.current.get(payload.terminalId);
      if (!tabId) return;
      setTabs((prev) =>
        prev.map((tab) =>
          tab.terminalId === payload.terminalId
            ? { ...tab, exited: true, exitCode: payload.exitCode }
            : tab,
        ),
      );
    }).then((fn) => {
      if (disposed) fn();
      else unlistenExit = fn;
    });

    return () => {
      disposed = true;
      unlistenOut?.();
      unlistenExit?.();
    };
  }, []);

  // Mount & fit active xterm instance inside drawer host container
  useEffect(() => {
    if (!open || !activeTab || !hostRef.current) return;
    const tabId = activeTab.id;
    const terminalId = activeTab.terminalId;
    const container = hostRef.current;

    let entry = xtermMapRef.current.get(tabId);
    if (!entry) {
      const term = new XTerm({
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorWidth: 2,
        fontSize: 12,
        lineHeight: 1.35,
        scrollback: 5000,
        fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Microsoft YaHei UI", monospace',
        theme: {
          background: '#0e0f14',
          foreground: '#e6e9f0',
          cursor: '#a7aebc',
          selectionBackground: 'rgba(112, 148, 255, 0.26)',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      entry = { term, fit };
      xtermMapRef.current.set(tabId, entry);
      if (activeTab.error) {
        term.writeln(`\x1b[31m${activeTab.error}\x1b[0m`);
      }
    }

    container.replaceChildren();
    if (entry.term.element) {
      container.appendChild(entry.term.element);
    } else {
      entry.term.open(container);
    }
    requestAnimationFrame(() => {
      try {
        entry?.fit.fit();
        if (terminalId) {
          void resizeButlerPty(terminalId, entry.term.cols, entry.term.rows).catch(() => undefined);
        }
      } catch {
        // ignore layout fit during teardown
      }
      entry?.term.focus();
    });

    if (terminalId && entry.term.buffer.active.length <= 1) {
      void snapshotButlerPty(terminalId)
        .then((snap) => {
          if (snap.bufferedOutput && entry && entry.term.buffer.active.length <= 1) {
            entry.term.write(snap.bufferedOutput);
          }
          if (snap.exited) {
            setTabs((prev) =>
              prev.map((tab) =>
                tab.terminalId === terminalId
                  ? { ...tab, exited: true, exitCode: snap.exitCode }
                  : tab,
              ),
            );
          }
        })
        .catch(() => undefined);
    }

    const dataDisposable = entry.term.onData((data) => {
      if (terminalId) {
        void writeButlerPty(terminalId, data).catch(() => undefined);
      }
    });
    const selDisposable = entry.term.onSelectionChange(() => {
      const txt = entry?.term.getSelection().trim() ?? '';
      setSelectedText(txt);
    });

    let resizeTimer: number | null = null;
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          if (resizeTimer !== null) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            try {
              entry?.fit.fit();
              if (terminalId && entry) {
                void resizeButlerPty(terminalId, entry.term.cols, entry.term.rows).catch(() => undefined);
              }
            } catch {
              // ignore resize errors
            }
          }, 50);
        })
      : null;
    observer?.observe(container);

    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      observer?.disconnect();
      dataDisposable.dispose();
      selDisposable.dispose();
      setSelectedText('');
    };
  }, [activeTab?.error, activeTab?.id, activeTab?.terminalId, open]);

  // Dispose all PTYs and xterm instances on unmount
  useEffect(() => {
    const owned = mountedTerminalsRef.current;
    const map = xtermMapRef.current;
    const tabLookup = terminalToTabRef.current;
    return () => {
      for (const termId of owned) {
        void killButlerPty(termId).catch(() => undefined);
      }
      owned.clear();
      tabLookup.clear();
      for (const { term } of map.values()) {
        term.dispose();
      }
      map.clear();
    };
  }, []);

  // Reset and kill PTYs when switching workspace
  useEffect(() => {
    if (prevWorkspaceRef.current === workspaceRoot) return;
    prevWorkspaceRef.current = workspaceRoot;
    const owned = mountedTerminalsRef.current;
    for (const termId of owned) {
      void killButlerPty(termId).catch(() => undefined);
    }
    owned.clear();
    terminalToTabRef.current.clear();
    for (const { term } of xtermMapRef.current.values()) {
      term.dispose();
    }
    xtermMapRef.current.clear();
    handledCmdIdRef.current = null;
    autoSpawnedWorkspaceRef.current = null;
    tabCounterRef.current = 0;
    setSelectedText('');
    setTabs([]);
    setActiveTabId(null);
  }, [workspaceRoot]);

  const startResizeDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragStateRef.current = { startY: event.clientY, startHeight: drawerHeight };
    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const delta = drag.startY - moveEvent.clientY;
      setDrawerHeight(Math.max(128, Math.min(420, drag.startHeight + delta)));
    };
    const onUp = () => {
      dragStateRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [drawerHeight]);

  if (!open) return null;

  const handleCloseTab = async (tab: TerminalTabState) => {
    if (tab.terminalId) {
      mountedTerminalsRef.current.delete(tab.terminalId);
      terminalToTabRef.current.delete(tab.terminalId);
      await killButlerPty(tab.terminalId).catch(() => undefined);
    }
    const inst = xtermMapRef.current.get(tab.id);
    if (inst) {
      inst.term.dispose();
      xtermMapRef.current.delete(tab.id);
    }
    setTabs((prev) => {
      const next = prev.filter((item) => item.id !== tab.id);
      if (activeTabId === tab.id) {
        setActiveTabId(next[0]?.id ?? null);
      }
      return next;
    });
  };

  const handleRestartTab = async (tab: TerminalTabState) => {
    if (tab.terminalId) {
      mountedTerminalsRef.current.delete(tab.terminalId);
      terminalToTabRef.current.delete(tab.terminalId);
      await killButlerPty(tab.terminalId).catch(() => undefined);
    }
    const inst = xtermMapRef.current.get(tab.id);
    inst?.term.clear();
    try {
      const cols = inst?.term.cols ?? 100;
      const rows = inst?.term.rows ?? 18;
      const newId = await startButlerPty({
        workspaceRoot,
        command: tab.command ?? null,
        args: tab.args ?? null,
        cols,
        rows,
      });
      mountedTerminalsRef.current.add(newId);
      terminalToTabRef.current.set(newId, tab.id);
      setTabs((prev) =>
        prev.map((item) =>
          item.id === tab.id
            ? { ...item, terminalId: newId, exited: false, exitCode: null, error: undefined }
            : item,
        ),
      );
      inst?.term.focus();
    } catch (error) {
      toast.error(error, t('agent.terminal.startFailed'));
    }
  };

  const copyActiveSnapshot = async () => {
    if (!activeTab?.terminalId) return;
    try {
      const snap = await snapshotButlerPty(activeTab.terminalId);
      await navigator.clipboard.writeText(snap.bufferedOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <section
      aria-label={t('agent.terminal.drawerAria')}
      className="flex flex-col border-t border-line-strong bg-[#0e0f14] shadow-[inset_0_8px_16px_-12px_rgba(0,0,0,0.75)]"
    >
      {/* Tactile Drag Resize Handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={startResizeDrag}
        className="group flex h-2 cursor-ns-resize items-center justify-center bg-surface-2/95 transition hover:bg-fill-hover"
      >
        <span className="h-[3px] w-9 rounded-full bg-line-strong/80 transition group-hover:bg-ink-3" />
      </div>

      {/* Header & Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/95 px-3 pb-1.5 pt-0.5 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <TerminalIcon size={13} className="shrink-0 text-primary" aria-hidden="true" />
          <div className="flex items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 transition ${
                  tab.id === activeTab?.id
                    ? 'bg-surface-4 text-ink font-medium ring-1 ring-line shadow-[inset_0_-1px_0_var(--color-primary)]'
                    : 'text-ink-3 hover:bg-fill-hover hover:text-ink'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  className="text-xs"
                >
                  {tab.label}
                  {tab.exited ? ` (${tab.exitCode ?? t('agent.terminal.exitedTag')})` : ''}
                </button>
                <button
                  type="button"
                  aria-label={t('agent.terminal.closeTabAria')}
                  onClick={() => void handleCloseTab(tab)}
                  className="rounded p-0.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => void createTab(null)}
              aria-label={t('agent.terminal.newTabAria')}
              title={t('agent.terminal.newTabAria')}
              className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {selectedText && onQuoteSelection ? (
            <button
              type="button"
              onClick={() => {
                onQuoteSelection(selectedText);
                xtermMapRef.current.get(activeTab?.id ?? '')?.term.clearSelection();
                setSelectedText('');
              }}
              className="inline-flex h-6 items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 text-xs font-medium text-primary hover:bg-primary/20"
            >
              <MessageSquareQuote size={12} aria-hidden="true" />
              <span>{t('agent.terminal.quoteSelectionBtn')}</span>
            </button>
          ) : null}
          {activeTab ? (
            <>
              <button
                type="button"
                onClick={() => xtermMapRef.current.get(activeTab.id)?.term.clear()}
                title={t('agent.terminal.clearTitle')}
                aria-label={t('agent.terminal.clearTitle')}
                className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink"
              >
                <Eraser size={12} />
              </button>
              <button
                type="button"
                onClick={() => void copyActiveSnapshot()}
                title={t('agent.terminal.copyTitle')}
                aria-label={t('agent.terminal.copyTitle')}
                className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </button>
              {!activeTab.exited && activeTab.terminalId ? (
                <button
                  type="button"
                  onClick={() => activeTab.terminalId && void killButlerPty(activeTab.terminalId)}
                  title={t('agent.terminal.killTitle')}
                  aria-label={t('agent.terminal.killTitle')}
                  className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-danger/15 hover:text-danger"
                >
                  <Square size={11} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleRestartTab(activeTab)}
                  title={t('agent.terminal.restartTitle')}
                  aria-label={t('agent.terminal.restartTitle')}
                  className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink"
                >
                  <RotateCw size={12} />
                </button>
              )}
            </>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('agent.terminal.hideAria')}
            title={t('agent.terminal.hideAria')}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Real PTY xterm.js Canvas */}
      <div
        ref={hostRef}
        aria-label={t('agent.terminal.ptyCanvasAria')}
        style={{ height: drawerHeight }}
        className="w-full overflow-hidden bg-[#0e0f14] px-3.5 py-2"
      />
    </section>
  );
}
