import { CheckCircle2, CircleDotDashed, MessageSquareText, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { codexApprovalSummary } from '../lib/codexApprovalSummary';
import {
  partitionButlerPaperErrands,
  type ButlerPaperErrandSections,
} from '../lib/butlerPaper';
import type { ButlerErrandRun } from '../lib/butlerErrands';
import { useButler } from '../stores/butler';
import { toast } from '../stores/toast';

function elapsedMinutes(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 60_000));
}

function approvalQuestion(errand: ButlerErrandRun, request: string): string {
  return [
    `「${errand.title}」正在等我决定是否允许下面这件事：`,
    '',
    request,
    '',
    '为什么需要这项操作？',
  ].join('\n');
}

function activeProgress(errand: ButlerErrandRun): string {
  if (errand.status === 'running') return errand.activity ?? '正在处理';
  if (errand.status === 'replied') return '回话了';
  return '停下来了';
}

function ActiveIcon({ errand }: { errand: ButlerErrandRun }) {
  if (errand.status === 'running') return <CircleDotDashed size={15} className="text-primary" />;
  if (errand.status === 'replied') return <MessageSquareText size={15} className="text-primary" />;
  return <XCircle size={15} className="text-ink-3" />;
}

export function ButlerErrandStatusLine({
  sections,
}: {
  sections: ButlerPaperErrandSections;
}) {
  return (
    <div className="text-xs text-ink-3" aria-label="管家活状态">
      {sections.approvals.length} 件等你 · {sections.active.length} 在办
    </div>
  );
}

export default function ButlerErrandRunCard({
  runs,
  compact = false,
  archived = false,
  onAsk,
}: {
  runs?: readonly ButlerErrandRun[];
  compact?: boolean;
  archived?: boolean;
  onAsk?: (question: string) => void | Promise<void>;
}) {
  const storeErrands = useButler((state) => state.errands);
  const resolveErrandApproval = useButler((state) => state.resolveErrandApproval);
  const stopErrand = useButler((state) => state.stopErrand);
  const archiveErrand = useButler((state) => state.archiveErrand);
  const askButler = useButler((state) => state.ask);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(Date.now());
  const errands = runs ?? storeErrands;
  const sections = useMemo(() => partitionButlerPaperErrands(errands), [errands]);
  const hasRunning = sections.active.some((errand) => errand.status === 'running');

  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  if (!errands.length) return null;

  const toggleExpanded = (runId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const copyResumeCommand = async (threadId: string): Promise<void> => {
    try {
      if (!threadId || !navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(`codex resume ${threadId}`);
      toast.success('已复制，去终端粘贴就能看全过程');
    } catch (error) {
      toast.error(error, '复制失败');
    }
  };

  if (archived) {
    return (
      <section aria-label="收下的活">
        <h2 className={`${compact ? 'text-sm' : 'text-base'} font-semibold text-ink`}>收下的活</h2>
        <div className="mt-3 space-y-4">
          {errands.map((errand) => (
            <article key={errand.id} className="border-l-2 border-line pl-3">
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                <CheckCircle2 size={14} className="text-ink-3" />
                {errand.title}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink-2">
                {errand.reply ?? errand.error ?? '这个活没留下结论。'}
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  return (
    <div className={compact ? 'space-y-5' : 'space-y-8'}>
      {sections.approvals.length > 0 ? (
        <section aria-label="等你点头">
          <h2 className={`${compact ? 'text-sm' : 'text-base'} font-semibold text-danger`}>等你点头</h2>
          <div className="mt-3 space-y-5 border-l-2 border-danger pl-4">
            {sections.approvals.map((errand) => (
              <article key={errand.id}>
                <h3 className="text-sm font-medium text-ink">{errand.title}</h3>
                <div className="mt-2 space-y-3">
                  {errand.approvals.map((approval) => {
                    const request = codexApprovalSummary(approval.method, approval.params);
                    return (
                      <div key={approval.id}>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-ink-2">
                          {request}
                        </pre>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          <button
                            type="button"
                            className="text-danger hover:underline"
                            onClick={() => void resolveErrandApproval(errand.id, approval.id, true)}
                          >
                            让它跑
                          </button>
                          <button
                            type="button"
                            className="text-danger hover:underline"
                            onClick={() => void resolveErrandApproval(errand.id, approval.id, false)}
                          >
                            这次不行
                          </button>
                          <button
                            type="button"
                            className="text-danger hover:underline"
                            onClick={() => void (onAsk ?? askButler)(approvalQuestion(errand, request))}
                          >
                            为什么？
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="text-xs text-danger hover:underline"
                    onClick={() => void stopErrand(errand.id)}
                  >
                    叫停
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {sections.active.length > 0 ? (
        <section aria-label="在办">
          <h2 className={`${compact ? 'text-sm' : 'text-base'} font-semibold text-ink`}>在办</h2>
          <div className="mt-3 divide-y divide-line/60 border-l-2 border-primary/70 pl-4">
            {sections.active.map((errand) => {
              const isExpanded = expanded.has(errand.id);
              const replied = errand.status === 'replied' || errand.status === 'failed';
              const conclusion = errand.reply ?? errand.error ?? '这个活没留下结论。';

              return (
                <article key={errand.id} className="py-3 first:pt-0 last:pb-0">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(errand.id)}
                    aria-expanded={isExpanded}
                    className="flex w-full min-w-0 items-center gap-2 text-left"
                  >
                    <ActiveIcon errand={errand} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{errand.title}</span>
                    <span className="shrink-0 text-xs text-ink-2">{activeProgress(errand)}</span>
                    <span className="shrink-0 text-xs text-ink-3">
                      {elapsedMinutes(errand.startedAt, now)} 分钟
                    </span>
                    {replied ? (
                      <span className="shrink-0 text-xs text-primary">看结论并收下</span>
                    ) : null}
                  </button>

                  {isExpanded ? (
                    <div className="ml-6 mt-3 text-xs leading-5 text-ink-2">
                      {replied ? (
                        <>
                          <div className="whitespace-pre-wrap">{conclusion}</div>
                          <button
                            type="button"
                            className="mt-3 text-primary hover:underline"
                            onClick={() => void archiveErrand(errand.id)}
                          >
                            收下
                          </button>
                        </>
                      ) : (
                        <>
                          <div>{errand.activity ?? '正在处理'}</div>
                          {errand.plan?.length ? (
                            <ol className="mt-3 space-y-1" aria-label={`${errand.title} 的 TODO`}>
                              {errand.plan.map((item, index) => (
                                <li key={`${item.step}-${index}`} className="flex gap-2">
                                  <span aria-hidden="true">
                                    {item.status === 'completed' ? '✓' : item.status === 'inProgress' ? '→' : '○'}
                                  </span>
                                  <span className={item.status === 'completed' ? 'text-ink-3 line-through' : ''}>
                                    {item.step}
                                  </span>
                                </li>
                              ))}
                            </ol>
                          ) : null}
                          {errand.traces.length > 0 ? (
                            <div className="mt-3 text-ink-3" aria-label={`${errand.title} 的过程尾巴`}>
                              <div className="mb-1">过程尾巴</div>
                              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                                {errand.traces.slice(-6).map((trace) => trace.text).join('\n')}
                              </pre>
                            </div>
                          ) : null}
                          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                            <button
                              type="button"
                              className="text-danger hover:underline"
                              onClick={() => void stopErrand(errand.id)}
                            >
                              叫停
                            </button>
                            {errand.threadId ? (
                              <button
                                type="button"
                                className="font-mono text-[11px] text-ink-3 hover:text-ink"
                                title={`复制 codex resume ${errand.threadId}`}
                                onClick={() => void copyResumeCommand(errand.threadId)}
                              >
                                codex resume {errand.threadId}
                              </button>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
