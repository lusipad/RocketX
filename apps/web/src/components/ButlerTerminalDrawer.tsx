import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  Copy,
  Eraser,
  Plus,
  RotateCw,
  Square,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { useT } from '../i18n';
import { isTauriRuntime } from '../lib/client';
import { stripAnsiSequences } from '../lib/composerCommands';
import {
  killButlerTerminal,
  readButlerTerminalOutput,
  releaseButlerTerminal,
  startButlerTerminal,
  writeButlerTerminal,
} from '../platform/desktopCommands';
import { toast } from '../stores/toast';

interface TerminalTabState {
  id: string;
  terminalId: string | null;
  label: string;
  output: string;
  clearOffset: number;
  exited: boolean;
  exitCode: number | null;
  history: string[];
  historyIndex: number;
  error?: string;
}

export interface ButlerTerminalDrawerProps {
  workspaceRoot: string;
  open: boolean;
  onClose: () => void;
}

export default function ButlerTerminalDrawer({
  workspaceRoot,
  open,
  onClose,
}: ButlerTerminalDrawerProps) {
  const t = useT();
  const [tabs, setTabs] = useState<TerminalTabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedTerminalsRef = useRef<Set<string>>(new Set());
  const prevWorkspaceRef = useRef<string>(workspaceRoot);

  const createTab = useCallback(async () => {
    if (!isTauriRuntime() || !workspaceRoot.trim()) return;
    const localId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nextNumber = tabs.length + 1;
    const stub: TerminalTabState = {
      id: localId,
      terminalId: null,
      label: t('agent.terminal.tabLabel', { index: nextNumber }),
      output: '',
      clearOffset: 0,
      exited: false,
      exitCode: null,
      history: [],
      historyIndex: -1,
    };
    setTabs((prev) => [...prev, stub]);
    setActiveTabId(localId);

    try {
      const terminalId = await startButlerTerminal({ workspaceRoot });
      mountedTerminalsRef.current.add(terminalId);
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

  // Spawn initial shell when first opened for a workspace
  useEffect(() => {
    if (!open || !isTauriRuntime() || !workspaceRoot.trim()) return;
    if (tabs.length === 0) {
      void createTab();
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [createTab, open, tabs.length, workspaceRoot]);

  // Release any live terminals when component unmounts
  useEffect(() => {
    const owned = mountedTerminalsRef.current;
    return () => {
      for (const termId of owned) {
        void releaseButlerTerminal(termId).catch(() => undefined);
      }
      owned.clear();
    };
  }, []);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [activeTabId, tabs],
  );

  // Poll output of open active terminal
  useEffect(() => {
    if (!open || !activeTab?.terminalId || activeTab.exited) return;
    const termId = activeTab.terminalId;
    const tabId = activeTab.id;
    let cancelled = false;

    const poll = async () => {
      try {
        const snap = await readButlerTerminalOutput(termId);
        if (cancelled) return;
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  output: snap.output,
                  exited: snap.exitStatus !== null,
                  exitCode: snap.exitStatus?.exitCode ?? null,
                }
              : tab,
          ),
        );
      } catch {
        // Ignore transient poll errors on close
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTab?.exited, activeTab?.id, activeTab?.terminalId, open]);

  // Auto-scroll to bottom when output grows
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeTab?.output]);

  // Reset and release terminals when switching workspace
  useEffect(() => {
    if (prevWorkspaceRef.current === workspaceRoot) return;
    prevWorkspaceRef.current = workspaceRoot;
    const owned = mountedTerminalsRef.current;
    for (const termId of owned) {
      void releaseButlerTerminal(termId).catch(() => undefined);
    }
    owned.clear();
    setTabs([]);
    setActiveTabId(null);
    setCommandInput('');
  }, [workspaceRoot]);

  const visibleOutput = useMemo(() => {
    if (!activeTab) return '';
    const slice = activeTab.clearOffset > 0 && activeTab.output.length >= activeTab.clearOffset
      ? activeTab.output.slice(activeTab.clearOffset)
      : activeTab.output;
    return stripAnsiSequences(slice);
  }, [activeTab]);

  if (!open) return null;

  const handleCloseTab = async (tab: TerminalTabState) => {
    if (tab.terminalId) {
      mountedTerminalsRef.current.delete(tab.terminalId);
      await releaseButlerTerminal(tab.terminalId).catch(() => undefined);
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
      await releaseButlerTerminal(tab.terminalId).catch(() => undefined);
    }
    try {
      const newId = await startButlerTerminal({ workspaceRoot });
      mountedTerminalsRef.current.add(newId);
      setTabs((prev) =>
        prev.map((item) =>
          item.id === tab.id
            ? { ...item, terminalId: newId, output: '', clearOffset: 0, exited: false, exitCode: null, error: undefined }
            : item,
        ),
      );
      inputRef.current?.focus();
    } catch (error) {
      toast.error(error, t('agent.terminal.startFailed'));
    }
  };

  const sendLine = async (rawCommand: string) => {
    if (!activeTab?.terminalId || activeTab.exited) return;
    const trimmed = rawCommand.replace(/\r?\n$/, '');
    try {
      await writeButlerTerminal(activeTab.terminalId, `${trimmed}\n`);
      if (trimmed.trim()) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === activeTab.id
              ? {
                  ...tab,
                  history: [...tab.history.slice(-49), trimmed],
                  historyIndex: -1,
                }
              : tab,
          ),
        );
      }
      setCommandInput('');
    } catch (error) {
      toast.error(error, t('agent.terminal.writeFailed'));
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!activeTab) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      setTabs((prev) =>
        prev.map((item) =>
          item.id === activeTab.id ? { ...item, clearOffset: item.output.length } : item,
        ),
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendLine(commandInput);
      return;
    }
    if (event.key === 'ArrowUp' && activeTab.history.length > 0) {
      event.preventDefault();
      const nextIndex = activeTab.historyIndex < 0
        ? activeTab.history.length - 1
        : Math.max(0, activeTab.historyIndex - 1);
      setCommandInput(activeTab.history[nextIndex] ?? '');
      setTabs((prev) => prev.map((tItem) => (tItem.id === activeTab.id ? { ...tItem, historyIndex: nextIndex } : tItem)));
      return;
    }
    if (event.key === 'ArrowDown' && activeTab.historyIndex >= 0) {
      event.preventDefault();
      const nextIndex = activeTab.historyIndex + 1;
      if (nextIndex >= activeTab.history.length) {
        setCommandInput('');
        setTabs((prev) => prev.map((tItem) => (tItem.id === activeTab.id ? { ...tItem, historyIndex: -1 } : tItem)));
      } else {
        setCommandInput(activeTab.history[nextIndex] ?? '');
        setTabs((prev) => prev.map((tItem) => (tItem.id === activeTab.id ? { ...tItem, historyIndex: nextIndex } : tItem)));
      }
    }
  };

  return (
    <section
      aria-label={t('agent.terminal.drawerAria')}
      className="flex flex-col border-t border-line bg-surface-2"
    >
      {/* Header & Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-3 px-3 py-1.5 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <TerminalIcon size={13} className="shrink-0 text-primary" aria-hidden="true" />
          <div className="flex items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 transition ${tab.id === activeTab?.id ? 'bg-surface-4 text-ink font-medium ring-1 ring-line' : 'text-ink-3 hover:text-ink'}`}
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
              onClick={() => void createTab()}
              aria-label={t('agent.terminal.newTabAria')}
              title={t('agent.terminal.newTabAria')}
              className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {activeTab ? (
            <>
              <button
                type="button"
                onClick={() =>
                  setTabs((prev) =>
                    prev.map((item) =>
                      item.id === activeTab.id ? { ...item, clearOffset: item.output.length } : item,
                    ),
                  )
                }
                title={t('agent.terminal.clearTitle')}
                aria-label={t('agent.terminal.clearTitle')}
                className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink"
              >
                <Eraser size={12} />
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(visibleOutput).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  });
                }}
                title={t('agent.terminal.copyTitle')}
                aria-label={t('agent.terminal.copyTitle')}
                className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </button>
              {!activeTab.exited && activeTab.terminalId ? (
                <button
                  type="button"
                  onClick={() => activeTab.terminalId && void killButlerTerminal(activeTab.terminalId)}
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

      {/* Output Area */}
      <pre
        ref={outputRef}
        className="h-44 overflow-y-auto whitespace-pre-wrap break-all bg-surface px-3 py-2 font-mono text-xs leading-5 text-ink-2 select-text"
      >
        {activeTab?.error
          ? activeTab.error
          : visibleOutput || t('agent.terminal.emptyPlaceholder', { root: workspaceRoot })}
      </pre>

      {/* Command Input Row */}
      <div className="flex items-center gap-2 border-t border-line bg-surface-3 px-3 py-1.5 text-xs">
        <span className="shrink-0 font-mono text-primary" aria-hidden="true">$</span>
        <input
          ref={inputRef}
          type="text"
          disabled={!activeTab?.terminalId || activeTab.exited}
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={
            activeTab?.exited
              ? t('agent.terminal.exitedPlaceholder')
              : t('agent.terminal.inputPlaceholder')
          }
          aria-label={t('agent.terminal.inputAria')}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-3"
        />
      </div>
    </section>
  );
}
