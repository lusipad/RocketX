import type { RuntimeAccountContext } from './butlerAccountReady';
import type { NativeDispatchActionRecord, NativeResumeAuthorization } from './desktopCommands';
import type { RuntimeCommandInput } from './workRuntimeContract';

export interface NativeWorkSnapshotInput {
  account: RuntimeAccountContext;
  sessionId: string;
}

export interface NativeWorkStartInput {
  account: RuntimeAccountContext;
  todoId: string;
  requestId: string;
  workspaceRoot: string;
  executionProfileId: string;
  expectedRequirementsVersion: number;
  expectedContentVersion: number;
  hostDeviceId: string;
}

export interface NativeWorkResumeInput extends NativeWorkSnapshotInput {
  todoId: string;
  expectedRequirementsVersion: number;
  expectedContentVersion: number;
  expectedBindingVersion: number;
  authorization: NativeResumeAuthorization;
}

export interface NativeWorkSubmitInput {
  account: RuntimeAccountContext;
  command: RuntimeCommandInput;
}

export interface NativeWorkAnswerInput extends NativeWorkSnapshotInput {
  decisionId: string;
  expectedBindingVersion: number;
  expectedRequirementsVersion: number;
  nativeTurnId: string;
  answer: unknown;
}

export interface NativeWorkCancelQueuedInput extends NativeWorkSnapshotInput {
  requestId: string;
}

export interface NativeWorkDecision {
  id: string;
  nativeRequestId: string | number;
  method: string;
  nativeThreadId: string;
  nativeTurnId: string;
  requirementsVersion: number;
  bindingVersion: number;
  state: 'pending' | 'answered' | 'expired' | 'unknown';
  params: unknown;
  createdAt: number;
}

export interface NativeWorkSnapshot {
  protocolVersion: 1;
  todoId: string;
  sessionId: string;
  nativeThreadId: string;
  sourceScope: string;
  executionProfileId: string;
  bindingVersion: number;
  connectionId: string | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'unknown';
  runtimeStatus: 'idle' | 'running' | 'waiting_input' | 'waiting_approval' | 'interrupted' | 'unknown';
  activeTurnId: string | null;
  capabilities: { resume: boolean; prompt: boolean; steer: boolean; interrupt: boolean; answer: boolean; externalLiveAttach: false };
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; turnId: string | null; streaming: boolean }>;
  historyTruncated: boolean;
  commands: NativeDispatchActionRecord[];
  decisions: NativeWorkDecision[];
  cursor: number;
  lastEventAt: number | null;
  error: string | null;
  runtimeVersion: string | null;
  admissionWait?: { reason: 'execution_slots' | 'workspace_busy' | 'recovery_required'; message: string } | null;
}
