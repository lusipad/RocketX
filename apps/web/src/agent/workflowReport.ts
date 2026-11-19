import type {
  ButlerMemoryEntry,
  NativeWorkCard,
  NativeWorkEvidence,
  NativeWorkLink,
  NativeWorkSessionRecord,
} from '../platform/desktopCommands';
import type { AcpManagedSessionState } from '../stores/acpAgents';
import { useButlerMemory } from '../stores/butlerMemory';
import { useWorkLedger } from '../stores/workLedger';
import { publishWorkReport } from './externalWorkActions';
import type { NativeDispatchActionRecord } from '../platform/desktopCommands';

export type WorkflowReportStatus =
  | 'completed'
  | 'in_progress'
  | 'verifying'
  | 'blocked'
  | 'waiting'
  | 'failed';

export interface WorkflowPlanItem {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface WorkflowKeyChangeItem {
  title: string;
  kind: string;
  status: string;
  detail?: string;
  locations?: string[];
}

export interface WorkflowEvidenceSummary {
  id: string;
  title: string;
  kind: string;
  passed: boolean;
  stale: boolean;
  summary?: string | null;
  headSha?: string | null;
}

export interface WorkflowExecutionReport {
  id: string;
  title: string;
  status: WorkflowReportStatus;
  statusLabel: string;
  summary: string;
  progressPercent: number | null;
  planBreakdown: WorkflowPlanItem[];
  keyChanges: WorkflowKeyChangeItem[];
  evidences: WorkflowEvidenceSummary[];
  risksAndBlockers: string[];
  nextActions: string[];
  todoId: string | null;
  sessionId: string | null;
  workspaceRoot: string | null;
  generatedAt: number;
  requirementsVersion: number | null;
  contentVersion: number | null;
  markdown: string;
}

export interface BuildWorkflowReportInput {
  card?: NativeWorkCard | null;
  acpSession?: AcpManagedSessionState | null;
  sessions?: NativeWorkSessionRecord[];
  evidences?: NativeWorkEvidence[];
  links?: NativeWorkLink[];
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function reportSnapshotId(snapshot: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(snapshot)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `rpt-v2-${hash.toString(16).padStart(16, '0')}-${snapshot.length}`;
}

function computeStatus(input: BuildWorkflowReportInput): {
  status: WorkflowReportStatus;
  statusLabel: string;
} {
  const { card, acpSession } = input;
  if (acpSession?.status === 'error') {
    return { status: 'failed', statusLabel: '执行异常' };
  }
  if (acpSession && acpSession.pendingPermissions.length > 0) {
    return { status: 'waiting', statusLabel: '等待审批确认' };
  }
  if (card?.state.waitState === 'blocked') {
    return { status: 'blocked', statusLabel: '已阻塞' };
  }
  if (
    card?.state.waitState === 'waiting_input' ||
    card?.state.waitState === 'waiting_approval' ||
    card?.state.waitState === 'waiting_external'
  ) {
    return { status: 'waiting', statusLabel: '等待响应' };
  }
  if (card?.state.stage === 'done') {
    return { status: 'completed', statusLabel: '已完成' };
  }
  if (card?.state.stage === 'verifying') {
    return { status: 'verifying', statusLabel: '核验中' };
  }
  if (
    acpSession &&
    (acpSession.status === 'ready' || acpSession.status === 'stopped') &&
    acpSession.turnCount > 0 &&
    !card
  ) {
    return { status: 'completed', statusLabel: '本轮已完成' };
  }
  return { status: 'in_progress', statusLabel: '推进中' };
}

export function buildWorkflowExecutionReport(
  input: BuildWorkflowReportInput,
): WorkflowExecutionReport {
  const now = Date.now();
  const card = input.card ?? null;
  // 工作身份是汇报边界，调用者的界面焦点不能把其他工作的内容带进来。
  const acp = input.acpSession && (!card || input.acpSession.linkedTodoId === card.id)
    ? input.acpSession
    : null;
  const todoId = card?.id ?? acp?.linkedTodoId ?? null;
  const ledgerSessions = (input.sessions ?? []).filter((item) => todoId && item.todoId === todoId);
  const rawEvidences = (input.evidences ?? []).filter((item) => todoId && item.todoId === todoId);
  const rawLinks = (input.links ?? []).filter((item) => todoId && item.todoId === todoId);

  const title =
    card?.title ||
    acp?.title ||
    ledgerSessions[0]?.title ||
    '工作流执行汇报';

  const { status, statusLabel } = computeStatus({ card, acpSession: acp });

  const planBreakdown: WorkflowPlanItem[] = [];
  if (acp && acp.plan.length > 0) {
    for (const entry of acp.plan) {
      planBreakdown.push({
        content: entry.content,
        priority: entry.priority,
        status: entry.status,
      });
    }
  } else if (card && card.state.acceptance.length > 0) {
    for (const criterion of card.state.acceptance) {
      planBreakdown.push({
        content: criterion,
        priority: 'medium',
        status: 'pending',
      });
    }
  }

  const completedPlanCount = acp?.plan.filter((item) => item.status === 'completed').length ?? 0;
  const progressPercent = acp?.plan.length
    ? clampPercent(completedPlanCount / acp.plan.length * 100)
    : null;

  const keyChanges: WorkflowKeyChangeItem[] = [];
  if (acp) {
    for (const tc of acp.toolCalls) {
      const locations = tc.locations?.map((loc) =>
        loc.line ? `${loc.path}:${loc.line}` : loc.path,
      );
      keyChanges.push({
        title: tc.title,
        kind: tc.kind ?? 'other',
        status: tc.status ?? 'completed',
        locations: locations && locations.length > 0 ? locations : undefined,
      });
    }
    const lastAssistant = [...acp.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.text.trim().length > 0);
    if (lastAssistant && keyChanges.length === 0) {
      keyChanges.push({
        title: '代理输出结论',
        kind: 'assistant_output',
        status: 'completed',
        detail: lastAssistant.text.slice(0, 220),
      });
    }
  }
  for (const link of rawLinks.slice(0, 6)) {
    keyChanges.push({
      title: link.title || `${link.kind}: ${link.externalId}`,
      kind: link.kind,
      status: link.stateSnapshot || 'linked',
      detail: link.webUrl || (link.headSha ? `HEAD ${link.headSha.slice(0, 8)}` : undefined),
    });
  }

  const evidences: WorkflowEvidenceSummary[] = rawEvidences.map((ev) => ({
    id: ev.id,
    title: ev.title,
    kind: ev.kind,
    passed: ev.passed,
    stale: ev.stale,
    summary: ev.summary,
    headSha: ev.headSha,
  }));

  const risksAndBlockers: string[] = [];
  if (card?.state.waitReason) {
    risksAndBlockers.push(card.state.waitReason);
  }
  if (acp?.error) {
    risksAndBlockers.push(`ACP 会话报错：${acp.error}`);
  }
  if (acp && acp.pendingPermissions.length > 0) {
    risksAndBlockers.push(
      `存在 ${acp.pendingPermissions.length} 项待审批的工具权限请求`,
    );
  }
  const staleCount = evidences.filter((e) => e.stale).length;
  if (staleCount > 0) {
    risksAndBlockers.push(`有 ${staleCount} 项既有验收证据已过期，需要重新核验`);
  }
  const failedEvCount = evidences.filter((e) => e.kind !== 'agent_report' && !e.passed && !e.stale).length;
  if (failedEvCount > 0) {
    risksAndBlockers.push(`有 ${failedEvCount} 项验证记录未通过`);
  }
  if (card && card.state.consecutiveFailures > 0) {
    risksAndBlockers.push(`最近已累计连续失败 ${card.state.consecutiveFailures} 次`);
  }

  const nextActions: string[] = [];
  if (acp && acp.pendingPermissions.length > 0) {
    nextActions.push('在 ACP 工作区中审批或拒绝挂起的权限请求');
  }
  if (card?.state.nextStep?.trim()) {
    nextActions.push(card.state.nextStep.trim());
  }
  const validEvCount = evidences.filter((e) => e.kind !== 'agent_report' && e.passed && !e.stale).length;
  if (card && card.state.stage !== 'done' && validEvCount === 0) {
    nextActions.push('运行测试或构建核验并登记一条有效验收证据');
  }
  if (nextActions.length === 0) {
    nextActions.push(
      status === 'completed'
        ? '可归档本次结论到长期记忆，或在讨论室同步最终结果'
        : '继续跟进当前阶段产物并确认剩余计划项',
    );
  }

  const lastAssistantText = acp
    ? [...acp.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.text.trim())
        ?.text.trim()
    : undefined;

  const summaryParts: string[] = [
    `「${title}」当前状态为${statusLabel}`,
  ];
  if (progressPercent !== null) {
    summaryParts.push(`计划完成 ${completedPlanCount}/${planBreakdown.length} 项（${progressPercent}%）`);
  } else if (planBreakdown.length > 0) {
    summaryParts.push(`验收条件 ${planBreakdown.length} 项，尚未逐项确认`);
  }
  if (evidences.length > 0) {
    summaryParts.push(`有效验证证据 ${validEvCount} 项`);
  }
  if (lastAssistantText) {
    const brief = lastAssistantText.replace(/\s+/g, ' ').slice(0, 140);
    summaryParts.push(`最新结论：${brief}${lastAssistantText.length > 140 ? '…' : ''}`);
  }
  const summary = `${summaryParts.join('；')}。`;

  const workspaceRoot =
    acp?.workspaceRoot ?? ledgerSessions[0]?.workspaceRoot ?? null;
  const sessionId = acp?.acpSessionId ?? ledgerSessions[0]?.id ?? null;

  const mdLines: string[] = [
    '# 工作流执行汇报',
    '',
    `- **任务主题**：${title}`,
    `- **当前状态**：${statusLabel}`,
    ...(progressPercent !== null
      ? [`- **计划步骤**：完成 ${completedPlanCount}/${planBreakdown.length} 项（${progressPercent}%）`]
      : []),
    ...(workspaceRoot ? [`- **工作区**：\`${workspaceRoot}\``] : []),
    '',
    '## 核心结论',
    summary,
    '',
    progressPercent === null && planBreakdown.length > 0 ? '## 验收条件（尚未逐项确认）' : '## 计划步骤',
    ...(planBreakdown.length > 0
      ? planBreakdown.map((item) => {
          const mark =
            item.status === 'completed'
              ? '[x]'
              : item.status === 'in_progress'
                ? '[-]'
                : '[ ]';
          return `- ${mark} (${item.priority}) ${item.content}`;
        })
      : ['- 暂无结构化计划拆解条目']),
    '',
    '## 关键产出与工具执行',
    ...(keyChanges.length > 0
      ? keyChanges.map((item) => {
          const loc = item.locations?.length ? ` (${item.locations.join(', ')})` : '';
          const detail = item.detail ? `：${item.detail}` : '';
          return `- [${item.status}] \`${item.kind}\` ${item.title}${loc}${detail}`;
        })
      : ['- 暂无工具执行或代码产出记录']),
    '',
    '## 验证证据',
    ...(evidences.length > 0
      ? evidences.map((ev) => {
          const tag = ev.stale ? '已过期' : ev.kind === 'agent_report' ? '说明记录' : ev.passed ? '通过' : '未通过';
          const sha = ev.headSha ? ` @ ${ev.headSha.slice(0, 8)}` : '';
          const note = ev.summary ? ` — ${ev.summary}` : '';
          return `- [${tag}] (${ev.kind}) ${ev.title}${sha}${note}`;
        })
      : ['- 暂无已登记的验证证据']),
    '',
    '## 待确认与风险',
    ...(risksAndBlockers.length > 0
      ? risksAndBlockers.map((r) => `- ${r}`)
      : ['- 暂无阻塞或异常风险']),
    '',
    '## 下一步建议',
    ...nextActions.map((act) => `- ${act}`),
  ];

  const markdown = mdLines.join('\n');
  return {
    // 重载/账本 hydrate 仅更换对象和生成时间，不能创建第二次投递身份。
    id: reportSnapshotId(JSON.stringify([todoId, card?.state.requirementsVersion ?? null,
      card?.state.contentVersion ?? null, sessionId, workspaceRoot, markdown])),
    title,
    status,
    statusLabel,
    summary,
    progressPercent,
    planBreakdown,
    keyChanges,
    evidences,
    risksAndBlockers,
    nextActions,
    todoId: card?.id ?? acp?.linkedTodoId ?? null,
    sessionId,
    workspaceRoot,
    generatedAt: now,
    requirementsVersion: card?.state.requirementsVersion ?? null,
    contentVersion: card?.state.contentVersion ?? null,
    markdown,
  };
}

export async function recordReportAsWorkEvidence(
  todoId: string,
  report: WorkflowExecutionReport,
): Promise<NativeWorkEvidence> {
  const validSha = report.evidences.find((e) => e.headSha && !e.stale)?.headSha ?? null;
  if (report.todoId !== todoId) throw new Error('汇报与工作归属不一致，未登记');
  return useWorkLedger.getState().addEvidence({
    todoId,
    sessionId: report.sessionId,
    kind: 'agent_report',
    title: `工作流汇报：${report.title}`,
    summary: report.summary,
    headSha: validSha,
    workspaceRoot: report.workspaceRoot,
    webUrl: null,
    // 汇报是对已有事实的说明，不能成为它所描述工作的通过依据。
    passed: false,
  });
}

export async function distillReportToMemory(
  report: WorkflowExecutionReport,
  workspaceRoot?: string | null,
): Promise<ButlerMemoryEntry> {
  const nextStepSuffix =
    report.nextActions.length > 0
      ? `；后续建议：${report.nextActions.slice(0, 2).join('；')}`
      : '';
  return useButlerMemory.getState().upsertMemory({
    category: 'episodic_summary',
    title: `工作流总结：${report.title}`,
    content: `${report.summary}${nextStepSuffix}`,
    tags: ['workflow-report', report.status],
    workspaceRoot: workspaceRoot !== undefined ? workspaceRoot : report.workspaceRoot,
    sourceKind: 'workflow_report',
    sourceRef: report.id,
    confidence: 0.85,
  });
}

export async function postWorkflowReportToRoom(
  rid: string,
  report: WorkflowExecutionReport,
  options?: { userConfirmed?: boolean; retry?: boolean },
): Promise<{ ok: boolean; messageId?: string; action: NativeDispatchActionRecord }> {
  const targetRid = rid.trim();
  if (!targetRid) {
    throw new Error('请先选择要发送汇报的 Rocket.Chat 讨论室');
  }
  if (!report.todoId) throw new Error('请先将汇报关联到工作，再发送到讨论室');
  const action = await publishWorkReport({
    workId: report.todoId, rid: targetRid, reportId: report.id, reportTitle: report.title,
    reportGeneratedAt: report.generatedAt, markdown: report.markdown,
    requirementsVersion: report.requirementsVersion ?? undefined, contentVersion: report.contentVersion ?? undefined,
    userConfirmed: options?.userConfirmed, retry: options?.retry,
  });
  const receipt = action.receiptRef ? JSON.parse(action.receiptRef) as { messageIds?: string[] } : null;
  return { ok: action.state === 'acknowledged' || action.state === 'completed', messageId: receipt?.messageIds?.[0], action };
}
