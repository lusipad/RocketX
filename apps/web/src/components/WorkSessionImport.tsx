import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
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
    ? '接续前请先停止原窗口中的执行，再到工作中确认交接。' : null;
  if (!session.workspaceRoot.trim() || (session.hostDeviceId && session.hostDeviceId !== agentDeviceId())) return null;
  return session.controlMode === 'resumable' && (session.runtime === 'acp' || session.runtime === 'pi')
    ? '打开工作后连接原会话。' : null;
}

export default function WorkSessionImport({ onSelectWork, onClose, scanning = false, scanError, onRefresh }: {
  onSelectWork: (id: string) => void;
  onClose: () => void;
  scanning?: boolean;
  scanError?: string | null;
  onRefresh?: () => Promise<void>;
}) {
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
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), [sessions, accountScope]);
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

  return <section aria-label="添加已有会话" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface-1 p-3 sm:p-4">
    <div className="flex shrink-0 items-start gap-3">
      <h2 className="min-w-0 flex-1 font-semibold text-ink">添加已有会话</h2>
      <button type="button" aria-label="关闭添加已有会话" onClick={onClose} className="rounded p-1.5 text-ink-3 hover:bg-surface-3"><X size={18} /></button>
    </div>
    <details className="mt-2 shrink-0 text-xs leading-relaxed text-ink-3"><summary className="cursor-pointer">记录范围</summary><p className="mt-1">列表包含本机最近 300 条会话及已记录的托管会话。“查看记录”会读取该会话最近 24 条可读消息。</p></details>
    {scanning && <p role="status" className="mt-2 shrink-0 text-sm text-ink-2">正在发现本机会话，当前已发现 {available.length} 个；扫描结束后可批量加入。</p>}
    <div className="mt-3 flex shrink-0 flex-wrap gap-2">
      <input aria-label="搜索已有会话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、项目或摘要" className="min-w-40 flex-1 rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink" />
      <select aria-label="会话来源" value={provider} onChange={(event) => setProvider(event.target.value)} className="max-w-full rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink"><option value="all">所有来源</option>{providers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <select aria-label="项目目录" value={project} onChange={(event) => setProject(event.target.value)} className="max-w-full rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink"><option value="all">所有项目</option>{projects.map((path) => <option key={path} value={path}>{path}</option>)}</select>
      <select aria-label="会话时间范围" value={allTime ? 'all' : 'recent'} onChange={(event) => setAllTime(event.target.value === 'all')} className="rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink"><option value="recent">最近 7 天</option><option value="all">全部时间</option></select>
      <button type="button" disabled={busy || refreshing || scanning} onClick={() => void refresh()} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1.5 text-sm text-ink-2 disabled:opacity-50"><RefreshCw size={14} />{refreshing || scanning ? '正在刷新…' : '刷新列表'}</button>
      <button type="button" disabled={busy} aria-pressed={batchMode} onClick={() => { setBatchMode((value) => !value); setSelected(new Set()); }} className="rounded px-2 py-1.5 text-xs text-ink-3 hover:text-primary disabled:opacity-50">{batchMode ? '结束批量整理' : '批量整理'}</button>
    </div>
    {(scanError === undefined ? error : scanError) && <p role="alert" className="mt-2 shrink-0 text-sm text-danger">扫描失败：{scanError === undefined ? error : scanError}。下方保留已发现的记录，可重试刷新。</p>}
    <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2 border-b border-line pb-3">
      <span className="mr-auto text-xs text-ink-3">当前范围 {filtered.length} 个 · 已发现 {available.length} 个</span>
      {batchMode && <button type="button" disabled={busy || refreshing || scanning || !(selected.size || filtered.length)}
        onClick={() => void importSessions(selected.size ? [...selected] : filtered.map((session) => session.id))}
        className="rounded bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50">{busy ? '正在加入…' : selected.size ? `加入所选 ${selected.size} 个` : `加入当前范围 ${filtered.length} 个`}</button>}
    </div>
    {!!Object.keys(results).length && <p role="status" className="mt-3 shrink-0 text-sm text-ink-2">本次结果：新增 {totals.added} 个 · 已加入 {totals.existing} 个 · 失败 {totals.failed} 个{totals.failed > 0 && '；失败项保留，可重新选择后加入。'}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!visible.length && !scanning && <p className="py-6 text-center text-sm text-ink-3">{available.length ? '当前范围没有会话，可调整筛选或查看全部时间。' : '尚未发现本机会话。可打开已有客户端使用后刷新列表。'}</p>}
      {visible.map((session) => {
        const meta = parseWorkSessionProviderMeta(session); const result = results[session.id];
        const boundCard = session.todoId ? cards.find((card) => card.id === session.todoId) : null;
        const hint = resumeHint(session, meta.provider);
        const historyFirst = !boundCard && !hint && session.controlMode !== 'controllable';
        const workAction = <button type="button" disabled={busy || refreshing} onClick={() => void importSessions([session.id], !historyFirst)}
          className={historyFirst ? 'text-ink-2 hover:text-primary hover:underline disabled:opacity-50' : 'rounded bg-primary px-3 py-1.5 text-white disabled:opacity-50'}>
          {openingId === session.id ? '正在打开…' : historyFirst ? '加入我的工作' : boundCard || !hint ? '打开工作' : '准备接续'}
        </button>;
        const historyAction = <button type="button" onClick={() => setPreview(session)}
          className={historyFirst ? 'rounded bg-primary px-3 py-1.5 text-white' : 'text-ink-2 hover:text-primary hover:underline'}>查看记录</button>;
        return <article key={session.id} data-session-id={session.id} className="flex min-w-0 gap-3 border-b border-line py-3 last:border-b-0">
          {batchMode && <input type="checkbox" aria-label={`选择 ${session.title || session.nativeSessionId}`} checked={selected.has(session.id)} disabled={busy} className="mt-1 shrink-0 self-start" onChange={(event) => setSelected((previous) => {
            const next = new Set(previous); if (event.target.checked) next.add(session.id); else next.delete(session.id); return next;
          })} />}
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-sm font-medium text-ink">{session.title || '未命名会话'}</h3>
            <p className="mt-1 break-all text-xs text-ink-3">{meta.label} · {session.workspaceRoot || '未记录项目目录'}</p>
            {meta.preview && <p className="mt-1 line-clamp-2 break-words text-xs text-ink-2">记录摘要：{meta.preview}</p>}
            <p className="mt-1 text-xs text-ink-3">更新于 {new Date(session.updatedAt).toLocaleString('zh-CN')} · {session.runtimeStatus === 'running' ? '来源报告运行中' : session.runtimeStatus === 'unknown' ? '活动状态未核实' : '已发现历史记录'}{boundCard && ' · 已加入工作台'}</p>
            {hint && <p className="mt-1 text-sm text-ink-2">{hint}</p>}
            {result?.state === 'failed' && <p role="alert" className="mt-1 break-words text-xs text-danger">加入失败：{result.message}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">{historyFirst ? <>{historyAction}{workAction}</> : <>{workAction}{historyAction}</>}</div>
          </div>
        </article>;
      })}
    </div>
    {pages > 1 && <div className="mt-3 flex shrink-0 items-center justify-between gap-2 text-xs text-ink-3">
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded border border-line px-2 py-1 disabled:opacity-40">上一页</button>
      <span>第 {currentPage + 1} / {pages} 页 · 每页最多 {PAGE_SIZE} 个</span>
      <button type="button" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)} className="rounded border border-line px-2 py-1 disabled:opacity-40">下一页</button>
    </div>}
    {preview && <WorkSessionHistoryPreview key={preview.id} session={preview} onClose={() => setPreview(null)} />}
  </section>;
}
