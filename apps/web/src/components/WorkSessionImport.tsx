import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { t, useI18n } from '../i18n';
import { compareLocaleText, formatDateTime } from '../i18n/format';
import { agentDeviceId } from '../agent/device';
import { codexHandoffProfileId } from '../agent/sessionAdapter';
import { parseWorkSessionProviderMeta, promoteWorkSessionToCard, syncLiveSessionsIntoLedger } from '../agent/superAgentBridge';
import type { NativeWorkSessionRecord } from '../platform/desktopCommands';
import { useAuth } from '../stores/auth';
import { resolveButlerAccountScope } from '../stores/butlerMemory';
import { useWorkLedger } from '../stores/workLedger';
import WorkSessionHistoryPreview from './WorkSessionHistoryPreview';

type ImportResult = { state: 'added' | 'existing' | 'failed'; cardId?: string; message?: string };
const PAGE_SIZE = 30;

function resumeHint(session: NativeWorkSessionRecord, provider: string): string | null {
  if (provider === 'codex') return codexHandoffProfileId(session, agentDeviceId())
    ? t('agent.sessionImport.stopFirstHint') : null;
  if (!session.workspaceRoot.trim() || (session.hostDeviceId && session.hostDeviceId !== agentDeviceId())) return null;
  return session.controlMode === 'resumable' && (session.runtime === 'acp' || session.runtime === 'pi')
    ? t('agent.sessionImport.connectAfterOpenHint') : null;
}

export default function WorkSessionImport({ onSelectWork, onClose, scanning = false, scanError, onRefresh }: {
  onSelectWork: (id: string) => void;
  onClose: () => void;
  scanning?: boolean;
  scanError?: string | null;
  onRefresh?: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const sessions = useWorkLedger((state) => state.sessions);
  const cards = useWorkLedger((state) => state.cards);
  const accountScope = useAuth(() => resolveButlerAccountScope());
  const owner = useRef(accountScope);
  const generation = useRef(0);
  const close = useRef(onClose);
  close.current = onClose;
  const [provider, setProvider] = useState('all');
  const [project, setProject] = useState('all');
  const [query, setQuery] = useState('');
  const [allTime, setAllTime] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, ImportResult>>({});
  const [busy, setBusy] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<NativeWorkSessionRecord | null>(null);
  const available = useMemo(() => sessions.filter((session) => !session.accountScope || session.accountScope === accountScope)
    .sort((a, b) => b.updatedAt - a.updatedAt || compareLocaleText(a.id, b.id, locale)), [locale, sessions, accountScope]);
  const providers = useMemo(() => [...new Map(available.map((session) => {
    const meta = parseWorkSessionProviderMeta(session); return [meta.provider, meta.label];
  })).entries()], [available]);
  const projects = useMemo(() => [...new Set(available.map((session) => session.workspaceRoot).filter(Boolean))].sort(), [available]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase(); const cutoff = Date.now() - 7 * 86_400_000;
    return available.filter((session) => {
      const meta = parseWorkSessionProviderMeta(session);
      return (allTime || session.updatedAt >= cutoff) && (provider === 'all' || meta.provider === provider)
        && (project === 'all' || session.workspaceRoot === project)
        && (!needle || [session.title, session.workspaceRoot, meta.label, meta.preview, session.nativeSessionId].some((text) => text?.toLowerCase().includes(needle)));
    });
  }, [available, allTime, provider, project, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const totals = Object.values(results).reduce((counts, result) => ({ ...counts, [result.state]: counts[result.state] + 1 }), { added: 0, existing: 0, failed: 0 });

  useEffect(() => { setPage(0); setSelected(new Set()); }, [provider, project, query, allTime]);
  useEffect(() => {
    if (owner.current !== accountScope) {
      generation.current += 1; setSelected(new Set()); setResults({}); setPreview(null); setError(null); onClose();
    }
  }, [accountScope]);
  useEffect(() => {
    const unsubscribe = useAuth.subscribe(() => {
      if (resolveButlerAccountScope() !== owner.current) {
        generation.current += 1; setSelected(new Set()); setResults({}); setPreview(null); close.current();
      }
    });
    return () => { generation.current += 1; unsubscribe(); };
  }, []);

  const importSessions = async (ids: string[], openWork = false) => {
    const request = ++generation.current; const scope = accountScope;
    const current = () => request === generation.current && resolveButlerAccountScope() === scope;
    setBusy(true); setError(null); setOpeningId(openWork ? ids[0] ?? null : null);
    for (const id of ids) {
      if (!current()) break;
      const session = useWorkLedger.getState().sessions.find((item) => item.id === id);
      if (!session) continue;
      const wasAdded = Boolean(session.todoId && useWorkLedger.getState().cards.some((card) => card.id === session.todoId));
      try {
        const card = await promoteWorkSessionToCard(session);
        if (!current()) break;
        setResults((previous) => ({ ...previous, [id]: { state: wasAdded ? 'existing' : 'added', cardId: card.id } }));
        if (openWork) onSelectWork(card.id);
      } catch (cause) {
        if (!current()) break;
        setResults((previous) => ({ ...previous, [id]: { state: 'failed', message: cause instanceof Error ? cause.message : String(cause) } }));
      }
    }
    if (current()) { setBusy(false); setOpeningId(null); }
  };
  const refresh = async () => {
    const request = ++generation.current; setRefreshing(true); setError(null);
    try { await (onRefresh ? onRefresh() : syncLiveSessionsIntoLedger({ limit: 300 })); }
    catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === generation.current) setRefreshing(false); }
  };

  return <section aria-label={t('agent.sessionImport.sectionLabel')} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface-1 p-3 sm:p-4">
    <div className="flex shrink-0 items-start gap-3">
      <h2 className="min-w-0 flex-1 font-semibold text-ink">{t('agent.sessionImport.title')}</h2>
      <button type="button" aria-label={t('agent.sessionImport.closeLabel')} onClick={onClose} className="rounded p-1.5 text-ink-3 hover:bg-surface-3"><X size={18} /></button>
    </div>
    <details className="mt-2 shrink-0 text-xs leading-relaxed text-ink-3"><summary className="cursor-pointer">{t('agent.sessionImport.scopeSummary')}</summary><p className="mt-1">{t('agent.sessionImport.scopeDetail')}</p></details>
    {scanning && <p role="status" className="mt-2 shrink-0 text-sm text-ink-2">{t('agent.sessionImport.scanningStatus', { count: available.length })}</p>}
    <div className="mt-3 flex shrink-0 flex-wrap gap-2">
      <input aria-label={t('agent.sessionImport.searchLabel')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('agent.sessionImport.searchPlaceholder')} className="min-w-40 flex-1 rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink" />
      <select aria-label={t('agent.sessionImport.sourceLabel')} value={provider} onChange={(event) => setProvider(event.target.value)} className="max-w-full rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink"><option value="all">{t('agent.sessionImport.allSources')}</option>{providers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <select aria-label={t('agent.sessionImport.projectLabel')} value={project} onChange={(event) => setProject(event.target.value)} className="max-w-full rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink"><option value="all">{t('agent.sessionImport.allProjects')}</option>{projects.map((path) => <option key={path} value={path}>{path}</option>)}</select>
      <select aria-label={t('agent.sessionImport.rangeLabel')} value={allTime ? 'all' : 'recent'} onChange={(event) => setAllTime(event.target.value === 'all')} className="rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink"><option value="recent">{t('agent.sessionImport.recent7Days')}</option><option value="all">{t('agent.sessionImport.allTime')}</option></select>
      <button type="button" disabled={busy || refreshing || scanning} onClick={() => void refresh()} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1.5 text-sm text-ink-2 disabled:opacity-50"><RefreshCw size={14} />{refreshing || scanning ? t('agent.sessionImport.refreshingBtn') : t('agent.sessionImport.refreshListBtn')}</button>
      <button type="button" disabled={busy} aria-pressed={batchMode} onClick={() => { setBatchMode((value) => !value); setSelected(new Set()); }} className="rounded px-2 py-1.5 text-xs text-ink-3 hover:text-primary disabled:opacity-50">{batchMode ? t('agent.sessionImport.endBatchBtn') : t('agent.sessionImport.batchBtn')}</button>
    </div>
    {(scanError === undefined ? error : scanError) && <p role="alert" className="mt-2 shrink-0 text-sm text-danger">{t('agent.sessionImport.scanFailed', { error: (scanError === undefined ? error : scanError) ?? '' })}</p>}
    <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2 border-b border-line pb-3">
      <span className="mr-auto text-xs text-ink-3">{t('agent.sessionImport.scopeCount', { filtered: filtered.length, available: available.length })}</span>
      {batchMode && <button type="button" disabled={busy || refreshing || scanning || !(selected.size || filtered.length)}
        onClick={() => void importSessions(selected.size ? [...selected] : filtered.map((session) => session.id))}
        className="rounded bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50">{busy ? t('agent.sessionImport.addingBtn') : selected.size ? t('agent.sessionImport.addSelectedBtn', { count: selected.size }) : t('agent.sessionImport.addRangeBtn', { count: filtered.length })}</button>}
    </div>
    {!!Object.keys(results).length && <p role="status" className="mt-3 shrink-0 text-sm text-ink-2">{t('agent.sessionImport.batchResult', { added: totals.added, existing: totals.existing, failed: totals.failed, failedSuffix: totals.failed > 0 ? t('agent.sessionImport.batchResultFailedSuffix') : '' })}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!visible.length && !scanning && <p className="py-6 text-center text-sm text-ink-3">{available.length ? t('agent.sessionImport.emptyFiltered') : t('agent.sessionImport.emptyNoSessions')}</p>}
      {visible.map((session) => {
        const meta = parseWorkSessionProviderMeta(session); const result = results[session.id];
        const boundCard = session.todoId ? cards.find((card) => card.id === session.todoId) : null;
        const hint = resumeHint(session, meta.provider);
        const historyFirst = !boundCard && !hint && session.controlMode !== 'controllable';
        const workAction = <button type="button" disabled={busy || refreshing} onClick={() => void importSessions([session.id], !historyFirst)}
          className={historyFirst ? 'text-ink-2 hover:text-primary hover:underline disabled:opacity-50' : 'rounded bg-primary px-3 py-1.5 text-white disabled:opacity-50'}>
          {openingId === session.id ? t('agent.sessionImport.openingBtn') : historyFirst ? t('agent.sessionImport.addMyWorkBtn') : boundCard || !hint ? t('agent.sessionImport.openWorkBtn') : t('agent.sessionImport.prepareHandoffBtn')}
        </button>;
        const historyAction = <button type="button" onClick={() => setPreview(session)}
          className={historyFirst ? 'rounded bg-primary px-3 py-1.5 text-white' : 'text-ink-2 hover:text-primary hover:underline'}>{t('agent.sessionImport.viewHistoryBtn')}</button>;
        return <article key={session.id} data-session-id={session.id} className="flex min-w-0 gap-3 border-b border-line py-3 last:border-b-0">
          {batchMode && <input type="checkbox" aria-label={t('agent.sessionImport.selectSessionAria', { label: session.title || session.nativeSessionId })} checked={selected.has(session.id)} disabled={busy} className="mt-1 shrink-0 self-start" onChange={(event) => setSelected((previous) => {
            const next = new Set(previous); if (event.target.checked) next.add(session.id); else next.delete(session.id); return next;
          })} />}
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-sm font-medium text-ink">{session.title || t('agent.sessionPreview.untitledSession')}</h3>
            <p className="mt-1 break-all text-xs text-ink-3">{meta.label} · {session.workspaceRoot || t('agent.sessionPreview.noWorkspace')}</p>
            {meta.preview && <p className="mt-1 line-clamp-2 break-words text-xs text-ink-2">{t('agent.sessionImport.previewLine', { preview: meta.preview })}</p>}
            <p className="mt-1 text-xs text-ink-3">{t('agent.sessionImport.metaLine', { time: formatDateTime(session.updatedAt, undefined, locale), status: session.runtimeStatus === 'running' ? t('agent.sessionImport.statusRunning') : session.runtimeStatus === 'unknown' ? t('agent.sessionImport.statusUnknown') : t('agent.sessionImport.statusHistory'), boundSuffix: boundCard ? t('agent.sessionImport.addedToWorkbench') : '' })}</p>
            {hint && <p className="mt-1 text-sm text-ink-2">{hint}</p>}
            {result?.state === 'failed' && <p role="alert" className="mt-1 break-words text-xs text-danger">{t('agent.sessionImport.addFailed', { message: result.message ?? '' })}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">{historyFirst ? <>{historyAction}{workAction}</> : <>{workAction}{historyAction}</>}</div>
          </div>
        </article>;
      })}
    </div>
    {pages > 1 && <div className="mt-3 flex shrink-0 items-center justify-between gap-2 text-xs text-ink-3">
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded border border-line px-2 py-1 disabled:opacity-40">{t('agent.sessionImport.prevPage')}</button>
      <span>{t('agent.sessionImport.pageInfo', { page: currentPage + 1, pages, pageSize: PAGE_SIZE })}</span>
      <button type="button" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)} className="rounded border border-line px-2 py-1 disabled:opacity-40">{t('agent.sessionImport.nextPage')}</button>
    </div>}
    {preview && <WorkSessionHistoryPreview key={preview.id} session={preview} onClose={() => setPreview(null)} />}
  </section>;
}
