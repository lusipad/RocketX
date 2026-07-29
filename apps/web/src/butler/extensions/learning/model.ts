/** 第一批 Butler 学习扩展共享的数据合同；不属于 Butler 内核。 */
export type ProfileFactKind =
  | 'identity'
  | 'preference'
  | 'work-context'
  | 'working-style'
  | 'boundary';

export type ProfileFactStatus = 'confirmed' | 'candidate' | 'revoked';
export type ProfileFactOrigin = 'explicit' | 'observed' | 'external-edit';

export interface ProfileFact {
  id: string;
  kind: ProfileFactKind;
  subject: string;
  value: string;
  status: ProfileFactStatus;
  origin: ProfileFactOrigin;
  createdAt: number;
  updatedAt: number;
  replacesId?: string;
}

export type OperationAction =
  | 'open-view'
  | 'ask-butler'
  | 'create-task'
  | 'dismiss-suggestion'
  | 'confirm-profile'
  | 'revoke-profile'
  | 'run-analysis'
  | 'run-routine'
  | 'dry-run-improvement'
  | 'enable-improvement';

export interface OperationReceipt {
  id: string;
  action: OperationAction;
  intentKey: string;
  surface: string;
  outcome: 'completed' | 'cancelled' | 'failed';
  at: number;
  durationMs?: number;
}

export type WorkInsightKind = 'rhythm' | 'attention' | 'collaboration';

export interface WorkInsight {
  id: string;
  kind: WorkInsightKind;
  title: string;
  evidence: string;
  suggestion: string;
  confidence: 'low' | 'medium' | 'high';
  createdAt: number;
}

export interface RepetitionCandidate {
  id: string;
  action: OperationAction;
  intentKey: string;
  occurrences: number;
  activeDays: number;
  firstAt: number;
  lastAt: number;
  surfaces: string[];
}

export type ImprovementTarget =
  | 'task'
  | 'profile'
  | 'memory-rule'
  | 'routine'
  | 'tool-preset'
  | 'micro-skill'
  | 'no-op';

export interface ImprovementProposal {
  id: string;
  candidateId: string;
  target: ImprovementTarget;
  title: string;
  rationale: string;
  preview: string[];
  skillName?: string;
  status: 'suggested' | 'dry-run' | 'enabled' | 'dismissed';
  createdAt: number;
}

export interface ButlerLearningSnapshot {
  profileFacts: ProfileFact[];
  operations: OperationReceipt[];
  insights: WorkInsight[];
  candidates: RepetitionCandidate[];
  proposals: ImprovementProposal[];
  analysisEnabled: boolean;
}

export const EMPTY_BUTLER_LEARNING_SNAPSHOT: ButlerLearningSnapshot = {
  profileFacts: [],
  operations: [],
  insights: [],
  candidates: [],
  proposals: [],
  analysisEnabled: true,
};

export const BUTLER_LEARNING_DAY_MS = 24 * 60 * 60 * 1_000;
export const BUTLER_OPERATION_LIMIT = 500;

const FACT_KINDS: readonly ProfileFactKind[] = [
  'identity',
  'preference',
  'work-context',
  'working-style',
  'boundary',
];
const OPERATION_ACTIONS: readonly OperationAction[] = [
  'open-view',
  'ask-butler',
  'create-task',
  'dismiss-suggestion',
  'confirm-profile',
  'revoke-profile',
  'run-analysis',
  'run-routine',
  'dry-run-improvement',
  'enable-improvement',
];

export function createButlerLearningId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function normalizeButlerLearningText(value: string, maxLength = 180): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function butlerLearningDayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function normalizeFact(value: unknown): ProfileFact | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const fact = value as Partial<ProfileFact>;
  if (
    typeof fact.id !== 'string'
    || !FACT_KINDS.includes(fact.kind as ProfileFactKind)
    || typeof fact.subject !== 'string'
    || typeof fact.value !== 'string'
    || !['confirmed', 'candidate', 'revoked'].includes(fact.status ?? '')
    || !['explicit', 'observed', 'external-edit'].includes(fact.origin ?? '')
    || typeof fact.createdAt !== 'number'
    || typeof fact.updatedAt !== 'number'
  ) return undefined;
  const subject = normalizeButlerLearningText(fact.subject, 80);
  const text = normalizeButlerLearningText(fact.value);
  if (!subject || !text) return undefined;
  return {
    id: fact.id,
    kind: fact.kind as ProfileFactKind,
    subject,
    value: text,
    status: fact.status as ProfileFactStatus,
    origin: fact.origin as ProfileFactOrigin,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
    ...(typeof fact.replacesId === 'string' ? { replacesId: fact.replacesId } : {}),
  };
}

function normalizeReceipt(value: unknown): OperationReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const receipt = value as Partial<OperationReceipt>;
  if (
    typeof receipt.id !== 'string'
    || !OPERATION_ACTIONS.includes(receipt.action as OperationAction)
    || typeof receipt.intentKey !== 'string'
    || typeof receipt.surface !== 'string'
    || !['completed', 'cancelled', 'failed'].includes(receipt.outcome ?? '')
    || typeof receipt.at !== 'number'
  ) return undefined;
  return {
    id: receipt.id,
    action: receipt.action as OperationAction,
    intentKey: normalizeButlerLearningText(receipt.intentKey, 100),
    surface: normalizeButlerLearningText(receipt.surface, 60),
    outcome: receipt.outcome as OperationReceipt['outcome'],
    at: receipt.at,
    ...(typeof receipt.durationMs === 'number' ? { durationMs: receipt.durationMs } : {}),
  };
}

export function parseButlerLearningSnapshot(raw: string | null): ButlerLearningSnapshot {
  if (!raw) return { ...EMPTY_BUTLER_LEARNING_SNAPSHOT };
  try {
    const value = JSON.parse(raw) as Partial<ButlerLearningSnapshot>;
    return {
      profileFacts: Array.isArray(value.profileFacts)
        ? value.profileFacts.flatMap((fact) => normalizeFact(fact) ?? [])
        : [],
      operations: Array.isArray(value.operations)
        ? value.operations.flatMap((receipt) => normalizeReceipt(receipt) ?? [])
          .slice(-BUTLER_OPERATION_LIMIT)
        : [],
      insights: Array.isArray(value.insights) ? value.insights as WorkInsight[] : [],
      candidates: Array.isArray(value.candidates) ? value.candidates as RepetitionCandidate[] : [],
      proposals: Array.isArray(value.proposals) ? value.proposals as ImprovementProposal[] : [],
      analysisEnabled: value.analysisEnabled !== false,
    };
  } catch {
    return { ...EMPTY_BUTLER_LEARNING_SNAPSHOT };
  }
}
