import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useButler } from '../stores/butler';

export default function ButlerToolApprovals({ compact = false }: { compact?: boolean }) {
  const checkpoints = useButler((state) => state.runtimeCheckpoints);
  const approve = useButler((state) => state.approveToolCheckpoint);
  const dismiss = useButler((state) => state.dismissToolCheckpoint);
  const [busyId, setBusyId] = useState<string | null>(null);
  const pending = checkpoints.filter((checkpoint) => (
    checkpoint.toolName === 'remember'
    && (checkpoint.status === 'approval-required'
      || checkpoint.status === 'running'
      || checkpoint.status === 'failed')
  ));

  if (!pending.length) return null;

  return (
    <div className="space-y-2" aria-label="待批准的管家操作">
      {pending.map((checkpoint) => {
        const busy = busyId === checkpoint.id || checkpoint.status === 'running';
        return (
          <div key={checkpoint.id} className="rounded-lg border border-primary/30 bg-primary-light/40 p-3">
            <div className="text-xs font-medium text-primary">
              {checkpoint.status === 'failed' ? '操作失败，可明确重试' : '写操作等待确认'}
            </div>
            <div className={`mt-1 text-ink ${compact ? 'text-xs' : 'text-sm'}`}>{checkpoint.preview}</div>
            {checkpoint.error ? <div className="mt-1 text-xs text-danger">{checkpoint.error.message}</div> : null}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void dismiss(checkpoint.id)}
                className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink hover:bg-fill-hover disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusyId(checkpoint.id);
                  void approve(checkpoint.id).finally(() => setBusyId(null));
                }}
                className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : null}
                {checkpoint.status === 'failed' ? '明确重试' : '确认执行'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
