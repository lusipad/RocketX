import { useMemo, useState, type DragEvent } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  adoDateToLocal,
  isWorkItemDone,
  stateBadgeClass,
  type WorkItem,
} from '../stores/workbench';
import { boardColumns, wbsStats, wbsSummary } from '../lib/queryViews';
import { workItemTreeRows } from '../lib/workItemTree';
import { todayKey } from '../stores/todos';
import { TYPE_COLORS } from './AdoLists';

/**
 * 自定义查询结果的看板与 WBS 视图（issue #82、#83）。
 * 查询本身定义范围和过滤（在 ADO 端维护），这里不再叠一层过滤器。
 */

function TypeDot({ type }: { type: string }) {
  return (
    <span
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ background: TYPE_COLORS[type] ?? '#8f959e' }}
      title={type}
    />
  );
}

function Empty() {
  return <div className="py-12 text-center text-sm text-ink-3">查询没有返回工作项</div>;
}

/**
 * 看板：列 = 查询结果里真实出现的状态，卡片点击进 ADO。
 * 传入 onMove 时卡片可拖到别的列改状态（是否合法流转由 ADO 服务端裁决）。
 */
export function WorkItemBoard({
  items,
  onMove,
}: {
  items: WorkItem[];
  onMove?: (item: WorkItem, toState: string) => void;
}) {
  const today = todayKey();
  const columns = useMemo(() => boardColumns(items, today), [items, today]);
  const [dragOverState, setDragOverState] = useState<string | null>(null);
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  if (items.length === 0) return <Empty />;

  const dropHandlers = (state: string) =>
    onMove
      ? {
          onDragOver: (e: DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            setDragOverState(state);
          },
          onDragLeave: () => setDragOverState((current) => (current === state ? null : current)),
          onDrop: (e: DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            setDragOverState(null);
            const id = Number(e.dataTransfer.getData('text/plain'));
            const item = byId.get(id);
            if (item && item.state !== state) onMove(item, state);
          },
        }
      : {};

  return (
    <div className="flex flex-1 gap-3 overflow-x-auto pb-2">
      {columns.map((column) => (
        <div
          key={column.state}
          {...dropHandlers(column.state)}
          className={`flex max-h-full w-72 shrink-0 flex-col rounded-lg border bg-fill-1 transition ${
            dragOverState === column.state ? 'border-primary bg-primary-light/40' : 'border-line'
          }`}
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
            <span className={`rounded px-1.5 py-0.5 text-2xs ${stateBadgeClass(column.state)}`}>
              {column.state}
            </span>
            <span className="text-xs text-ink-3">{column.items.length}</span>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {column.items.map((w) => {
              const due = adoDateToLocal(w.dueDate);
              const overdue = !!due && due < today && !isWorkItemDone(w.state);
              return (
                <a
                  key={w.id}
                  href={w.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  draggable={!!onMove}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', String(w.id))}
                  className={`block rounded-md border border-line bg-surface-4 px-3 py-2.5 transition hover:border-primary/50 hover:shadow-sm ${
                    onMove ? 'cursor-grab active:cursor-grabbing' : ''
                  }`}
                >
                  <div className="line-clamp-2 text-sm break-words text-ink">{w.title}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-ink-3">
                    <TypeDot type={w.type} />
                    <span>#{w.id}</span>
                    {w.priority !== undefined && (
                      <span className={w.priority === 1 ? 'font-medium text-danger' : w.priority === 2 ? 'text-warning' : ''}>
                        P{w.priority}
                      </span>
                    )}
                    {due && (
                      <span className={overdue ? 'font-medium text-danger' : ''}>
                        {overdue ? '逾期 ' : ''}
                        {due.slice(5).replace('-', '/')}
                      </span>
                    )}
                    <span className="ml-auto max-w-[40%] truncate" title={w.assignedTo}>
                      {w.assignedTo ?? '未分配'}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function RiskChips({ overdue, stale, unassigned }: { overdue: number; stale: number; unassigned: number }) {
  if (overdue + stale + unassigned === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-2xs">
      {overdue > 0 && (
        <span className="rounded bg-danger/10 px-1.5 py-0.5 font-medium text-danger">逾期 {overdue}</span>
      )}
      {stale > 0 && (
        <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">停滞 {stale}</span>
      )}
      {unassigned > 0 && (
        <span className="rounded bg-fill-2 px-1.5 py-0.5 text-ink-3">未指派 {unassigned}</span>
      )}
    </span>
  );
}

/** WBS：父子树 + 子树进度汇总 + 规则化风险信号 */
export function WorkItemWbs({ items }: { items: WorkItem[] }) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const stats = useMemo(() => wbsStats(items), [items]);
  const summary = useMemo(() => wbsSummary(items), [items]);
  const rows = useMemo(
    () => workItemTreeRows(items, new Set(items.map((item) => item.id)), collapsed, false),
    [items, collapsed],
  );
  if (items.length === 0) return <Empty />;

  const percent = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;
  const toggleCollapsed = (id: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 pb-3">
        <div className="h-2 w-48 overflow-hidden rounded-full bg-fill-2">
          <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
        </div>
        <span className="text-xs text-ink-2">
          整体进度 {summary.done}/{summary.total} · {percent}%
        </span>
        <RiskChips overdue={summary.overdue} stale={summary.stale} unassigned={summary.unassigned} />
      </div>

      <div className="flex-1 overflow-y-auto rounded-lg border border-line bg-surface-4">
        {rows.map(({ item: w, depth, hasChildren }) => {
          const isCollapsed = collapsed.has(w.id);
          const nodeStats = stats.get(w.id);
          const nodePercent =
            nodeStats && nodeStats.total > 0 ? Math.round((nodeStats.done / nodeStats.total) * 100) : 0;
          return (
            <div
              key={w.id}
              className="group flex items-center border-b border-line last:border-b-0 hover:bg-fill-2"
            >
              <span
                className="flex h-full shrink-0 items-center"
                style={{ paddingLeft: `${12 + depth * 20}px` }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(w.id)}
                    className="flex h-7 w-7 items-center justify-center rounded text-ink-3 hover:bg-fill-3 hover:text-ink"
                    title={isCollapsed ? '展开子项' : '折叠子项'}
                    aria-label={isCollapsed ? `展开工作项 #${w.id}` : `折叠工作项 #${w.id}`}
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                ) : (
                  <span className="h-7 w-7" />
                )}
              </span>
              <a
                href={w.webUrl}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-4"
              >
                <TypeDot type={w.type} />
                <span className="w-14 shrink-0 text-xs text-ink-3">#{w.id}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{w.title}</span>

                {hasChildren && nodeStats && (
                  <span className="flex w-40 shrink-0 items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill-2">
                      <span
                        className="block h-full rounded-full bg-success"
                        style={{ width: `${nodePercent}%` }}
                      />
                    </span>
                    <span className="w-12 text-right text-2xs text-ink-3">
                      {nodeStats.done}/{nodeStats.total}
                    </span>
                  </span>
                )}
                {nodeStats && (
                  <RiskChips
                    overdue={nodeStats.overdue}
                    stale={nodeStats.stale}
                    unassigned={nodeStats.unassigned}
                  />
                )}
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-2xs ${stateBadgeClass(w.state)}`}>
                  {w.state}
                </span>
                <span className="w-24 shrink-0 truncate text-right text-2xs text-ink-3" title={w.assignedTo}>
                  {w.assignedTo ?? '未分配'}
                </span>
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
