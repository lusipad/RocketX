import type {
  DshPendingApproval,
  DshPendingQuestion,
  DshQuestionAnswer,
} from './types';

export function approvalResponse(
  approval: DshPendingApproval,
  approved: boolean,
): Record<string, unknown> {
  return {
    type: 'client-response',
    rpcId: approval.rpcId,
    result: {
      ok: true,
      value: {
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        outcome: approved ? 'allowed-once' : 'rejected',
      },
    },
  };
}

export function questionResponse(
  question: DshPendingQuestion,
  answers: DshQuestionAnswer[],
): Record<string, unknown> {
  return {
    type: 'client-response',
    rpcId: question.rpcId,
    result: {
      ok: true,
      value: {
        sessionId: question.sessionId,
        answer: { answers },
      },
    },
  };
}
