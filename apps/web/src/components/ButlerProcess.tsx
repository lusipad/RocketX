import { CheckCircle2, ChevronDown, Loader2, XCircle } from 'lucide-react';
import type { ButlerStep } from '../stores/butler';

function stepTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

/**
 * AI 回答的执行过程：本轮调用了哪些工具、各自成败。运行中自动展开
 * 实时滚动，结束后收起成一行摘要，可再展开回看。
 */
export default function ButlerProcess({
  steps,
  running,
  className = '',
}: {
  steps: ButlerStep[];
  running: boolean;
  className?: string;
}) {
  if (steps.length === 0) return null;
  const failed = steps.filter((step) => step.status === 'failed').length;
  return (
    <details open={running} className={`group rounded-lg border border-line bg-fill-1/50 ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs text-ink-3 transition hover:text-ink-2">
        <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
        过程 · {steps.length} 步{failed > 0 ? ` · ${failed} 步失败` : ''}
      </summary>
      <div className="space-y-1 border-t border-line px-3 py-2">
        {steps.map((step) => (
          <div key={step.id} className="flex items-center gap-2 text-xs text-ink-2">
            {step.status === 'running' ? (
              <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
            ) : step.status === 'failed' ? (
              <XCircle size={13} className="shrink-0 text-danger" />
            ) : (
              <CheckCircle2 size={13} className="shrink-0 text-success" />
            )}
            <span className="min-w-0 flex-1 truncate">{step.label}</span>
            <span className="shrink-0 text-2xs text-ink-3">{stepTime(step.at)}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
