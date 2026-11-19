import type { NativeDispatchActionRecord, NativeWorkCard } from '../platform/desktopCommands';
import type { NativeWorkSnapshot } from '../platform/nativeWorkRuntime';

type ReplySource = Pick<NativeWorkSnapshot, 'sessionId' | 'nativeThreadId' | 'sourceScope' | 'executionProfileId'>;

/** A fresh thread can be idle while the host is still delivering its first prompt. */
export function pendingInvestigation(snapshot: NativeWorkSnapshot | null | undefined): string | undefined {
  if (!snapshot || snapshot.runtimeStatus !== 'idle' || snapshot.activeTurnId) return;
  const first = snapshot.commands.find(command => command.todoId === snapshot.todoId && command.sessionId === snapshot.sessionId
    && command.actionKind === 'session_prompt' && command.idempotencyKey === `native-codex:v1:native-start:${snapshot.todoId}`);
  if (first?.state === 'prepared') return snapshot.admissionWait?.message ?? '调查要求已保存，等待执行';
  if (first?.state === 'dispatched') return '已提交调查要求，等待 Codex 回执';
}

export function unresolvedWorkDelivery(commands: NativeDispatchActionRecord[], todoId: string, sessionId: string, kind?: NativeDispatchActionRecord['actionKind']) {
  return commands.find(command => command.todoId === todoId && command.sessionId === sessionId
    && command.state === 'verifying_delivery' && (kind ? command.actionKind === kind : ['session_prompt', 'session_steer', 'session_interrupt', 'session_resume'].includes(command.actionKind)));
}

export function completedWorkTurn(action: NativeDispatchActionRecord, card: NativeWorkCard, source: ReplySource): string | undefined {
  if (action.actionKind !== 'session_prompt' || action.state !== 'completed' || !action.receiptRef
    || action.todoId !== card.id || action.sessionId !== source.sessionId) return;
  try {
    const receipt = JSON.parse(action.receiptRef);
    const spec = JSON.parse(action.specJson);
    if (receipt?.terminalStatus === 'completed' && typeof receipt.nativeTurnId === 'string' && receipt.nativeTurnId
      && receipt.nativeThreadId === source.nativeThreadId && spec?.binding?.sourceScope === source.sourceScope
      && spec.binding.executionProfileId === source.executionProfileId && spec.binding.nativeThreadId === source.nativeThreadId
      && spec.expected?.requirementsVersion === (card.state.requirementsVersion ?? 0)
      && spec.expected.contentVersion === (card.state.contentVersion ?? 0)) return receipt.nativeTurnId;
  } catch { /* Legacy receipts cannot prove which turn produced this reply. */ }
}

/** Restored thread history can contain replies that predate this work. */
export function findWorkResultReply(snapshot: NativeWorkSnapshot | null | undefined, card: NativeWorkCard, turnId?: string) {
  if (!snapshot || snapshot.todoId !== card.id) return;
  const completedTurns = new Set(snapshot.commands.map(action => completedWorkTurn(action, card, snapshot)).filter(Boolean));
  return snapshot.messages.filter(message => message.role === 'assistant' && !message.streaming && message.text.trim()
    && message.turnId && (!turnId || message.turnId === turnId) && completedTurns.has(message.turnId)).at(-1);
}
