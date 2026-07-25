import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { useEffect } from 'react';
import { currentErrandActivity, errandRunIsCurrent, latestCodexReply } from '../lib/butlerErrands';
import { codexApprovalSummary } from '../lib/codexApprovalSummary';
import { useButler } from '../stores/butler';
import { useLocalCodex } from '../stores/localCodex';
import { useUI } from '../stores/ui';

/**
 * 在办的活：管家替你去执行间干活，进度、点头与结论都留在管家页。
 *
 * 这里刻意不做「干完了没有」的判断——把 Codex 说的话原样端上来，
 * 由你看内容定夺。此前那句「有结果了」在活卡住时也会响，等于说谎。
 */
export default function ButlerErrandRunCard() {
  const errandRun = useButler((state) => state.errandRun);
  const setErrandRun = useButler((state) => state.setErrandRun);
  const dismissErrandRun = useButler((state) => state.dismissErrandRun);
  const status = useLocalCodex((state) => state.status);
  const threadId = useLocalCodex((state) => state.threadId);
  const approvals = useLocalCodex((state) => state.approvals);
  // 订阅 traces 以便进度变化时重算「它在干什么」
  const traces = useLocalCodex((state) => state.traces);
  const resolveApproval = useLocalCodex((state) => state.resolveApproval);
  const stopCodex = useLocalCodex((state) => state.stop);
  const codexError = useLocalCodex((state) => state.error);
  const setModule = useUI((state) => state.setModule);

  const current = errandRun ? errandRunIsCurrent(errandRun, threadId) : false;
  const settled = Boolean(errandRun?.outcome);

  // 回合结束就把 Codex 的最终回复收上来定格；线程被换掉则不再冒充它汇报
  useEffect(() => {
    if (!errandRun || settled) return;
    if (!current) {
      setErrandRun({ ...errandRun, outcome: 'stopped' });
      return;
    }
    if (status === 'running' || status === 'starting') return;
    setErrandRun({
      ...errandRun,
      outcome: status === 'ready' ? 'replied' : 'stopped',
      ...(latestCodexReply() ? { reply: latestCodexReply() } : {}),
    });
  }, [errandRun, settled, current, status, setErrandRun]);

  if (!errandRun) return null;

  const running = current && !settled && (status === 'running' || status === 'starting');
  const waiting = running && approvals.length > 0;

  const activity = running && traces.length ? currentErrandActivity() : undefined;

  const statusLabel = (): string => {
    if (waiting) return '等你点头';
    if (running) return activity ?? '正在干';
    if (errandRun.outcome === 'stopped') return '停下来了';
    return '回话了';
  };

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span>派出去的活</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-normal ${
                waiting
                  ? 'bg-warning/15 text-warning'
                  : running
                    ? 'bg-primary-light/60 text-primary'
                    : errandRun.outcome === 'stopped'
                      ? 'bg-fill text-ink-2'
                      : 'bg-success/15 text-success'
              }`}
            >
              {statusLabel()}
            </span>
          </h2>
          <div className="mt-1.5 truncate text-sm text-ink">{errandRun.title}</div>
          <div className="mt-0.5 text-xs text-ink-3">
            在「{errandRun.workspaceName}」{errandRun.readOnly ? ' · 只看不改' : ''}
          </div>
        </div>
        {running ? (
          <Loader2 size={16} className="mt-1 shrink-0 animate-spin text-primary" />
        ) : null}
      </div>

      {approvals.length > 0 && current ? (
        <div className="mt-3 flex flex-col gap-2">
          {approvals.map((approval) => (
            <div key={approval.id} className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <div className="text-xs font-medium text-ink">要做这件事，你看行吗</div>
              <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-[11px] leading-5 text-ink-2">
                {codexApprovalSummary(approval.method, approval.params)}
              </pre>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => resolveApproval(approval.id, true)}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-white hover:bg-primary-hover"
                >
                  <Check size={12} />
                  可以
                </button>
                <button
                  type="button"
                  onClick={() => resolveApproval(approval.id, false)}
                  className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink-2 hover:bg-fill-hover"
                >
                  <X size={12} />
                  别做
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {errandRun.reply ? (
        <div className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2">
          <div className="max-h-56 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-ink">
            {errandRun.reply}
          </div>
        </div>
      ) : null}

      {settled && !errandRun.reply ? (
        <p className="mt-3 text-sm text-ink-2">
          {codexError ?? '这个活没留下结论，去执行间看看卡在哪。'}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setModule('codex')}
          className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink-2 hover:bg-fill-hover"
        >
          <ExternalLink size={12} />
          看细节
        </button>
        {running ? (
          <button
            type="button"
            onClick={() => void stopCodex()}
            className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink-2 hover:bg-fill-hover"
          >
            叫停
          </button>
        ) : (
          <button
            type="button"
            onClick={dismissErrandRun}
            className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink-2 hover:bg-fill-hover"
          >
            知道了
          </button>
        )}
      </div>
    </section>
  );
}
