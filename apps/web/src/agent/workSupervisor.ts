import type {
  NativeDispatchActionRecord, NativeExternalEventRecord, NativeWorkCard, NativeWorkCardState,
  NativeWorkLedgerSnapshot,
} from '../platform/desktopCommands';
import { workContextPathKey } from '../lib/workContext';
import { isNativeHostAction, isNativeHostSession, isNativeHostWork } from '../lib/nativeWorkOwnership';
import { evaluateEventDispatchDecision, verifyExternalEventAgainstLiveState } from './workCoordinator';

export function actionStopReason(card: NativeWorkCard, action: NativeDispatchActionRecord, now: number): string | null {
  if (action.state !== 'prepared') return '动作已不处于待派发状态，请核对原动作回执';
  if ((card.state.requirementsVersion ?? 0) <= 0) return '该待办未纳入自动跟进';
  let spec: { requirementsVersion?: number; contentVersion?: number } = {};
  try { spec = JSON.parse(action.specJson); } catch { /* 无版本的旧动作需重新提出。 */ }
  if (spec.requirementsVersion !== card.state.requirementsVersion) return '工作要求版本已变更，旧动作已失效';
  if (spec.contentVersion !== (card.state.contentVersion ?? 0)) return '成果版本已变更，旧动作需重新核对';
  if (card.state.waitState === 'paused') return '自动跟进已暂停';
  if (card.state.autonomyMode === 'readonly') return '当前工作仅观察，不允许继续派发';
  if (card.state.waitState === 'canceled' || card.state.stage === 'done') return '工作已取消或完成';
  if (card.state.revokedAt != null && action.createdAt <= card.state.revokedAt) return '动作早于控制撤销水位，需重新授权';
  if (card.state.deadlineAt != null && now >= card.state.deadlineAt) return '自动跟进已到截止时间，需要你决定是否继续';
  return null;
}

interface DispatchQueueItem {
  actionId: string;
  workspaceRoot: string;
  execute: () => Promise<unknown>;
  ready?: () => string | null;
  queued?: (reason: string | null) => void | Promise<void>;
  lastReason?: string | null;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
const dispatchQueue: DispatchQueueItem[] = [];
const activeWorkspaces = new Set<string>();
const pendingDispatches = new Map<string, Promise<unknown>>();
let activeDispatches = 0;
let queueTimer: ReturnType<typeof setTimeout> | undefined;

function drainDispatchQueue(): void {
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = undefined;
  for (let index = 0; index < dispatchQueue.length;) {
    const item = dispatchQueue[index];
    const reason = activeWorkspaces.has(item.workspaceRoot)
      ? '同一工作区已有写入任务，正在排队'
      : activeDispatches >= 2
        ? '后台并发已达 2 路，正在排队'
        : item.ready?.() ?? null;
    if (reason !== item.lastReason) {
      item.lastReason = reason;
      void Promise.resolve(item.queued?.(reason)).catch(() => undefined);
    }
    if (reason) { index += 1; continue; }
    dispatchQueue.splice(index, 1);
    activeWorkspaces.add(item.workspaceRoot);
    activeDispatches += 1;
    void item.execute().then(item.resolve, item.reject).finally(() => {
      activeWorkspaces.delete(item.workspaceRoot);
      activeDispatches -= 1;
      pendingDispatches.delete(item.actionId);
      drainDispatchQueue();
    });
  }
  if (dispatchQueue.length) queueTimer = setTimeout(drainDispatchQueue, 1000);
}

/** 所有手动/自动派发共用同一写入队列；真正执行前仍须重验版本与控制状态。 */
export function runWorkspaceDispatch<T>(
  input: { actionId: string; workspaceRoot: string; ready?: () => string | null },
  execute: () => Promise<T>,
  queued?: (reason: string | null) => void | Promise<void>,
): Promise<T> {
  const existing = pendingDispatches.get(input.actionId);
  if (existing) return existing as Promise<T>;
  const result = new Promise<T>((resolve, reject) => {
    dispatchQueue.push({ ...input, workspaceRoot: workContextPathKey(input.workspaceRoot) || 'unassigned', execute, queued,
      resolve: (value) => resolve(value as T), reject });
  });
  pendingDispatches.set(input.actionId, result);
  drainDispatchQueue();
  return result;
}

export interface MessageWatermark { at: number; ids: string[] }

/** 先持久收件再推进水位。首次只建立基线，已有水位才补偿离线期间事件。 */
export function createMessageWatermarks<T extends { id: string; at: number }>(options: {
  read: () => Record<string, MessageWatermark>;
  write: (value: Record<string, MessageWatermark>) => void;
  ingest: (message: T) => Promise<void>;
  now: () => number;
}) {
  const queues = new Map<string, Promise<void>>();
  return {
    observe(roomId: string, messages: T[], initialHistory = true): Promise<void> {
      const task = (queues.get(roomId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        const cursors = options.read();
        let cursor = cursors[roomId];
        if (!cursor) {
          if (initialHistory) {
            options.write({ ...cursors, [roomId]: { at: options.now(), ids: [] } });
            return;
          }
          cursor = { at: Math.min(options.now(), ...messages.map((m) => m.at)), ids: [] };
        }
        const known = new Set(cursor.ids);
        const fresh = messages.filter((m) => m.at > cursor.at || (m.at === cursor.at && !known.has(m.id)))
          .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
        for (const message of fresh) {
          await options.ingest(message);
          cursor = message.at > cursor.at ? { at: message.at, ids: [message.id] }
            : { at: cursor.at, ids: [...new Set([...cursor.ids, message.id])] };
          options.write({ ...options.read(), [roomId]: cursor });
        }
      });
      queues.set(roomId, task);
      void task.finally(() => { if (queues.get(roomId) === task) queues.delete(roomId); }).catch(() => undefined);
      return task;
    },
  };
}

interface PrepareInput {
  idempotencyKey: string; todoId: string; eventId?: string | null; sessionId?: string | null;
  actionKind: NativeDispatchActionRecord['actionKind']; specJson: string;
  baselineMarker?: string | null; requireConfirmation?: boolean;
}
interface SupervisorPorts {
  snapshot: () => NativeWorkLedgerSnapshot;
  now: () => number;
  updateCard: (id: string, patch: Partial<NativeWorkCardState>) => Promise<NativeWorkCard>;
  prepare: (input: PrepareInput) => Promise<NativeDispatchActionRecord>;
  transition: (input: { id: string; state: NativeDispatchActionRecord['state']; expectedState?: NativeDispatchActionRecord['state']; errorMessage?: string | null }) => Promise<NativeDispatchActionRecord>;
  execute: (action: NativeDispatchActionRecord) => Promise<unknown>;
  notify: (card: NativeWorkCard, reason: string) => Promise<void>;
  readNotices: () => Record<string, string>;
  writeNotices: (value: Record<string, string>) => void;
  eventsReady?: () => boolean;
}

const sessionAction = (action: NativeDispatchActionRecord) => action.actionKind.startsWith('session_');
const activeAction = (action: NativeDispatchActionRecord) => ['prepared', 'dispatched', 'verifying_delivery', 'awaiting_approval'].includes(action.state);

export function createWorkSupervisor(ports: SupervisorPorts) {
  let stopped = false;
  let cycle: Promise<void> | undefined;
  const inFlight = new Set<string>();

  async function prepareEvent(event: NativeExternalEventRecord) {
    const state = ports.snapshot();
    const card = state.cards.find((c) => c.id === event.todoId);
    if (!card || isNativeHostWork(card.id, state.sessions)
      || (card.state.requirementsVersion ?? 0) <= 0 || state.actions.some((a) => a.eventId === event.id)) return;
    if (card.state.stage === 'done' || (card.state.deadlineAt != null && ports.now() >= card.state.deadlineAt)) return;
    if (card.state.autonomyMode === 'readonly') return;
    if (!['received', 'correlated', 'pending_approval'].includes(event.status)) return;
    const decision = evaluateEventDispatchDecision(event, card, state.sessions, verifyExternalEventAgainstLiveState(event, card));
    if (decision.decision === 'blocked_privacy' || decision.decision === 'blocked_readonly_session') {
      if (card.state.waitState !== 'waiting_input' || card.state.waitReason !== decision.reason) {
        await ports.updateCard(card.id, { waitState: 'waiting_input', waitReason: decision.reason });
      }
      return;
    }
    if (decision.decision !== 'auto_dispatch' && decision.decision !== 'require_confirmation') return;
    const target = state.sessions.find((s) => s.id === decision.targetSessionId);
    await ports.prepare({
      todoId: card.id, eventId: event.id, sessionId: decision.targetSessionId, actionKind: decision.actionKind,
      idempotencyKey: `event:${event.dedupeKey}:${decision.actionKind}`,
      specJson: JSON.stringify({ specText: decision.specText, requirementsVersion: card.state.requirementsVersion,
        contentVersion: card.state.contentVersion ?? 0, workspaceRoot: target?.workspaceRoot,
        automatic: true, ...(decision.targetRuntime ? { runtime: decision.targetRuntime } : {}) }),
      baselineMarker: target?.lastEventSeq != null ? `seq:${target.lastEventSeq}` : target?.lastTurnId ? `turn:${target.lastTurnId}` : null,
      requireConfirmation: decision.decision !== 'auto_dispatch' || !target?.workspaceRoot,
    });
  }

  async function runCycle() {
    if (stopped) return;
    const now = ports.now();
    for (const card of ports.snapshot().cards) {
      if (stopped || isNativeHostWork(card.id, ports.snapshot().sessions)
        || (card.state.requirementsVersion ?? 0) <= 0 || card.state.stage === 'done'
        || ['paused', 'canceled'].includes(card.state.waitState)) continue;
      const exhausted = card.state.autoTurnsUsed >= card.state.maxAutoTurns || card.state.consecutiveFailures >= 2;
      const deadline = card.state.deadlineAt != null && now >= card.state.deadlineAt;
      if (deadline || (exhausted && !ports.snapshot().actions.some((a) => a.todoId === card.id && activeAction(a)))) {
        const reason = deadline ? '自动跟进已到截止时间；当前执行状态保留，需要你决定是否继续'
          : `自动跟进预算已用尽（${card.state.autoTurnsUsed}/${card.state.maxAutoTurns} 轮，连续失败 ${card.state.consecutiveFailures} 次）`;
        if (card.state.waitState !== 'waiting_input' || card.state.waitReason !== reason) {
          await ports.updateCard(card.id, { waitState: 'waiting_input', waitReason: reason });
        }
        continue;
      }
      const state = ports.snapshot();
      const unresolved = card.state.dependsOn.filter((id) => !state.cards.some((c) => c.id === id && c.state.stage === 'done'));
      if (unresolved.length) {
        if (card.state.waitState === 'none' || card.state.waitState === 'waiting_external') {
          const reason = `等待前置工作完成：${unresolved.map((id) => state.cards.find((c) => c.id === id)?.title ?? id).join('、')}`;
          if (card.state.waitReason !== reason) await ports.updateCard(card.id, { waitState: 'waiting_external', waitReason: reason });
        }
        continue;
      }
      const due = card.state.nextCheckAt != null && card.state.nextCheckAt <= now;
      const dependencyReady = card.state.dependsOn.length > 0 && card.state.waitState === 'waiting_external';
      if ((!due && !dependencyReady) || ['waiting_approval', 'waiting_input', 'blocked'].includes(card.state.waitState)
        || state.actions.some((a) => a.todoId === card.id && activeAction(a))) continue;
      if (card.state.autonomyMode !== 'autonomous') {
        await ports.updateCard(card.id, { waitState: 'waiting_input', waitReason: '已到复查时间，请确认下一步', nextCheckAt: null });
        continue;
      }
      const session = state.sessions.find((s) => s.todoId === card.id && s.controlMode === 'controllable');
      const trigger = due ? `time:${card.state.nextCheckAt}` : `dependency:${card.state.dependsOn.map((id) => `${id}:${state.cards.find((c) => c.id === id)?.state.updatedAt}`).sort().join(',')}`;
      await ports.prepare({ todoId: card.id, sessionId: session?.id, actionKind: session ? 'session_prompt' : 'session_create',
        idempotencyKey: `followup:${card.id}:v${card.state.requirementsVersion}:${trigger}`,
        requireConfirmation: !session,
        specJson: JSON.stringify({ requirementsVersion: card.state.requirementsVersion, contentVersion: card.state.contentVersion ?? 0,
          workspaceRoot: session?.workspaceRoot, automatic: true,
          specText: `目标：${card.state.goal}\n验收：${card.state.acceptance.join('；')}\n${card.state.nextStep || '复查外部等待或前置工作的最新状态，再决定下一步。'}\n只依据当前可验证事实继续；等待仍未解除时设置下次复查时间，不得把等待当作完成。` }),
      });
      await ports.updateCard(card.id, { nextCheckAt: null, waitState: session ? 'none' : 'waiting_approval',
        waitReason: session ? null : '复查需要选择执行会话和工作目录' });
    }
    for (const event of [...ports.snapshot().events].sort((a, b) => a.occurredAt - b.occurredAt)) {
      if (stopped) return;
      if (ports.eventsReady?.() === false) break;
      await prepareEvent(event);
    }
    for (const action of ports.snapshot().actions.filter((a) => sessionAction(a) && a.state === 'prepared')) {
      if (stopped || inFlight.has(action.id)) continue;
      if (isNativeHostAction(action) || isNativeHostWork(action.todoId, ports.snapshot().sessions)
        || ports.snapshot().sessions.some((session) => session.id === action.sessionId && isNativeHostSession(session))) continue;
      const card = ports.snapshot().cards.find((c) => c.id === action.todoId);
      const reason = card ? actionStopReason(card, action, now) : '关联工作已不存在';
      if (reason) {
        await ports.transition({ id: action.id, state: 'canceled', expectedState: 'prepared', errorMessage: reason });
        continue;
      }
      if (ports.snapshot().actions.some((other) => other.id !== action.id && other.todoId === action.todoId
        && ['dispatched', 'verifying_delivery'].includes(other.state))) {
        if (action.errorMessage !== '前一动作的送达结果待核对，已保留排队') await ports.transition({
          id: action.id, state: 'prepared', expectedState: 'prepared', errorMessage: '前一动作的送达结果待核对，已保留排队',
        });
        continue;
      }
      inFlight.add(action.id);
      void ports.execute(action).catch(() => undefined).finally(() => inFlight.delete(action.id));
    }
    for (const card of ports.snapshot().cards) {
      if (isNativeHostWork(card.id, ports.snapshot().sessions)) continue;
      if ((card.state.requirementsVersion ?? 0) <= 0) continue;
      const actions = ports.snapshot().actions.filter((a) => a.todoId === card.id && !isNativeHostAction(a));
      const unknown = actions.filter((a) => !inFlight.has(a.id) && (a.state === 'verifying_delivery' || a.state === 'dispatched'));
      const needsApproval = actions.some((a) => a.state === 'awaiting_approval');
      const reason = unknown.length ? '有动作的送达结果待核对，自动跟进不会重复发送'
        : needsApproval ? '有待确认动作，需要你决定'
          : ['waiting_input', 'waiting_approval', 'blocked'].includes(card.state.waitState) ? card.state.waitReason || '需要你处理'
            : card.state.stage === 'done' ? '工作已验收完成' : null;
      if (!reason) {
        const notices = ports.readNotices();
        if (notices[card.id]) {
          const next = { ...notices };
          delete next[card.id];
          ports.writeNotices(next);
        }
        continue;
      }
      const signature = JSON.stringify([card.state.requirementsVersion, card.state.stage, card.state.waitState, reason,
        actions.filter((a) => ['awaiting_approval', 'verifying_delivery', 'dispatched'].includes(a.state)).map((a) => `${a.id}:${a.state}`).sort()]);
      const notices = ports.readNotices();
      if (notices[card.id] === signature) continue;
      ports.writeNotices({ ...notices, [card.id]: signature });
      await ports.notify(card, reason);
    }
  }
  return {
    tick(): Promise<void> {
      if (stopped) return Promise.resolve();
      cycle ??= runCycle().finally(() => { cycle = undefined; });
      return cycle;
    },
    stop() { stopped = true; },
  };
}
