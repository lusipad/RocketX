export interface DshPendingApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

export interface DshQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface DshQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface DshPendingQuestion {
  rpcId: string;
  sessionId: string;
  questions: DshQuestion[];
}
