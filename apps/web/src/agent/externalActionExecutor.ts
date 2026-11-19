import type { DispatchActionState, NativeDispatchActionRecord } from '../platform/desktopCommands';

export interface ExternalActionActor {
  userId: string;
  server: string;
  adoAccount: string;
}

interface ExternalActionBase {
  version: 1;
  operationId: string;
  workId: string;
  requirementsVersion: number;
  contentVersion?: number;
  projectKey: string | null;
  actor: ExternalActionActor;
  createdAt: number;
}

export interface AdoStateActionSpec extends ExternalActionBase {
  kind: 'ado_state_write';
  adoBase: string;
  workItemId: number;
  expectedRevision: number;
  expectedState: string;
  targetState: string;
}

export interface ReportActionSpec extends ExternalActionBase {
  kind: 'rc_report';
  rid: string;
  reportId: string;
  reportGeneratedAt: number;
  reportTitle: string;
  parts: Array<{ id: string; text: string }>;
  sharedContentReviewed?: boolean;
}

export type ExternalActionSpec = AdoStateActionSpec | ReportActionSpec;
export interface ExternalActionReceipt {
  observedAt: number;
  revision?: number;
  state?: string;
  messageIds?: string[];
  delivery?: 'confirmed' | 'unknown' | 'conflict' | 'failed';
}

export interface ExternalActionDriver {
  prepare(spec: ExternalActionSpec, approved: boolean): Promise<NativeDispatchActionRecord>;
  transition(action: NativeDispatchActionRecord, state: DispatchActionState, receipt?: ExternalActionReceipt, error?: string): Promise<NativeDispatchActionRecord>;
  validate(spec: ExternalActionSpec, mode?: 'send' | 'read'): Promise<void>;
  writeAdo(spec: AdoStateActionSpec): Promise<{ revision: number; state: string }>;
  readAdo(spec: AdoStateActionSpec): Promise<{ revision: number; state: string }>;
  sendMessage(spec: ReportActionSpec, part: ReportActionSpec['parts'][number]): Promise<{ id: string; rid: string; text: string }>;
  readMessage(spec: ReportActionSpec, id: string): Promise<{ id: string; rid: string; text: string } | null>;
  isUnknownAdoError(error: unknown): boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFirstDelivery(action: NativeDispatchActionRecord): boolean {
  if (!['prepared', 'awaiting_approval'].includes(action.state) || action.errorMessage) return false;
  if (!action.receiptRef) return true;
  try {
    const receipt = JSON.parse(action.receiptRef) as Record<string, unknown>;
    return !!receipt && typeof receipt === 'object' && !('delivery' in receipt || 'messageIds' in receipt || 'observedAt' in receipt);
  } catch { return false; }
}

export function readExternalActionSpec(action: NativeDispatchActionRecord): ExternalActionSpec | null {
  if (action.actionKind !== 'ado_state_write' && action.actionKind !== 'rc_report') return null;
  try {
    const spec = JSON.parse(action.specJson) as ExternalActionSpec;
    if (spec.version !== 1 || spec.kind !== action.actionKind || spec.workId !== action.todoId ||
      spec.operationId !== action.idempotencyKey || !spec.actor?.userId || !spec.actor.server ||
        !Number.isInteger(spec.requirementsVersion) || spec.requirementsVersion < 0) return null;
    if (spec.kind === 'ado_state_write') {
      if (!spec.adoBase || !Number.isInteger(spec.workItemId) || spec.workItemId <= 0 || !Number.isInteger(spec.expectedRevision) || spec.expectedRevision <= 0 ||
        !spec.expectedState || !spec.targetState) return null;
    } else if (!spec.rid || !spec.reportId || !Array.isArray(spec.parts) || !spec.parts.length ||
      spec.parts.some((part) => !part.id || typeof part.text !== 'string' || !part.text.trim())) return null;
    return spec;
  } catch { return null; }
}

/** 单运行时防重入；跨窗口写入归属由账本的条件状态更新约束。 */
export function createExternalActionExecutor(driver: ExternalActionDriver) {
  const pending = new Map<string, Promise<NativeDispatchActionRecord>>();

  async function reconcile(action: NativeDispatchActionRecord): Promise<NativeDispatchActionRecord> {
    const spec = readExternalActionSpec(action);
    if (!spec || !['dispatched', 'verifying_delivery'].includes(action.state)) return action;
    await driver.validate(spec, 'read');
    try {
      if (spec.kind === 'ado_state_write') {
        const item = await driver.readAdo(spec);
        if (item.state === spec.targetState && item.revision >= spec.expectedRevision) {
          return driver.transition(action, 'acknowledged', { ...item, observedAt: Date.now(), delivery: 'confirmed' });
        }
        return driver.transition(action, 'verifying_delivery', { ...item, observedAt: Date.now(), delivery: 'unknown' },
          '先前写入结果尚未确认；未重新写入 ADO，请核对远端历史');
      }
      const confirmed: string[] = [];
      for (const part of spec.parts) {
        const message = await driver.readMessage(spec, part.id);
        if (!message) continue;
        if (message.id !== part.id || message.rid !== spec.rid || message.text !== part.text) {
          return driver.transition(action, 'failed', { observedAt: Date.now(), messageIds: confirmed, delivery: 'conflict' }, '汇报消息 ID 已存在其他内容或属于其他讨论室');
        }
        confirmed.push(part.id);
      }
      return driver.transition(action, confirmed.length === spec.parts.length ? 'acknowledged' : 'verifying_delivery',
        { observedAt: Date.now(), messageIds: confirmed, delivery: confirmed.length === spec.parts.length ? 'confirmed' : 'unknown' },
        confirmed.length === spec.parts.length ? undefined : '汇报尚未全部确认送达；保留原消息 ID，未自动重发');
    } catch (error) {
      return driver.transition(action, 'verifying_delivery', { observedAt: Date.now(), delivery: 'unknown' }, `回读暂时失败：${errorText(error)}`);
    }
  }

  async function run(spec: ExternalActionSpec, approved: boolean, retryReport: boolean): Promise<NativeDispatchActionRecord> {
    let action = await driver.prepare(spec, approved);
    const frozen = readExternalActionSpec(action);
    if (!frozen || frozen.kind !== spec.kind || frozen.workId !== spec.workId ||
      frozen.actor.userId !== spec.actor.userId || frozen.actor.server !== spec.actor.server) {
      throw new Error('外部操作身份不一致，拒绝覆盖已冻结的动作');
    }
    // 同一操作始终使用首次持久化的事实快照；重试不接受新内容。
    spec = frozen;
    if (['acknowledged', 'completed', 'canceled', 'failed'].includes(action.state)) return action;
    if (action.state === 'awaiting_approval' && !approved) return action;
    await driver.validate(spec, 'send');
    const firstDelivery = isFirstDelivery(action);
    if (action.state === 'dispatched' || action.state === 'verifying_delivery') {
      action = await reconcile(action);
      if (action.state !== 'verifying_delivery' || spec.kind !== 'rc_report' || !retryReport || !approved) return action;
    }
    action = await driver.transition(action, 'dispatched');
    if (spec.kind === 'ado_state_write') {
      let item: { revision: number; state: string };
      try {
        item = await driver.writeAdo(spec);
      } catch (error) {
        const unknown = driver.isUnknownAdoError(error);
        return driver.transition(action, unknown ? 'verifying_delivery' : 'failed',
          { observedAt: Date.now(), delivery: unknown ? 'unknown' : /冲突|已被其他人|状态已从/.test(errorText(error)) ? 'conflict' : 'failed' }, errorText(error));
      }
      // 回执持久化失败不能把成功写入误记为确定失败；保留发送态等待回读。
      return driver.transition(action, 'acknowledged', { ...item, observedAt: Date.now(), delivery: 'confirmed' });
    }
    const confirmed: string[] = [];
    try {
      for (const part of spec.parts) {
        await driver.validate(spec);
        // 首次取得发送归属后直接创建冻结的新 ID。RC 8.6.1 的不存在查询
        // 可能只返回 bare 400，不能用它作为首次发送的必要前置条件。
        const existing = firstDelivery ? null : await driver.readMessage(spec, part.id);
        if (existing && (existing.id !== part.id || existing.rid !== spec.rid || existing.text !== part.text)) {
          return driver.transition(action, 'failed', { observedAt: Date.now(), messageIds: confirmed, delivery: 'conflict' }, '汇报消息 ID 已存在其他内容或属于其他讨论室');
        }
        const message = existing ?? await driver.sendMessage(spec, part);
        if (message.id !== part.id || message.rid !== spec.rid || message.text !== part.text) {
          return driver.transition(action, 'failed', { observedAt: Date.now(), messageIds: confirmed, delivery: 'conflict' }, '服务端回执与冻结汇报的消息 ID、讨论室或内容不一致');
        }
        confirmed.push(part.id);
        action = await driver.transition(action, 'dispatched', { observedAt: Date.now(), messageIds: [...confirmed], delivery: 'unknown' });
      }
      return await driver.transition(action, 'acknowledged', { observedAt: Date.now(), messageIds: confirmed, delivery: 'confirmed' });
    } catch (error) {
      return driver.transition(action, 'verifying_delivery', { observedAt: Date.now(), messageIds: confirmed, delivery: 'unknown' },
        `汇报送达待确认：${errorText(error)}`);
    }
  }

  return {
    execute(spec: ExternalActionSpec, approved = false, retryReport = false): Promise<NativeDispatchActionRecord> {
      const key = JSON.stringify([spec.actor.server, spec.actor.userId, spec.operationId]);
      const existing = pending.get(key);
      if (existing) return existing;
      const task = run(spec, approved, retryReport).finally(() => pending.delete(key));
      pending.set(key, task);
      return task;
    },
    reconcile,
  };
}
