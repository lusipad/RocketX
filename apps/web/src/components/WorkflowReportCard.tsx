import {
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  Circle,
  ClipboardCopy,
  FileCheck2,
  Loader2,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  distillReportToMemory,
  postWorkflowReportToRoom,
  recordReportAsWorkEvidence,
  type WorkflowExecutionReport,
  type WorkflowReportStatus,
} from '../agent/workflowReport';
import { useChat } from '../stores/chat';
import { useWorkLedger } from '../stores/workLedger';
import { readExternalActionSpec, reconcileExternalWorkActions } from '../agent/externalWorkActions';
import { toast } from '../stores/toast';

export interface WorkflowReportCardProps {
  report: WorkflowExecutionReport;
  compact?: boolean;
  onEvidenceRecorded?: () => void;
  onMemoryDistilled?: () => void;
  onPostedToRoom?: (rid: string) => void;
}

const STATUS_STYLE_MAP: Record<
  WorkflowReportStatus,
  { badgeClass: string; barClass: string }
> = {
  completed: {
    badgeClass: 'border-success/30 bg-success/10 text-success',
    barClass: 'bg-success',
  },
  verifying: {
    badgeClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
    barClass: 'bg-cyan-500',
  },
  in_progress: {
    badgeClass: 'border-primary/30 bg-primary/10 text-primary',
    barClass: 'bg-primary',
  },
  waiting: {
    badgeClass: 'border-warning/30 bg-warning/10 text-warning',
    barClass: 'bg-warning',
  },
  blocked: {
    badgeClass: 'border-danger/30 bg-danger/10 text-danger',
    barClass: 'bg-danger',
  },
  failed: {
    badgeClass: 'border-danger/30 bg-danger/10 text-danger',
    barClass: 'bg-danger',
  },
};

export default function WorkflowReportCard({
  report,
  compact = false,
  onEvidenceRecorded,
  onMemoryDistilled,
  onPostedToRoom,
}: WorkflowReportCardProps) {
  const rooms = useChat((state) => state.rooms);
  const subscriptions = useChat((state) => state.subscriptions);
  const activeRid = useChat((state) => state.activeRid);
  const actions = useWorkLedger((state) => state.actions);

  const [copied, setCopied] = useState(false);
  const [recordingEvidence, setRecordingEvidence] = useState(false);
  const [distillingMemory, setDistillingMemory] = useState(false);
  const [roomComposerOpen, setRoomComposerOpen] = useState(false);
  const [targetRid, setTargetRid] = useState<string>('');
  const [postingRoom, setPostingRoom] = useState(false);

  const roomOptions = useMemo(() => {
    const merged = new Map<string, { rid: string; label: string }>();
    for (const sub of Object.values(subscriptions)) {
      if (!sub.rid) continue;
      merged.set(sub.rid, {
        rid: sub.rid,
        label: rooms[sub.rid]?.fname || sub.fname || sub.name || sub.rid,
      });
    }
    return [...merged.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }, [rooms, subscriptions]);

  const persistedReports = actions.flatMap((action) => {
    const spec = readExternalActionSpec(action);
    return spec?.kind === 'rc_report' && spec.reportId === report.id && spec.workId === report.todoId ? [{ action, spec }] : [];
  }).sort((a, b) => b.action.updatedAt - a.action.updatedAt);
  const effectiveRid = targetRid || persistedReports[0]?.spec.rid || activeRid || roomOptions[0]?.rid || '';
  const persistedReport = persistedReports.find((item) => item.spec.rid === effectiveRid);
  const reportAction = persistedReport?.action;
  const displayGeneratedAt = persistedReport?.spec.reportGeneratedAt ?? report.generatedAt;
  const deliveryLabel = reportAction?.state === 'acknowledged' || reportAction?.state === 'completed'
    ? '已确认送达' : reportAction?.state === 'verifying_delivery' || reportAction?.state === 'dispatched'
      ? '送达待确认' : reportAction?.state === 'awaiting_approval' ? '等待审阅确认'
        : reportAction?.state === 'failed' ? '投递失败或冲突' : '汇报草稿';
  const style = STATUS_STYLE_MAP[report.status];
  const generatedTime = useMemo(
    () =>
      new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(displayGeneratedAt),
    [displayGeneratedAt],
  );

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(report.markdown);
      setCopied(true);
      toast.success('已复制工作流汇报 Markdown');
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      toast.error(error, '复制汇报失败');
    }
  };

  const handleRecordEvidence = async () => {
    if (!report.todoId) {
      toast.info('当前汇报尚未绑定工作卡片，无法登记验收证据');
      return;
    }
    setRecordingEvidence(true);
    try {
      await recordReportAsWorkEvidence(report.todoId, report);
      toast.success('已保存汇报记录；此记录不会自动通过验收');
      onEvidenceRecorded?.();
    } catch (error) {
      toast.error(error, '登记验收证据失败');
    } finally {
      setRecordingEvidence(false);
    }
  };

  const handleDistillMemory = async () => {
    setDistillingMemory(true);
    try {
      await distillReportToMemory(report, report.workspaceRoot);
      toast.success('已将工作流结论沉淀到长期记忆');
      onMemoryDistilled?.();
    } catch (error) {
      toast.error(error, '沉淀长期记忆失败');
    } finally {
      setDistillingMemory(false);
    }
  };

  const handleConfirmPostToRoom = async () => {
    if (!effectiveRid) {
      toast.error('没有可用的 Rocket.Chat 讨论室');
      return;
    }
    setPostingRoom(true);
    try {
      const result = await postWorkflowReportToRoom(effectiveRid, report, { userConfirmed: true, retry: true });
      if (result.ok) {
        toast.success('汇报已由目标服务器确认送达');
        setRoomComposerOpen(false);
        onPostedToRoom?.(effectiveRid);
      } else {
        toast.info(result.action.errorMessage || '汇报送达待确认，请先核对原讨论室');
      }
    } catch (error) {
      toast.error(error, '发送汇报失败');
    } finally {
      setPostingRoom(false);
    }
  };

  return (
    <section
      aria-label="工作流执行汇报"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface-4 p-4 shadow-raise"
    >
      {/* 头部：状态徽章、标题、进度条 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-2xs font-semibold ${style.badgeClass}`}
            >
              {report.status === 'completed' ? (
                <CheckCircle2 size={11} aria-hidden="true" />
              ) : report.status === 'in_progress' ? (
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              ) : (
                <AlertTriangle size={11} aria-hidden="true" />
              )}
              <span>{report.statusLabel}</span>
            </span>
            <span className="text-xs text-ink-3">生成于 {generatedTime}</span>
          </div>
          <h3 className="mt-1.5 break-words text-sm font-semibold text-ink">
            {report.title}
          </h3>
        </div>
        <div className="shrink-0 text-right">
          {report.progressPercent !== null ? (
            <>
              <div className="font-mono text-sm font-bold text-ink">{report.progressPercent}%</div>
              <div className="text-xs text-ink-3">计划步骤完成比例</div>
            </>
          ) : <div className="text-xs text-ink-3">进度未量化</div>}
        </div>
      </div>

      {/* 完成度进度条 */}
      {report.progressPercent !== null && <div
        role="progressbar"
        aria-label="计划步骤完成比例"
        aria-valuenow={report.progressPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-fill-2"
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${style.barClass}`}
          style={{ width: `${report.progressPercent}%` }}
        />
      </div>}

      {/* 核心结论 */}
      <div className="rounded-xl border border-line-soft bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-2">
        {report.summary}
      </div>
      <div role="status" className="text-xs text-ink-3">
        <span>对外汇报：{deliveryLabel}</span>
        {reportAction?.errorMessage && <p className="mt-1 break-words">{reportAction.errorMessage}</p>}
        {(reportAction?.state === 'verifying_delivery' || reportAction?.state === 'dispatched') && (
          <button type="button" className="ml-2 text-primary hover:underline" onClick={() => void reconcileExternalWorkActions()}>核对送达</button>
        )}
      </div>

      {/* 计划拆解步骤 */}
      {report.planBreakdown.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-ink">
            {report.progressPercent === null
              ? `验收条件（尚未逐项确认）· ${report.planBreakdown.length} 项`
              : `计划步骤 (${report.planBreakdown.filter((p) => p.status === 'completed').length}/${report.planBreakdown.length})`}
          </div>
          <div className="space-y-1">
            {report.planBreakdown.map((step, index) => (
              <div
                key={`${index}-${step.content}`}
                className="flex items-start gap-2 rounded-lg border border-line-soft bg-surface-2 px-2.5 py-1.5 text-xs"
              >
                <span className="mt-0.5 shrink-0">
                  {step.status === 'completed' ? (
                    <CheckCircle2 size={13} className="text-success" />
                  ) : step.status === 'in_progress' ? (
                    <Loader2 size={13} className="animate-spin text-primary" />
                  ) : (
                    <Circle size={13} className="text-ink-3" />
                  )}
                </span>
                <span
                  className={`min-w-0 flex-1 break-words ${
                    step.status === 'completed' ? 'text-ink-3 line-through' : 'text-ink'
                  }`}
                >
                  {step.content}
                </span>
                <span className="shrink-0 rounded-full bg-fill-2 px-2 py-0.5 text-2xs font-medium text-ink-3">
                  {step.priority}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 关键产出与工具执行 */}
      {!compact && report.keyChanges.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Wrench size={12} className="text-primary" />
            <span>关键产出与执行 ({report.keyChanges.length})</span>
          </div>
          <div className="space-y-1">
            {report.keyChanges.slice(0, 8).map((change, idx) => (
              <div
                key={`${idx}-${change.title}`}
                className="rounded-lg border border-line-soft bg-surface-4 px-2.5 py-1.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">
                    {change.title}
                  </span>
                  <span className="shrink-0 rounded-full bg-fill-2 px-2 py-0.5 text-2xs text-ink-3">
                    {change.kind} · {change.status}
                  </span>
                </div>
                {change.locations && change.locations.length > 0 && (
                  <div className="mt-1 truncate font-mono text-xs text-ink-3">
                    {change.locations.join(', ')}
                  </div>
                )}
                {change.detail && (
                  <div className="mt-1 line-clamp-2 text-xs text-ink-2">{change.detail}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 验证证据 */}
      {report.evidences.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <ShieldCheck size={12} className="text-success" />
            <span>验证证据 ({report.evidences.length})</span>
          </div>
          <div className="space-y-1">
            {report.evidences.map((ev) => (
              <div
                key={ev.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-line-soft bg-surface-4 px-2.5 py-1.5 text-xs"
              >
                <span className="min-w-0 flex-1 truncate text-ink">{ev.title}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${
                    ev.stale
                      ? 'bg-warning/15 text-warning'
                      : ev.kind === 'agent_report'
                        ? 'bg-fill-2 text-ink-3'
                        : ev.passed
                        ? 'bg-success/15 text-success'
                        : 'bg-danger/15 text-danger'
                  }`}
                >
                  {ev.stale ? '已过期' : ev.kind === 'agent_report' ? '说明记录' : ev.passed ? '通过' : '失败'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 阻塞与风险 */}
      {report.risksAndBlockers.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-2.5 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-warning">
            <ShieldAlert size={13} />
            <span>待确认与风险</span>
          </div>
          <ul className="mt-1 space-y-1 text-ink-2">
            {report.risksAndBlockers.map((risk, idx) => (
              <li key={idx}>• {risk}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 下一步建议 */}
      {report.nextActions.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Sparkles size={12} className="text-primary" />
            <span>下一步建议</span>
          </div>
          <ul className="space-y-1 text-xs text-ink-2">
            {report.nextActions.map((act, idx) => (
              <li key={idx} className="rounded-lg bg-surface-2 px-2.5 py-1.5">
                {act}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 动作按钮栏 */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
        <button
          type="button"
          onClick={() => void handleCopyMarkdown()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-4 px-2.5 py-1.5 text-xs font-medium text-ink shadow-raise transition hover:bg-fill-hover"
        >
          {copied ? <Check size={12} className="text-success" /> : <ClipboardCopy size={12} />}
          <span>{copied ? '已复制' : '复制 Markdown'}</span>
        </button>

        {report.todoId && (
          <button
            type="button"
            disabled={recordingEvidence}
            onClick={() => void handleRecordEvidence()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-4 px-2.5 py-1.5 text-xs font-medium text-ink shadow-raise transition hover:bg-fill-hover disabled:opacity-50"
          >
            <FileCheck2 size={12} className="text-success" />
            <span>{recordingEvidence ? '保存中…' : '保存汇报记录'}</span>
          </button>
        )}

        <button
          type="button"
          disabled={distillingMemory}
          onClick={() => void handleDistillMemory()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-4 px-2.5 py-1.5 text-xs font-medium text-ink shadow-raise transition hover:bg-fill-hover disabled:opacity-50"
        >
          <Brain size={12} className="text-primary" />
          <span>{distillingMemory ? '沉淀中…' : '沉淀长期记忆'}</span>
        </button>

        <button
          type="button"
          disabled={!report.todoId}
          title={!report.todoId ? '请先将汇报关联到工作' : undefined}
          onClick={() => setRoomComposerOpen((prev) => !prev)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
        >
          <Send size={12} />
          <span>发送到讨论室</span>
        </button>
      </div>

      {/* 讨论室发送确认区 */}
      {roomComposerOpen && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-ink">确认将此工作流汇报发送到 Rocket.Chat 讨论室</span>
            <button
              type="button"
              onClick={() => setRoomComposerOpen(false)}
              className="rounded p-0.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
              aria-label="取消发送"
            >
              <X size={13} />
            </button>
          </div>
          <p className="mt-2 text-ink-2">请确认目标讨论室及上方完整汇报均可向该讨论室成员公开。投递使用当前连接账号，原始快照和送达回执会随工作保留。</p>
          {roomOptions.length > 0 ? (
            <div className="mt-2 flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-ink-2">
                目标讨论室
                <select aria-label="汇报目标讨论室" value={effectiveRid} onChange={(event) => setTargetRid(event.target.value)} className="rounded-lg border border-line bg-surface-4 px-2 py-1.5 text-ink">
                  {roomOptions.map((room) => <option key={room.rid} value={room.rid}>#{room.label}</option>)}
                </select>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {roomOptions.slice(0, 8).map((room) => (
                  <button
                    key={room.rid}
                    type="button"
                    onClick={() => setTargetRid(room.rid)}
                    className={`rounded-lg border px-2 py-1 text-xs transition ${
                      effectiveRid === room.rid
                        ? 'border-primary bg-primary/15 font-semibold text-primary'
                        : 'border-line bg-surface-4 text-ink-2 hover:bg-fill-hover'
                    }`}
                  >
                    #{room.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRoomComposerOpen(false)}
                  className="rounded-lg border border-line bg-surface-4 px-2.5 py-1 text-xs text-ink-2 hover:bg-fill-hover"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={postingRoom || !effectiveRid}
                  onClick={() => void handleConfirmPostToRoom()}
                  className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  <Send size={11} />
                  <span>{postingRoom ? '发送中…' : '确认发送汇报'}</span>
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-ink-3">
              当前处于未连接状态或暂无已加入的讨论室，连接 Rocket.Chat 后即可一键同步汇报。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
