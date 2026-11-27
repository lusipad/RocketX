import { FileCode2, Loader2, Sparkles, Terminal } from 'lucide-react';
import { useT } from '../i18n';
import type { RankedSlashOption } from '../lib/composerCommands';

export interface ButlerComposerFilePopoverProps {
  open: boolean;
  loading: boolean;
  files: string[];
  activeIndex: number;
  onSelect: (filePath: string) => void;
}

export function ButlerComposerFilePopover({
  open,
  loading,
  files,
  activeIndex,
  onSelect,
}: ButlerComposerFilePopoverProps) {
  const t = useT();
  if (!open) return null;

  return (
    <div
      role="listbox"
      aria-label={t('agent.composer.filePickerAria')}
      className="mb-2 max-h-56 overflow-y-auto rounded-xl border border-line bg-surface-3 p-1.5 shadow-card"
    >
      <div className="flex items-center justify-between px-2 py-1 text-xs text-ink-3">
        <span>{t('agent.composer.filePickerHeading')}</span>
        {loading ? <Loader2 size={12} className="animate-spin" /> : null}
      </div>
      {files.length === 0 && !loading ? (
        <p className="px-2 py-2 text-xs text-ink-3">{t('agent.composer.filePickerEmpty')}</p>
      ) : (
        files.map((filePath, idx) => (
          <button
            key={filePath}
            ref={(el) => {
              if (idx === activeIndex && el) el.scrollIntoView({ block: 'nearest' });
            }}
            type="button"
            role="option"
            aria-selected={idx === activeIndex}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(filePath);
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
              idx === activeIndex
                ? 'bg-primary/15 text-ink'
                : 'text-ink-2 hover:bg-fill-hover'
            }`}
          >
            <FileCode2 size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-mono">{filePath}</span>
          </button>
        ))
      )}
    </div>
  );
}

export interface ButlerComposerSlashPopoverProps {
  open: boolean;
  commands: RankedSlashOption[];
  activeIndex: number;
  onSelect: (command: RankedSlashOption) => void;
}

export function ButlerComposerSlashPopover({
  open,
  commands,
  activeIndex,
  onSelect,
}: ButlerComposerSlashPopoverProps) {
  const t = useT();
  if (!open || commands.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label={t('agent.composer.slashPickerAria')}
      className="mb-2 max-h-56 overflow-y-auto rounded-xl border border-line bg-surface-3 p-1.5 shadow-card"
    >
      <div className="px-2 py-1 text-xs text-ink-3">{t('agent.composer.slashPickerHeading')}</div>
      {commands.map((item, idx) => (
        <button
          key={item.id}
          ref={(el) => {
            if (idx === activeIndex && el) el.scrollIntoView({ block: 'nearest' });
          }}
          type="button"
          role="option"
          aria-selected={idx === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item);
          }}
          className={`flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-xs transition ${
            idx === activeIndex
              ? 'bg-primary/15 text-ink'
              : 'text-ink-2 hover:bg-fill-hover'
          }`}
        >
          <span className="inline-flex min-w-0 items-center gap-2">
            {item.kind === 'skill' ? (
              <Sparkles size={13} className="shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <Terminal size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
            )}
            <span className="font-mono font-medium text-ink">/{item.command}</span>
            <span className="truncate text-ink-2">{item.title}</span>
            {item.kind === 'skill' && item.category ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                {item.category}{typeof item.runCount === 'number' && item.runCount > 0 ? ` · ${item.runCount}` : ''}
              </span>
            ) : null}
          </span>
          <span className="hidden truncate text-xs text-ink-3 sm:inline">{item.description}</span>
        </button>
      ))}
    </div>
  );
}
