import {
  Archive,
  CheckCircle2,
  ChevronDown,
  CircleDotDashed,
  CircleHelp,
  Copy,
  MessageSquareText,
  Play,
  Square,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { codexApprovalSummary } from '../lib/codexApprovalSummary';
import {
  partitionButlerPaperErrands,
  type ButlerPaperErrandSections,
} from '../lib/butlerPaper';
import type { ButlerErrandRun } from '../lib/butlerErrands';
import { useButler } from '../stores/butler';
import { useButlerErrandRuns } from '../stores/butlerErrandRuns';
import { toast } from '../stores/toast';
import ButlerErrandInputCard from './ButlerErrandInputCard';

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
  if (errand.status === 'paused') return errand.error ?? '已暂停，等你决定是否继续';
  if (errand.status === 'replied') return '回话了';
  return '停下来了';
}

function ActiveIcon({ errand }: { errand: ButlerErrandRun }) {
  if (errand.status === 'running') {
    return (
      <CircleDotDashed
        size={15}
        aria-hidden="true"
        className="animate-spin text-primary [animation-duration:3s] motion-reduce:animate-none"
      />
    );
  }
  if (errand.status === 'paused') return <Play size={15} className="text-ink-3" />;
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
  const resolveErrandInput = useButler((state) => state.resolveErrandInput);
  const stopErrand = useButler((state) => state.stopErrand);
  const archiveErrand = useButler((state) => state.archiveErrand);
  const askButler = useButler((state) => state.ask);
  const resumeErrand = useButlerErrandRuns((state) => state.resumeErrand);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(Date.now());
  const errands = runs ?? storeErrands;
  const sections = useMemo(() => partitionButlerPaperErrands(errands), [errands]);
  const hasPendingInput = sections.approvals.some((errand) => (errand.inputs?.length ?? 0) > 0);
  const hasRunning = sections.active.some((errand) => errand.status === 'running' || errand.status === 'paused');

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
        <h2 className={`${compact ? 'text-sm' : 'text-base'} font-medium text-ink-3`}>办完</h2>
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
        <section aria-label={hasPendingInput ? '等你回应' : '等你点头'}>
          <h2 className={`${compact ? 'text-sm' : 'text-base'} font-semibold ${hasPendingInput ? 'text-primary' : 'text-danger'}`}>
            {hasPendingInput ? '等你回应' : '等你点头'}
          </h2>
          <div className={`mt-3 space-y-5 border-l-2 pl-4 ${hasPendingInput ? 'border-primary' : 'border-danger'}`}>
            {sections.approvals.map((errand) => {
              const inputs = errand.inputs ?? [];
              return (
                <article key={errand.id}>
                  <h3 className="text-sm font-medium text-ink">{errand.title}</h3>
                  <div className="mt-2 space-y-3">
                    {inputs.map((input) => (
                      <ButlerErrandInputCard
                        key={input.id}
                        input={input}
                        onResolve={(response) => resolveErrandInput(errand.id, input.id, response)}
                      />
                    ))}
                  {errand.approvals.map((approval, approvalIndex) => {
                    const request = codexApprovalSummary(approval.method, approval.params);
                    return (
                      <div key={approval.id}>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-ink-2">
                          {request}
                        </pre>
                        <div className="mt-2 flex flex-wrap gap-1 text-xs">
                          <button
                            type="button"
                            aria-label={`允许${errand.title}`}
                            title="让它跑"
                            className="inline-flex h-7 items-center gap-1 rounded px-2 text-danger transition-colors hover:bg-danger/10"
                            onClick={() => void resolveErrandApproval(errand.id, approval.id, true)}
                          >
                            <Play size={12} aria-hidden="true" />
                            让它跑
                          </button>
                          <button
                            type="button"
                            aria-label={`拒绝${errand.title}`}
                            title="这次不行"
                            className="inline-flex h-7 items-center gap-1 rounded px-2 text-danger transition-colors hover:bg-danger/10"
                            onClick={() => void resolveErrandApproval(errand.id, approval.id, false)}
                          >
                            <X size={13} aria-hidden="true" />
                            这次不行
                          </button>
                          <button
                            type="button"
                            aria-label={`追问${errand.title}为什么需要审批`}
                            title="为什么需要审批"
                            className="inline-flex h-7 items-center gap-1 rounded px-2 text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
                            onClick={() => void (onAsk ?? askButler)(approvalQuestion(errand, request))}
                          >
                            <CircleHelp size={12} aria-hidden="true" />
                            为什么？
                          </button>
                          {approvalIndex === 0 ? (
                            <button
                              type="button"
                              aria-label={`叫停${errand.title}`}
                              title="叫停"
                              className="inline-flex h-7 items-center gap-1 rounded px-2 text-danger transition-colors hover:bg-danger/10"
                              onClick={() => void stopErrand(errand.id)}
                            >
                              <Square size={11} aria-hidden="true" />
                              叫停
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  </div>
                  {inputs.length > 0 && errand.approvals.length === 0 ? (
                    <button
                      type="button"
                      aria-label={`叫停${errand.title}`}
                      title="叫停"
                      className="mt-2 inline-flex h-7 items-center gap-1 rounded px-2 text-danger transition-colors hover:bg-danger/10"
                      onClick={() => void stopErrand(errand.id)}
                    >
                      <Square size={11} aria-hidden="true" />
                      叫停
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {sections.active.length > 0 ? (
        <section aria-label="在办">
          <h2 className={`${compact ? 'text-sm' : 'text-base'} font-semibold text-ink`}>在办</h2>
          <div className="mt-2 divide-y divide-line/60">
            {sections.active.map((errand) => {
              const isExpanded = expanded.has(errand.id);
              const replied = errand.status === 'replied';
              const failed = errand.status === 'failed';
              const terminal = replied || failed;
              const paused = errand.status === 'paused';
              const conclusion = errand.reply ?? errand.error ?? '这个活没留下结论。';

              return (
                <article key={errand.id} className="group py-2.5 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(errand.id)}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? `折叠${errand.title}` : `展开${errand.title}`}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <ActiveIcon errand={errand} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{errand.title}</span>
                      <span className="hidden shrink-0 text-xs text-ink-2 sm:inline">{activeProgress(errand)}</span>
                      <span className="hidden shrink-0 text-xs text-ink-3 md:inline">
                        {elapsedMinutes(errand.startedAt, now)} 分钟
                      </span>
                      {replied ? <span className="shrink-0 text-xs text-primary">回话了</span> : null}
                      {failed ? <span className="shrink-0 text-xs text-danger">没办成</span> : null}
                      {paused ? <span className="shrink-0 text-xs text-ink-3">已暂停</span> : null}
                      <ChevronDown
                        size={14}
                        aria-hidden="true"
                        className={`shrink-0 text-ink-3 transition-transform motion-reduce:transition-none ${
                          isExpanded ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    {!terminal ? (
                      <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                        {paused ? (
                          <button
                            type="button"
                            aria-label={`继续${errand.title}`}
                            title="继续"
                            onClick={() => void resumeErrand(errand.id)}
                            className="flex h-7 w-7 items-center justify-center rounded text-ink-3 hover:bg-primary-light hover:text-primary"
                          >
                            <Play size={11} aria-hidden="true" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`叫停${errand.title}`}
                          title="叫停"
                          onClick={() => void stopErrand(errand.id)}
                          className="flex h-7 w-7 items-center justify-center rounded text-ink-3 hover:bg-danger/10 hover:text-danger"
                        >
                          <Square size={11} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {isExpanded ? (
                    <div className="ml-6 mt-3 border-l border-line pl-4 text-xs leading-5 text-ink-2">
                      {terminal ? (
                        <>
                          <div className="whitespace-pre-wrap">{conclusion}</div>
                          <button
                            type="button"
                            aria-label={`收下${errand.title}`}
                            title="收下并归档"
                            className="mt-3 inline-flex h-7 items-center gap-1 rounded px-2 text-primary transition-colors hover:bg-primary-light"
                            onClick={() => void archiveErrand(errand.id)}
                          >
                            <Archive size={12} aria-hidden="true" />
                            收下
                          </button>
                        </>
                      ) : (
                        <>
                          <div>{errand.activity ?? '正在处理'}</div>
                          {paused ? (
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                aria-label={`继续${errand.title}`}
                                title="继续"
                                className="inline-flex h-7 items-center gap-1 rounded px-2 text-primary transition-colors hover:bg-primary-light"
                                onClick={() => void resumeErrand(errand.id)}
                              >
                                <Play size={12} aria-hidden="true" />
                                继续
                              </button>
                              <button
                                type="button"
                                aria-label={`叫停${errand.title}`}
                                title="叫停"
                                className="inline-flex h-7 items-center gap-1 rounded px-2 text-danger transition-colors hover:bg-danger/10"
                                onClick={() => void stopErrand(errand.id)}
                              >
                                <Square size={11} aria-hidden="true" />
                                叫停
                              </button>
                            </div>
                          ) : null}
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
                              <pre className="max-h-16 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                                {errand.traces.slice(-2).map((trace) => trace.text).join('\n')}
                              </pre>
                            </div>
                          ) : null}
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {errand.threadId ? (
                              <button
                                type="button"
                                title={`复制 codex resume ${errand.threadId}`}
                                aria-label={`复制 codex resume ${errand.threadId}`}
                                className="inline-flex h-7 items-center gap-1 rounded px-2 font-mono text-[11px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
                                onClick={() => void copyResumeCommand(errand.threadId)}
                              >
                                <Copy size={11} aria-hidden="true" />
                                codex resume
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
