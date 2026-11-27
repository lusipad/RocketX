import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import { formatDateTime } from '../i18n/format';
import { parseWorkSessionProviderMeta, workSessionImportIdentity } from '../agent/superAgentBridge';
import { acpLocalSessionMessages, type LocalSessionMessage, type NativeWorkSessionRecord } from '../platform/desktopCommands';
import { useAuth } from '../stores/auth';
import { resolveButlerAccountScope } from '../stores/butlerMemory';

export default function WorkSessionHistoryPreview({ session, onClose }: {
  session: NativeWorkSessionRecord;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const accountScope = useAuth(() => resolveButlerAccountScope());
  const owner = useRef(accountScope);
  const accountChanged = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<LocalSessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const meta = parseWorkSessionProviderMeta(session);
  const identity = workSessionImportIdentity(session, accountScope);
  const [loadedIdentity, setLoadedIdentity] = useState(identity);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === 'Tab' && !dialog.current?.contains(document.activeElement)) {
        event.preventDefault(); dialog.current?.querySelector<HTMLElement>('button')?.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    const unsubscribe = useAuth.subscribe(() => {
      if (resolveButlerAccountScope() !== owner.current) { accountChanged.current = true; setMessages([]); close.current(); }
    });
    return () => { unsubscribe(); document.removeEventListener('keydown', handleKey, true); if (trigger?.isConnected) trigger.focus(); };
  }, []);

  useEffect(() => {
    let current = true;
    setMessages([]); setError(null); setLoadedIdentity(identity);
    if (owner.current !== accountScope) { setLoading(false); onClose(); return; }
    if (session.accountScope && session.accountScope !== accountScope) {
      setLoading(false); setError(t('agent.sessionPreview.wrongAccount')); return;
    }
    setLoading(true);
    void acpLocalSessionMessages({ provider: meta.provider, sessionId: session.nativeSessionId,
      sourcePath: meta.sourcePath, sourceScope: session.sourceScope, limit: 24 }).then((result) => {
      if (current && !accountChanged.current && resolveButlerAccountScope() === owner.current) setMessages(result);
    }).catch((cause) => {
      if (current && !accountChanged.current && resolveButlerAccountScope() === owner.current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (current && !accountChanged.current && resolveButlerAccountScope() === owner.current) setLoading(false); });
    return () => { current = false; };
  }, [identity, attempt, accountScope]);

  if (owner.current !== accountScope) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-6" onClick={onClose}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t('agent.sessionPreview.dialogLabel')} tabIndex={-1}
      className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-line bg-surface-1 shadow-2xl outline-none"
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const targets = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? [])];
        const first = targets[0]; const last = targets.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="flex items-start gap-3 border-b border-line p-4">
        <div className="min-w-0 flex-1">
          <h2 className="break-words font-semibold text-ink">{session.title || t('agent.sessionPreview.untitledSession')}</h2>
          <p className="mt-1 text-xs text-ink-3">{t('agent.sessionPreview.subtitle', { label: meta.label })}</p>
          <p className="mt-1 break-all text-xs text-ink-3">{session.workspaceRoot || t('agent.sessionPreview.noWorkspace')}</p>
        </div>
        <button type="button" aria-label={t('agent.sessionPreview.closeLabel')} onClick={onClose} className="rounded p-1.5 text-ink-3 hover:bg-surface-3"><X size={18} /></button>
      </div>
      <div className="min-h-24 flex-1 overflow-y-auto p-4">
        {loading && <p role="status" className="text-sm text-ink-3">{t('agent.sessionPreview.loading')}</p>}
        {error && <div role="alert" className="text-sm text-danger"><p className="break-words">{t('agent.sessionPreview.loadFailed', { error })}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-2 text-primary hover:underline">{t('agent.sessionPreview.retryRead')}</button></div>}
        {!loading && !error && !messages.length && <p className="text-sm text-ink-3">{t('agent.sessionPreview.emptyMessages')}</p>}
        {!loading && !error && loadedIdentity === identity && messages.map((message, index) => <article key={`${message.id}:${index}`} className="mb-4 rounded-lg border border-line p-3 last:mb-0">
          <div className="mb-2 text-xs text-ink-3">{message.role === 'user' ? t('agent.sessionPreview.youSpeaker') : message.role === 'assistant' ? meta.label : message.role}
            {message.timestamp > 0 && <> · {formatDateTime(message.timestamp < 100_000_000_000 ? message.timestamp * 1000 : message.timestamp, undefined, locale)}</>}</div>
          <div className="whitespace-pre-wrap break-words text-sm text-ink [overflow-wrap:anywhere]">{message.text}</div>
        </article>)}
      </div>
      <p className="border-t border-line px-4 py-3 text-xs text-ink-3">{t('agent.sessionPreview.footerNote')}</p>
    </div>
  </div>;
}
