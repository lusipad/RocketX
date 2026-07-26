import { useEffect, useMemo, useState } from 'react';
import { codexApprovalSummary } from '../lib/codexApprovalSummary';
import { visibleButlerErrands, type ButlerErrandRun } from '../lib/butlerErrands';
import { useButler } from '../stores/butler';
import { toast } from '../stores/toast';
import Button from './ui/Button';

function elapsedMinutes(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 60_000));
}

function conclusionPreview(text: string): string {
  return text.split(/\r?\n/).slice(0, 2).join('\n');
}

function approvalQuestion(errand: ButlerErrandRun, request: string): string {
  return [
    `「${errand.title}」正在等我决定是否允许下面这件事：`,
    '',
    request,
    '',
    '为什么要跑这个？',
  ].join('\n');
}

/** 三个管家表面共用这一块；活的状态与操作不依赖组件是否挂载。 */
export default function ButlerErrandRunCard() {
  const errands = useButler((state) => state.errands);
  const resolveErrandApproval = useButler((state) => state.resolveErrandApproval);
  const archiveErrand = useButler((state) => state.archiveErrand);
  const askButler = useButler((state) => state.ask);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(Date.now());
  const sorted = useMemo(() => visibleButlerErrands(errands), [errands]);
  const hasRunning = sorted.some((errand) =>
    errand.status === 'running' || errand.status === 'awaiting-approval');

  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  if (!sorted.length) return null;

  const copyResumeCommand = async (threadId: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`codex resume ${threadId}`);
      toast.success('已复制，去终端粘贴就能看全过程');
    } catch (error) {
      toast.error(error, '复制失败');
    }
  };

  return (
    <section className="rounded-xl bg-surface p-4 shadow-raise" aria-label="派出去的活">
      <h2 className="text-sm font-semibold text-ink">派出去的活</h2>
      <div className="mt-3 flex flex-col gap-3">
        {sorted.map((errand) => {
          const waiting = errand.status === 'awaiting-approval';
          const running = errand.status === 'running';
          const replied = errand.status === 'replied' || errand.status === 'failed';
          const isExpanded = expanded.has(errand.id);
          const conclusion = errand.reply ?? errand.error ?? '这个活没留下结论。';

          return (
            <article key={errand.id} className="rounded-lg bg-surface-2 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink-3">
                    {waiting ? '等你点头' : running ? '正在干' : '回话了'}
                  </div>
                  <div className="mt-1 truncate text-sm font-medium text-ink">{errand.title}</div>
                </div>
                {running ? (
                  <span className="shrink-0 text-xs text-ink-3">
                    派出去 {elapsedMinutes(errand.startedAt, now)} 分钟
                  </span>
                ) : null}
              </div>

              {waiting ? (
                <div className="mt-3 flex flex-col gap-2">
                  {errand.approvals.map((approval) => {
                    const request = codexApprovalSummary(approval.method, approval.params);
                    return (
                      <div key={approval.id} className="rounded-lg bg-warning/10 p-3">
                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-[11px] leading-5 text-ink-2">
                          {request}
                        </pre>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => resolveErrandApproval(errand.id, approval.id, true)}
                          >
                            让它跑
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => resolveErrandApproval(errand.id, approval.id, false)}
                          >
                            这次不行
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void askButler(approvalQuestion(errand, request))}
                          >
                            为什么要跑这个？
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {running ? (
                <p className="mt-2 truncate text-sm text-ink-2">{errand.activity ?? '正在处理'}</p>
              ) : null}

              {replied ? (
                <>
                  <div className={`mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-2 ${isExpanded ? '' : 'line-clamp-2'}`}>
                    {isExpanded ? conclusion : conclusionPreview(conclusion)}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => void copyResumeCommand(errand.threadId)}
                      className="font-mono text-[11px] text-ink-3 hover:text-ink"
                      title={`复制 codex resume ${errand.threadId}`}
                    >
                      codex resume {errand.threadId.slice(0, 8)}
                    </button>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(errand.id)) next.delete(errand.id);
                          else next.add(errand.id);
                          return next;
                        })}
                      >
                        {isExpanded ? '只看摘要' : '看完整结论'}
                      </Button>
                      <Button variant="primary" size="sm" onClick={() => archiveErrand(errand.id)}>
                        收下
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
