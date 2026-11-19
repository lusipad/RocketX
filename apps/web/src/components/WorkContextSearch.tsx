import { useId, useState } from 'react';
import { searchWorkContext, WORK_CONTEXT_SEARCH_COVERAGE } from '../lib/workSearch';
import { resolveButlerAccountScope, useButlerMemory } from '../stores/butlerMemory';
import { useWorkLedger } from '../stores/workLedger';

const SOURCE_LABELS = { work: '工作', session: '原生会话', link: '外部联系', artifact: '验证成果', digest: '归档简报' };

export default function WorkContextSearch({ workspaceRoot, projectKey, onSelectWork, compact = false }: {
  workspaceRoot?: string | null;
  projectKey?: string | null;
  onSelectWork: (workId: string) => void;
  compact?: boolean;
}) {
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
    <section aria-label="工作与成果检索" className={compact ? 'work-first-search space-y-2' : 'space-y-2 rounded-xl border border-line p-3'}>
      <label className={compact ? 'sr-only' : 'block text-xs font-medium text-ink'} htmlFor={searchId}>查找工作与成果{projectKey ? ` · ${projectKey}` : ''}</label>
      <input id={searchId} type="search" value={query} onChange={(e) => { setQuery(e.target.value); setShowResults(true); }} placeholder="工作标题、ADO 编号、会话 ID、成果文件名…" className="w-full rounded-lg border border-line bg-surface-4 px-3 py-2 text-xs text-ink" />
      <details className="text-xs text-ink-3"><summary className="cursor-pointer">检索范围与更新时间 · 仅当前账号缓存</summary><p className="mt-1">{WORK_CONTEXT_SEARCH_COVERAGE}每条结果标明来源记录的更新时间。</p></details>
      {loading && <p role="status" className="text-xs text-ink-3">正在加载工作索引，结果可能不完整。</p>}
      {error && <p role="status" className="text-xs text-warning">工作索引加载失败：{error}，当前显示已有缓存。</p>}
      {query.trim() && results.length === 0 && <p role="status" className="text-xs text-ink-3">当前缓存范围内没有匹配结果，可以换关键词或打开来源查询。</p>}
      {!showResults && query.trim() && <button type="button" onClick={() => setShowResults(true)} className="text-xs text-primary">重新展开检索结果</button>}
      {showResults && results.length > 0 && <ul aria-label="检索结果" className="max-h-72 space-y-2 overflow-auto">
        {results.map((result) => <li key={result.id} className="rounded-lg border border-line-soft p-2 text-xs">
          {result.workId ? <button type="button" onClick={() => { onSelectWork(result.workId!); setShowResults(false); }} className="break-all text-left font-medium text-primary hover:underline">{result.title}</button> : <strong className="break-all text-ink">{result.title}</strong>}
          <p className="mt-1 break-all text-ink-2">{result.snippet}</p>
          <p className="mt-1 break-all text-ink-3">{SOURCE_LABELS[result.kind]} · {new Date(result.updatedAt).toLocaleString('zh-CN')} · 来源：{result.sourceRef}{result.stale ? ' · 已过期' : ''}</p>
          {!result.workId && <p className="text-ink-3">尚未关联工作，可到会话列表按原生 ID 查看。</p>}
        </li>)}
      </ul>}
    </section>
  );
}
