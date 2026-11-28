import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Lock,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import { useT } from '../i18n';
import {
  diffExternalWorkspacePulse,
  type DetectedExternalTool,
  type ExternalPulseDiff,
  type ExternalWorkspacePulse,
} from '../lib/externalContinuation';
import {
  detectExternalTools,
  openInExternalTool,
  pollWorkspaceExternalPulse,
} from '../platform/desktopCommands';
import { toast } from '../stores/toast';

export interface ExternalOpenMenuProps {
  workspaceRoot: string;
  provider?: string | null;
  sessionId?: string | null;
  disabled?: boolean;
  onOpenInPty?: () => void;
  onOpenInCodexApp?: () => void;
  codexAppLabel?: string;
}

export function ExternalOpenMenu({
  workspaceRoot,
  provider,
  sessionId,
  disabled = false,
  onOpenInPty,
  onOpenInCodexApp,
  codexAppLabel,
}: ExternalOpenMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<DetectedExternalTool[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void detectExternalTools()
      .then((list) => {
        if (!cancelled) setTools(list);
      })
      .catch(() => undefined);

    const onMouseDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!workspaceRoot.trim()) return null;

  const canResumeExternalCli = Boolean(
    sessionId?.trim() && ['claude', 'claude-code', 'codex', 'codex-acp', 'pi'].includes((provider ?? '').toLowerCase()),
  );

  const launch = async (toolId: string) => {
    setOpen(false);
    try {
      await openInExternalTool({
        toolId,
        workspaceRoot,
        provider: provider ?? null,
        sessionId: sessionId ?? null,
      });
    } catch (error) {
      toast.error(error, t('agent.external.openFailed'));
    }
  };

  return (
    <div ref={menuRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface-4/70 px-2.5 text-xs text-ink-2 transition hover:border-line-hover hover:bg-surface-4 hover:text-ink aria-expanded:border-line-hover aria-expanded:bg-surface-4 aria-expanded:text-ink disabled:opacity-50"
      >
        <ExternalLink size={13} aria-hidden="true" />
        <span>{t('agent.external.openMenuLabel')}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1.5 w-56 rounded-xl border border-line bg-surface-4 p-1.5 text-xs shadow-xl"
        >
          {onOpenInPty ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenInPty();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink transition hover:bg-fill-hover"
            >
              <Terminal size={13} className="shrink-0 text-ink-3" />
              <span className="truncate">{t('agent.external.openInPtyAction')}</span>
            </button>
          ) : null}

          {canResumeExternalCli ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => void launch('external_cli_resume')}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink transition hover:bg-fill-hover"
            >
              <ExternalLink size={13} className="shrink-0 text-ink-3" />
              <span className="truncate">{t('agent.external.resumeInExternalCliAction')}</span>
            </button>
          ) : null}

          {onOpenInCodexApp ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenInCodexApp();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink transition hover:bg-fill-hover"
            >
              <ExternalLink size={13} className="shrink-0 text-ink-3" />
              <span className="truncate">{codexAppLabel || t('agent.external.openInCodexAppAction')}</span>
            </button>
          ) : null}

          {tools.filter((item) => item.available).length > 0 ? (
            <div className="my-1 border-t border-line" />
          ) : null}

          {tools
            .filter((item) => item.available)
            .map((tool) => (
              <button
                key={tool.id}
                type="button"
                role="menuitem"
                onClick={() => void launch(tool.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink-2 transition hover:bg-fill-hover hover:text-ink"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FolderOpen size={13} className="shrink-0 text-ink-3" />
                  <span className="truncate">{tool.label}</span>
                </span>
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}

export interface ExternalContinuationBannerProps {
  workspaceRoot: string;
  provider?: string | null;
  sessionId?: string | null;
  knownMessageIds?: string[];
  forceExternalMode?: boolean;
  onTakeOver?: (pulse: ExternalWorkspacePulse) => Promise<void> | void;
  onComposerLockChange?: (locked: boolean, reason: string | null) => void;
}

export function ExternalContinuationBanner({
  workspaceRoot,
  provider,
  sessionId,
  knownMessageIds = [],
  forceExternalMode = false,
  onTakeOver,
  onComposerLockChange,
}: ExternalContinuationBannerProps) {
  const t = useT();
  const [pulse, setPulse] = useState<ExternalWorkspacePulse | null>(null);
  const [takingOver, setTakingOver] = useState(false);
  const baselineFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    baselineFingerprintRef.current = null;
    setPulse(null);
  }, [workspaceRoot, sessionId]);

  useEffect(() => {
    if (!workspaceRoot.trim()) return;
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      try {
        const next = await pollWorkspaceExternalPulse({
          workspaceRoot,
          provider: provider ?? null,
          sessionId: sessionId ?? null,
          messageLimit: 16,
        });
        if (cancelled) return;
        if (baselineFingerprintRef.current === null && next.gitSnapshot?.contentFingerprint) {
          baselineFingerprintRef.current = next.gitSnapshot.contentFingerprint;
        }
        setPulse(next);
      } catch {
        // Silent background probe failure; do not interrupt conversation
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void tick(), 3_000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [provider, sessionId, workspaceRoot]);

  const diff: ExternalPulseDiff = useMemo(
    () =>
      diffExternalWorkspacePulse(
        {
          gitFingerprint: baselineFingerprintRef.current,
          knownMessageIds,
        },
        pulse,
      ),
    [knownMessageIds, pulse],
  );

  useEffect(() => {
    onComposerLockChange?.(diff.lockComposer, diff.writerHint);
  }, [diff.lockComposer, diff.writerHint, onComposerLockChange]);

  const visible =
    forceExternalMode ||
    diff.externalWriterActive ||
    diff.gitChangedSinceBaseline ||
    diff.newExternalMessages.length > 0;

  if (!visible || !pulse) return null;

  const handleTakeOver = async () => {
    if (takingOver) return;
    setTakingOver(true);
    try {
      await onTakeOver?.(pulse);
      baselineFingerprintRef.current = pulse.gitSnapshot?.contentFingerprint ?? null;
    } finally {
      setTakingOver(false);
    }
  };

  return (
    <div
      role="status"
      className="mx-auto mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-3 px-3.5 py-2 text-xs text-ink-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5 font-medium text-ink">
          {diff.externalWriterActive ? (
            <Lock size={13} className="shrink-0 text-warning" aria-hidden="true" />
          ) : (
            <GitBranch size={13} className="shrink-0 text-primary" aria-hidden="true" />
          )}
          <span className="truncate">
            {diff.externalWriterActive
              ? diff.writerHint || t('agent.external.writerActiveTitle')
              : forceExternalMode
                ? t('agent.external.externalModeTitle')
                : t('agent.external.workspaceUpdatedTitle')}
          </span>
          {diff.dirtyCount > 0 || diff.unpushedCount > 0 ? (
            <span className="shrink-0 rounded bg-fill-2 px-1.5 py-0.5 font-mono text-ink-3">
              {t('agent.external.gitSummaryChip', {
                dirty: diff.dirtyCount,
                unpushed: diff.unpushedCount,
              })}
            </span>
          ) : null}
        </div>
        {diff.latestMessagePreview ? (
          <div className="line-clamp-1 text-ink-3">
            {t('agent.external.mirroredReplyPreview', { text: diff.latestMessagePreview })}
          </div>
        ) : null}
      </div>

      {onTakeOver ? (
        <button
          type="button"
          disabled={takingOver || diff.externalWriterActive}
          title={diff.externalWriterActive ? t('agent.external.takeOverDisabledWhileWriting') : undefined}
          onClick={() => void handleTakeOver()}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-line bg-surface-4 px-2.5 text-xs font-medium text-ink transition hover:bg-fill-hover disabled:opacity-50"
        >
          <RefreshCw size={12} className={takingOver ? 'animate-spin' : ''} aria-hidden="true" />
          <span>{t('agent.external.takeOverBtn')}</span>
        </button>
      ) : null}
    </div>
  );
}
