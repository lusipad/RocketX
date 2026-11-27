import { useId, useState } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { formatDateTime } from '../i18n/format';
import { searchWorkContext, workContextSearchCoverage } from '../lib/workSearch';
import { resolveButlerAccountScope, useButlerMemory } from '../stores/butlerMemory';
import { useWorkLedger } from '../stores/workLedger';

const SOURCE_LABEL_KEYS = {
  work: 'agent.search.source.work',
  session: 'agent.search.source.session',
  link: 'agent.search.source.link',
  artifact: 'agent.search.source.artifact',
  digest: 'agent.search.source.digest',
} as const satisfies Record<'work' | 'session' | 'link' | 'artifact' | 'digest', MessageKey>;

export default function WorkContextSearch({ workspaceRoot, projectKey, onSelectWork, compact = false }: {
  workspaceRoot?: string | null;
  projectKey?: string | null;
  onSelectWork: (workId: string) => void;
  compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [showResults, setShowResults] = useState(true);
  const searchId = useId();
  const cards = useWorkLedger((s) => s.cards);
  const sessions = useWorkLedger((s) => s.sessions);
  const links = useWorkLedger((s) => s.links);
  const evidences = useWorkLedger((s) => s.evidences);
  const digests = useButlerMemory((s) => s.digests);
  const loading = useWorkLedger((s) => s.loading);
  const error = useWorkLedger((s) => s.lastError);
  const results = searchWorkContext({ query, accountScope: resolveButlerAccountScope(), workspaceRoot, projectKey, cards, sessions, links, evidences, digests });
  return (
    <section aria-label={t('agent.search.sectionLabel')} className={compact ? 'work-first-search space-y-2' : 'space-y-2 rounded-xl border border-line p-3'}>
      <label className={compact ? 'sr-only' : 'block text-xs font-medium text-ink'} htmlFor={searchId}>{projectKey ? t('agent.search.labelWithProject', { projectKey }) : t('agent.search.label')}</label>
      <input id={searchId} type="search" value={query} onChange={(e) => { setQuery(e.target.value); setShowResults(true); }} placeholder={t('agent.search.placeholder')} className="w-full rounded-lg border border-line bg-surface-4 px-3 py-2 text-xs text-ink" />
      <details className="text-xs text-ink-3"><summary className="cursor-pointer">{t('agent.search.coverageSummary')}</summary><p className="mt-1">{workContextSearchCoverage()}{t('agent.search.coverageDetailSuffix')}</p></details>
      {loading && <p role="status" className="text-xs text-ink-3">{t('agent.search.loadingIndex')}</p>}
      {error && <p role="status" className="text-xs text-warning">{t('agent.search.indexFailed', { error })}</p>}
      {query.trim() && results.length === 0 && <p role="status" className="text-xs text-ink-3">{t('agent.search.noResults')}</p>}
      {!showResults && query.trim() && <button type="button" onClick={() => setShowResults(true)} className="text-xs text-primary">{t('agent.search.reopenResults')}</button>}
      {showResults && results.length > 0 && <ul aria-label={t('agent.search.resultsLabel')} className="max-h-72 space-y-2 overflow-auto">
        {results.map((result) => <li key={result.id} className="rounded-lg border border-line-soft p-2 text-xs">
          {result.workId ? <button type="button" onClick={() => { onSelectWork(result.workId!); setShowResults(false); }} className="break-all text-left font-medium text-primary hover:underline">{result.title}</button> : <strong className="break-all text-ink">{result.title}</strong>}
          <p className="mt-1 break-all text-ink-2">{result.snippet}</p>
          <p className="mt-1 break-all text-ink-3">{t('agent.search.metaLine', { kind: t(SOURCE_LABEL_KEYS[result.kind]), time: formatDateTime(result.updatedAt, undefined, locale), sourceRef: result.sourceRef, staleSuffix: result.stale ? t('agent.search.metaStale') : '' })}</p>
          {!result.workId && <p className="text-ink-3">{t('agent.search.unlinkedWork')}</p>}
        </li>)}
      </ul>}
    </section>
  );
}
