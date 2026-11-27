import Dialog from './Dialog';
import { useT, type MessageKey } from '../i18n';
import { isTauri } from '../lib/http';
import { GLOBAL_SHORTCUT_OPTIONS } from '../lib/globalShortcut';
import { useGlobalShortcut } from '../stores/globalShortcut';

const SHORTCUTS: readonly [string, MessageKey][] = [
  ['Ctrl + K', 'nav.shortcuts.cmdK'],
  ['Ctrl + Shift + F', 'nav.shortcuts.cmdShiftF'],
  ['Ctrl + ↑ / ↓', 'nav.shortcuts.cmdArrows'],
  ['Ctrl + Shift + ↓', 'nav.shortcuts.cmdShiftDown'],
  ['Alt + ↑ / ↓', 'nav.shortcuts.altArrows'],
  ['Alt + 1…6', 'nav.shortcuts.altNumbers'],
  ['Ctrl + /', 'nav.shortcuts.cmdSlash'],
  ['Ctrl + J', 'nav.shortcuts.butlerTerminal'],
  ['Ctrl + D', 'nav.shortcuts.butlerDiff'],
  ['Ctrl + Shift + N', 'nav.shortcuts.butlerNewThread'],
  ['Ctrl + Shift + W', 'nav.shortcuts.butlerWorktree'],
  ['Esc', 'nav.shortcuts.esc'],
];

export default function ShortcutHelpDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const config = useGlobalShortcut((state) => state.config);
  const windowsDesktop =
    isTauri && typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  const globalLabel = GLOBAL_SHORTCUT_OPTIONS.find(
    (option) => option.value === config.shortcut,
  )?.label;
  const shortcuts: readonly [string, string][] = [
    ...(windowsDesktop && config.enabled && globalLabel
      ? [[globalLabel, t('nav.shortcuts.globalCommandCenter')] as [string, string]]
      : []),
    ...SHORTCUTS.map(([keys, descKey]) => [keys, t(descKey)] as [string, string]),
  ];

  return (
    <Dialog title={t('nav.shortcuts.title')} hint={t('nav.shortcuts.hint')} onClose={onClose}>
      <div className="space-y-1 px-5 pt-2 pb-5">
        {shortcuts.map(([keys, description]) => (
          <div key={keys} className="flex items-center justify-between gap-6 rounded-lg px-2 py-2 hover:bg-fill-1">
            <span className="text-sm text-ink-2">{description}</span>
            <kbd className="shrink-0 rounded border border-line bg-fill-1 px-2 py-1 text-xs text-ink">
              {keys}
            </kbd>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
