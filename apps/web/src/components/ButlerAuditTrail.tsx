import { useCallback, useEffect, useState } from 'react';
import type { AuditEntry } from '../kernel/permission';
import { BUTLER_AUDIT_UPDATED_EVENT } from '../lib/butlerActions';
import { kernelStore } from '../kernel/store';

const KIND_LABELS: Record<string, string> = {
  reply: '回复草稿', send: '发送回复', todo: '待办', commitment: '承诺', ado: 'ADO 工作项',
  'ado-state': 'ADO 状态修改', codex: 'Codex 交接',
};
const STATUS_LABELS: Record<string, string> = {
  proposed: '已提议', cancelled: '已取消', executed: '已执行', failed: '执行失败',
};

function auditLabel(action: string): string {
  const [, , kind = '', status = ''] = action.split('.');
  return `${KIND_LABELS[kind] ?? kind} · ${STATUS_LABELS[status] ?? status}`;
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ButlerAuditTrail() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const load = useCallback(() => {
    void kernelStore.audit.list().then((all) => {
      setEntries(all
        .filter((entry) => entry.appId === 'builtin:butler' && entry.action.startsWith('butler.action.'))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 8));
    }).catch(() => setEntries([]));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(BUTLER_AUDIT_UPDATED_EVENT, load);
    return () => window.removeEventListener(BUTLER_AUDIT_UPDATED_EVENT, load);
  }, [load]);

  return (
    <section aria-label="最近动作">
      <h2 className="text-sm font-medium text-ink-3">最近动作</h2>
      {entries.length ? (
        <div className="mt-2 divide-y divide-line/70">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-start justify-between gap-3 py-2 text-xs">
              <div className="min-w-0">
                <div className={entry.allowed ? 'text-ink-2' : 'text-ink-3'}>{auditLabel(entry.action)}</div>
                {entry.reason ? <div className="mt-0.5 truncate text-danger">{entry.reason}</div> : null}
              </div>
              <time className="shrink-0 text-ink-3">{timeLabel(entry.timestamp)}</time>
            </div>
          ))}
        </div>
      ) : <p className="mt-2 text-xs text-ink-3">还没有确认或取消过管家动作。</p>}
    </section>
  );
}
