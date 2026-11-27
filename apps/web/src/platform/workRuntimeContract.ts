import { t } from '../i18n';

/** Display/transport contracts only. Native admission owns identity and authorization. */
export const NATIVE_CODEX_COMMAND_SCHEMA = 'rocketx.native-codex-command.v1';
export const NATIVE_COMMAND_EXECUTOR = 'native_host';
export const MAX_COMMAND_TEXT_BYTES = 256 * 1024;
export const MAX_COMMAND_JSON_BYTES = 512 * 1024;

export type NativeCommandKind = 'resume' | 'prompt' | 'steer' | 'interrupt';
export type NativeCodexIntent =
  | { kind: 'resume' }
  | { kind: 'prompt'; text: string }
  | { kind: 'steer'; text: string }
  | { kind: 'interrupt' };
export type CommandSubmitter = 'user' | 'butler' | 'automation';

export interface RuntimeCommandInput {
  requestId: string;
  todoId: string;
  sessionId: string;
  expectedRequirementsVersion: number;
  expectedContentVersion: number;
  expectedBindingVersion: number;
  nativeTurnId?: string | null;
  queueAfterTurn?: boolean;
  intent: NativeCodexIntent;
  submittedBy: CommandSubmitter;
}

export interface NativeCommandScope {
  accountScope: string;
  accountGeneration: number;
  hostDeviceId: string;
}

export interface NativeCommandBinding {
  sessionId: string;
  nativeThreadId: string;
  sourceScope: string;
  executionProfileId: string;
  workspaceRoot: string;
  bindingVersion: number;
}

export interface NativeCommandExpected {
  requirementsVersion: number;
  contentVersion: number;
  nativeTurnId?: string | null;
}

export interface NativeCommandSpec {
  schema: typeof NATIVE_CODEX_COMMAND_SCHEMA;
  executor: typeof NATIVE_COMMAND_EXECUTOR;
  requestId: string;
  todoId: string;
  scope: NativeCommandScope;
  binding: NativeCommandBinding;
  expected: NativeCommandExpected;
  queueAfterTurn?: boolean;
  intent: NativeCodexIntent;
  submittedBy: CommandSubmitter;
}

export type RuntimeCommandState =
  | 'awaiting_approval' | 'prepared' | 'dispatched' | 'verifying_delivery'
  | 'acknowledged' | 'completed' | 'failed' | 'canceled';
export type SessionControlAccess = 'record' | 'resumable' | 'managed_live' | 'external_attach';

const transitions: Record<RuntimeCommandState, readonly RuntimeCommandState[]> = {
  awaiting_approval: ['prepared', 'canceled'],
  prepared: ['dispatched', 'failed', 'canceled'],
  dispatched: ['acknowledged', 'completed', 'failed', 'verifying_delivery'],
  verifying_delivery: ['acknowledged', 'completed', 'failed'],
  acknowledged: ['completed', 'failed', 'verifying_delivery'],
  completed: [], failed: [], canceled: [],
};

/** Matching native facts and CAS are still required at the write boundary. */
export function canTransitionRuntimeCommandState(from: RuntimeCommandState, to: RuntimeCommandState): boolean {
  return Object.hasOwn(transitions, from) && Object.hasOwn(transitions, to)
    && (from === to || transitions[from].includes(to));
}

/** An intersection with verified methods, never a handshake or permission grant. */
export function availableNativeCodexIntents(
  access: SessionControlAccess,
  verified: readonly NativeCommandKind[],
): NativeCommandKind[] {
  if (access === 'record') return [];
  return [...new Set(verified.filter((kind) => {
    if (access === 'resumable') return kind === 'resume';
    return (access === 'managed_live' || access === 'external_attach')
      && (kind === 'prompt' || kind === 'steer' || kind === 'interrupt');
  }))];
}

export function validateRuntimeCommandInput(value: unknown): asserts value is RuntimeCommandInput {
  const input = objectFields(value, [
    'requestId', 'todoId', 'sessionId', 'expectedRequirementsVersion',
    'expectedContentVersion', 'expectedBindingVersion', 'nativeTurnId', 'queueAfterTurn', 'intent', 'submittedBy',
  ]);
  identifier(input.requestId, 'requestId', 256);
  identifier(input.todoId, 'todoId', 256);
  identifier(input.sessionId, 'sessionId', 512);
  version(input.expectedRequirementsVersion, 'expectedRequirementsVersion');
  version(input.expectedContentVersion, 'expectedContentVersion');
  version(input.expectedBindingVersion, 'expectedBindingVersion');
  intent(input.intent, input.nativeTurnId);
  queue(input.queueAfterTurn, input.intent);
  submitter(input.submittedBy);
  jsonSize(input);
}

export function validateNativeCommandSpec(value: unknown): asserts value is NativeCommandSpec {
  const spec = objectFields(value, [
    'schema', 'executor', 'requestId', 'todoId', 'scope', 'binding', 'expected', 'queueAfterTurn', 'intent', 'submittedBy',
  ]);
  if (spec.schema !== NATIVE_CODEX_COMMAND_SCHEMA || spec.executor !== NATIVE_COMMAND_EXECUTOR) {
    throw new Error(t('nav.workContract.unsupportedSchema'));
  }
  identifier(spec.requestId, 'requestId', 256);
  identifier(spec.todoId, 'todoId', 256);
  const scope = objectFields(spec.scope, ['accountScope', 'accountGeneration', 'hostDeviceId']);
  identifier(scope.accountScope, 'accountScope', 2048);
  version(scope.accountGeneration, 'accountGeneration');
  identifier(scope.hostDeviceId, 'hostDeviceId', 256);
  const binding = objectFields(spec.binding, [
    'sessionId', 'nativeThreadId', 'sourceScope', 'executionProfileId', 'workspaceRoot', 'bindingVersion',
  ]);
  identifier(binding.sessionId, 'sessionId', 512);
  identifier(binding.nativeThreadId, 'nativeThreadId', 512);
  identifier(binding.sourceScope, 'sourceScope', 4096);
  identifier(binding.executionProfileId, 'executionProfileId', 256);
  identifier(binding.workspaceRoot, 'workspaceRoot', 32768);
  version(binding.bindingVersion, 'bindingVersion');
  const expected = objectFields(spec.expected, ['requirementsVersion', 'contentVersion', 'nativeTurnId']);
  version(expected.requirementsVersion, 'requirementsVersion');
  version(expected.contentVersion, 'contentVersion');
  intent(spec.intent, expected.nativeTurnId);
  queue(spec.queueAfterTurn, spec.intent);
  submitter(spec.submittedBy);
  jsonSize(spec);
}

/** Ownership detection deliberately does not mean the full payload is valid. */
export function isNativeCommandSpecJson(specJson: string): boolean {
  try {
    const value = JSON.parse(specJson) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).schema === NATIVE_CODEX_COMMAND_SCHEMA
      && (value as Record<string, unknown>).executor === NATIVE_COMMAND_EXECUTOR;
  } catch { return false; }
}

const utf8 = new TextEncoder();
const whitespaceEdge = /^[\s\u0085]|[\s\u0085]$/u;

function objectFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('nav.workContract.mustBeObject'));
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(t('nav.workContract.unknownFields'));
  return record;
}

function identifier(value: unknown, field: string, limit: number): asserts value is string {
  if (typeof value !== 'string' || !value || whitespaceEdge.test(value)
    || /\p{Cc}|[\uD800-\uDFFF]/u.test(value) || utf8.encode(value).length > limit) {
    throw new Error(t('nav.workContract.invalidIdentifier', { field, limit }));
  }
}

function version(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(t('nav.workContract.invalidVersion', { field }));
  }
}

function submitter(value: unknown): void {
  if (value !== 'user' && value !== 'butler' && value !== 'automation') throw new Error(t('nav.workContract.invalidSubmitter'));
}

function intent(value: unknown, nativeTurnId: unknown): void {
  const item = objectFields(value, ['kind', 'text']);
  if (item.kind === 'prompt' || item.kind === 'steer') {
    if (typeof item.text !== 'string' || !/[^\s\u0085]/u.test(item.text)
      || /[\uD800-\uDFFF]/u.test(item.text) || utf8.encode(item.text).length > MAX_COMMAND_TEXT_BYTES) {
      throw new Error(t('nav.workContract.invalidIntentText'));
    }
  } else if (item.kind === 'resume' || item.kind === 'interrupt') {
    if (Object.hasOwn(item, 'text')) throw new Error(t('nav.workContract.intentTextNotAllowed'));
  } else { throw new Error(t('nav.workContract.invalidIntentKind')); }
  if (item.kind === 'steer' || item.kind === 'interrupt') {
    identifier(nativeTurnId, 'nativeTurnId', 512);
  } else if (nativeTurnId !== undefined && nativeTurnId !== null) {
    throw new Error(t('nav.workContract.unexpectedTurnId'));
  }
}

function jsonSize(value: unknown): void {
  if (utf8.encode(JSON.stringify(value)).length > MAX_COMMAND_JSON_BYTES) throw new Error(t('nav.workContract.commandTooLarge'));
}

function queue(value: unknown, commandIntent: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(t('nav.workContract.queueMustBeBoolean'));
  if (value === true && (commandIntent as NativeCodexIntent).kind !== 'prompt') {
    throw new Error(t('nav.workContract.onlyPromptCanQueue'));
  }
}
