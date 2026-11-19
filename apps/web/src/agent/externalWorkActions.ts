import { RcApiError } from '@rcx/rc-client';
import { loadWorkbenchConfig } from '../lib/ado';
import { directGetWorkItem, directSetWorkItemStateControlled, isControlledWorkItemStateOutcomeUnknown } from '../lib/adoDirect';
import { getPublicSetting, getServerBase, rest } from '../lib/client';
import { normalizeMessageMaxAllowedSize, toSendableMessageChunks } from '../lib/messageChunks';
import type { NativeDispatchActionRecord, NativeWorkCard } from '../platform/desktopCommands';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { useWorkLedger } from '../stores/workLedger';
import { createExternalActionExecutor, readExternalActionSpec, type AdoStateActionSpec, type ExternalActionActor, type ExternalActionSpec, type ReportActionSpec } from './externalActionExecutor';
import { evaluateCardCompletionGate } from './workCoordinator';
import { observeWorkArtifacts } from './workArtifacts';

export async function withExternalActionDeadline<T>(operation: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('外部请求超时，结果待回读确认')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function currentActor(): ExternalActionActor {
  const auth = useAuth.getState();
  return {
    userId: auth.user?._id ?? 'local-user',
    server: getServerBase() || 'same-origin',
    adoAccount: loadWorkbenchConfig()?.account ?? '',
  };
}

function cardFor(workId: string): NativeWorkCard {
  const card = useWorkLedger.getState().cards.find((item) => item.id === workId);
  if (!card) throw new Error('工作不存在，请重新打开工作后操作');
  return card;
}

function configFor(spec: AdoStateActionSpec) {
  const config = loadWorkbenchConfig();
  if (!config?.adoBase || config.adoBase !== spec.adoBase || config.account !== spec.actor.adoAccount) {
    throw new Error('ADO 连接或操作者已改变，未使用新账号执行旧动作');
  }
  return { adoBase: config.adoBase, pat: config.pat ?? '', auth: config.auth };
}

const executor = createExternalActionExecutor({
  prepare: (spec, approved) => useWorkLedger.getState().prepareDispatchAction({
    idempotencyKey: spec.operationId,
    todoId: spec.workId,
    actionKind: spec.kind,
    specJson: JSON.stringify(spec),
    baselineMarker: `requirements:${spec.requirementsVersion}`,
    // 手工确认的汇报走审批记录，不占用自主推进预算。
    requireConfirmation: !approved || spec.kind === 'rc_report' && spec.sharedContentReviewed === true,
  }),
  transition: (action, state, receipt, errorMessage) => useWorkLedger.getState().transitionDispatchAction({
    id: action.id,
    state,
    receiptRef: receipt ? JSON.stringify({ ...readReceipt(action), ...receipt }) : undefined,
    errorMessage,
    // The ledger checks this state atomically before changing ownership.
    expectedState: action.state,
  }),
  validate: async (spec, mode = 'send') => {
    const actor = currentActor();
    if (actor.userId !== spec.actor.userId || actor.server !== spec.actor.server) throw new Error('账号或服务器已改变，拒绝处理其他账号的外部动作');
    if (mode === 'send' && spec.kind === 'ado_state_write' && /^(closed|done|resolved|已关闭|已完成|已解决|已修复)$/i.test(spec.targetState)) {
      await observeWorkArtifacts(spec.workId);
      const latestActor = currentActor();
      if (latestActor.userId !== spec.actor.userId || latestActor.server !== spec.actor.server) throw new Error('核对成果期间账号已改变');
    }
    const card = cardFor(spec.workId);
    if (mode === 'send') {
      if ((card.state.requirementsVersion ?? 0) !== spec.requirementsVersion || card.state.projectKey !== spec.projectKey) throw new Error('工作要求版本或项目已改变，请重新审阅并生成动作');
      if (spec.contentVersion !== undefined && spec.contentVersion !== (card.state.contentVersion ?? 0)) throw new Error('工作成果已改变，请重新核验并生成动作');
      if (card.state.waitState === 'paused' || card.state.waitState === 'canceled' || card.state.autonomyMode === 'readonly') throw new Error('工作已暂停、取消或只读，未执行外部写入');
    }
    if (spec.kind === 'ado_state_write') {
      configFor(spec);
      if (card.adoWorkItemId !== spec.workItemId) throw new Error('ADO 工作项与当前工作关联不一致');
      if (mode === 'send' && /^(closed|done|resolved|已关闭|已完成|已解决|已修复)$/i.test(spec.targetState)) {
        const gate = evaluateCardCompletionGate(card, useWorkLedger.getState().evidences);
        if (!gate.canMarkDone) throw new Error(`当前工作尚未通过验收，未将 ADO 更新为完成：${gate.reason}`);
      }
      return;
    }
    const auth = useAuth.getState();
    if (auth.localMode || auth.status !== 'authed' || !auth.user) throw new Error('请先连接 Rocket.Chat，再核对或投递汇报');
    const sub = Object.values(useChat.getState().subscriptions).find((item) => item.rid === spec.rid);
    if (!sub) throw new Error('当前账号未加入目标讨论室，未发送汇报');
    const action = useWorkLedger.getState().actions.find((item) => item.idempotencyKey === spec.operationId);
    const review = action && readReceipt(action).review as { actorId?: string; reportId?: string; rid?: string } | undefined;
    const explicitlyReviewed = spec.sharedContentReviewed || review?.actorId === actor.userId && review?.reportId === spec.reportId && review?.rid === spec.rid;
    if (mode === 'send' && !explicitlyReviewed && (card.state.visibility !== 'room_shared' || card.rid !== spec.rid)) {
      throw new Error('私人工作或跨讨论室汇报需先审阅内容并明确确认目标');
    }
  },
  writeAdo: async (spec) => {
    const result = await directSetWorkItemStateControlled(configFor(spec), spec.workItemId, spec.targetState, { expectedRevision: spec.expectedRevision, expectedState: spec.expectedState });
    return { revision: result.item.revision, state: result.item.state };
  },
  readAdo: async (spec) => {
    const item = await directGetWorkItem(configFor(spec), spec.workItemId);
    if (!item) throw new Error('ADO 工作项不存在或当前账号无权访问');
    return { revision: item.revision, state: item.state };
  },
  sendMessage: async (spec, part) => {
    const message = await withExternalActionDeadline(rest.sendMessageRaw({ _id: part.id, rid: spec.rid, msg: part.text }));
    return { id: message._id, rid: message.rid, text: message.msg ?? '' };
  },
  readMessage: async (_spec, id) => {
    try {
      const message = await withExternalActionDeadline(rest.getMessage(id));
      return { id: message._id, rid: message.rid, text: message.msg ?? '' };
    } catch (error) {
      // Only a verified not-found is safe to treat as absence. Offline/403 is unknown.
      if (error instanceof RcApiError && (error.status === 404 ||
        error.status === 400 && ['error-message-not-found', 'error-invalid-message'].includes(error.errorType ?? ''))) return null;
      throw error;
    }
  },
  isUnknownAdoError: isControlledWorkItemStateOutcomeUnknown,
});

function readReceipt(action: NativeDispatchActionRecord): Record<string, unknown> {
  try { return action.receiptRef ? JSON.parse(action.receiptRef) as Record<string, unknown> : {}; } catch { return {}; }
}

async function markReportReviewed(action: NativeDispatchActionRecord, spec: ReportActionSpec): Promise<void> {
  const actor = currentActor();
  if (actor.userId !== spec.actor.userId || actor.server !== spec.actor.server) throw new Error('账号或服务器已改变，拒绝批准其他账号的汇报');
  await useWorkLedger.getState().transitionDispatchAction({
    id: action.id, state: action.state, expectedState: action.state,
    receiptRef: JSON.stringify({ ...readReceipt(action), review: { actorId: actor.userId, reportId: spec.reportId, rid: spec.rid, reviewedAt: Date.now() } }),
  });
}

function baseSpec(card: NativeWorkCard, operationId: string) {
  if (!operationId.trim()) throw new Error('外部动作需要稳定操作 ID');
  return {
    version: 1 as const,
    operationId,
    workId: card.id,
    requirementsVersion: card.state.requirementsVersion ?? 0,
    contentVersion: card.state.contentVersion ?? 0,
    projectKey: card.state.projectKey,
    actor: currentActor(),
    createdAt: Date.now(),
  };
}

/** UI 确认只授权该快照；Agent 工具只能使用工作已授予的自主权限。 */
export async function publishWorkReport(input: {
  workId: string;
  rid: string;
  reportId: string;
  reportTitle: string;
  reportGeneratedAt: number;
  markdown: string;
  requirementsVersion?: number;
  contentVersion?: number;
  userConfirmed?: boolean;
  retry?: boolean;
}): Promise<NativeDispatchActionRecord> {
  const card = cardFor(input.workId);
  const rid = input.rid.trim();
  if (!rid || !input.reportId.trim() || !input.markdown.trim()) throw new Error('请选择目标讨论室并生成带稳定身份的汇报');
  if (input.requirementsVersion !== undefined && input.requirementsVersion !== (card.state.requirementsVersion ?? 0) ||
      input.contentVersion !== undefined && input.contentVersion !== (card.state.contentVersion ?? 0)) throw new Error('汇报生成后工作已改变，请先重新生成并审阅汇报');
  const actor = currentActor();
  const operationId = JSON.stringify(['rc_report', actor.server, actor.userId, card.id, input.reportId, rid]);
  const existing = useWorkLedger.getState().actions.find((item) => item.idempotencyKey === operationId);
  let spec = existing && readExternalActionSpec(existing);
  if (!spec) {
    const limit = normalizeMessageMaxAllowedSize(await withExternalActionDeadline(getPublicSetting('Message_MaxAllowedSize'), 2_000).catch(() => undefined));
    const parts = toSendableMessageChunks(input.markdown, limit).map((text) => ({ id: `rxr${crypto.randomUUID().replace(/-/g, '')}`, text }));
    spec = {
      ...baseSpec(card, operationId),
      kind: 'rc_report', rid, reportId: input.reportId, reportTitle: input.reportTitle,
      reportGeneratedAt: input.reportGeneratedAt, parts,
      sharedContentReviewed: input.userConfirmed === true,
    };
  }
  const approved = input.userConfirmed === true || (card.state.autonomyMode === 'autonomous' && card.state.visibility === 'room_shared' && card.rid === rid);
  if (existing && spec.kind === 'rc_report' && input.userConfirmed) await markReportReviewed(existing, spec);
  return executor.execute(spec, approved, input.retry === true);
}

export async function syncWorkAdoState(input: {
  workId: string;
  operationId: string;
  expectedRevision: number;
  expectedState: string;
  targetState: string;
}): Promise<NativeDispatchActionRecord> {
  const card = cardFor(input.workId);
  if (!input.operationId.trim()) throw new Error('ADO 外部动作需要稳定操作 ID');
  const config = loadWorkbenchConfig();
  if (!config?.adoBase || !card.adoWorkItemId) throw new Error('请先连接 ADO 并关联工作项');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision <= 0 || !input.expectedState.trim() || !input.targetState.trim()) throw new Error('ADO 状态更新需要准确的预期版本、当前状态和目标状态');
  const spec: AdoStateActionSpec = {
    ...baseSpec(card, JSON.stringify(['ado_state_write', currentActor(), card.id, input.operationId])),
    kind: 'ado_state_write', adoBase: config.adoBase, workItemId: card.adoWorkItemId,
    expectedRevision: input.expectedRevision, expectedState: input.expectedState.trim(), targetState: input.targetState.trim(),
  };
  return executor.execute(spec, card.state.autonomyMode === 'autonomous');
}

export async function executePreparedExternalAction(actionId: string, userConfirmed = false, retry = false): Promise<NativeDispatchActionRecord> {
  const action = useWorkLedger.getState().actions.find((item) => item.id === actionId);
  const spec = action && readExternalActionSpec(action);
  if (!action || !spec) throw new Error('未找到有效的外部动作快照');
  if (spec.kind === 'rc_report' && userConfirmed) await markReportReviewed(action, spec);
  return executor.execute(spec, userConfirmed || cardFor(spec.workId).state.autonomyMode === 'autonomous', retry);
}

/** 启动/恢复连接调用：核对已发送动作，不重新写 ADO，也不自动重发消息。 */
export async function reconcileExternalWorkActions(): Promise<NativeDispatchActionRecord[]> {
  const results: NativeDispatchActionRecord[] = [];
  for (const action of [...useWorkLedger.getState().actions]) {
    if (!readExternalActionSpec(action) || !['dispatched', 'verifying_delivery'].includes(action.state)) continue;
    try { results.push(await executor.reconcile(action)); } catch { /* 其他账号/未就绪动作保留，待重新连接后再核对 */ }
  }
  return results;
}

export { readExternalActionSpec };
export type { ExternalActionSpec, ReportActionSpec };
