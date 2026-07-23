export const BUTLER_MEMORY_SCHEMA_VERSION = 2 as const;

export type ButlerMemoryKind = 'alias' | 'preference' | 'commitment';
export type ButlerMemoryConfidence = 'confirmed' | 'legacy-unverified';
export type ButlerMemoryStatus = 'active' | 'superseded' | 'revoked';

export interface ButlerMemoryScope {
  server: string;
  account: string;
  project?: string;
  room?: string;
}

export interface ButlerMemoryProvenance {
  sessionId?: string;
  taskId?: string;
  callId?: string;
  checkpointId?: string;
  butlerSource: string;
  summary: string;
}

export interface ButlerMemoryRecord {
  id: string;
  kind: ButlerMemoryKind;
  scope: ButlerMemoryScope;
  subject: string;
  value: string;
  due?: string;
  provenance: ButlerMemoryProvenance;
  confidence: ButlerMemoryConfidence;
  createdAt: number;
  confirmedAt: number | null;
  expiresAt: number | null;
  status: ButlerMemoryStatus;
  supersedes: string[];
  supersededBy?: string;
  revokedAt?: number;
  restoredFrom?: string;
}

export interface ButlerMemoryState {
  schemaVersion: typeof BUTLER_MEMORY_SCHEMA_VERSION;
  records: ButlerMemoryRecord[];
}

export interface ButlerMemoryWriteInput {
  kind: ButlerMemoryKind;
  scope: ButlerMemoryScope;
  subject: string;
  value: string;
  due?: string;
  provenance: ButlerMemoryProvenance;
  confidence?: ButlerMemoryConfidence;
  createdAt?: number;
  confirmedAt?: number | null;
  expiresAt?: number | null;
}

export interface ButlerMemoryMutationOptions {
  now?: number;
  createId?: () => string;
}

export interface ButlerMemoryRestoreOptions extends ButlerMemoryMutationOptions {
  provenance?: ButlerMemoryProvenance;
}

export interface ButlerMemoryWriteResult {
  state: ButlerMemoryState;
  record: ButlerMemoryRecord;
  created: boolean;
}

export interface ButlerMemoryRecallOptions {
  query?: string;
  limit?: number;
  now?: number;
  kind?: ButlerMemoryKind;
  includeInactive?: boolean;
  includeHistory?: boolean;
}

export interface ButlerLegacyMemoryEntryV1 {
  id: string;
  text: string;
  at: number;
}

export interface ButlerLegacyImportMapping {
  scope: ButlerMemoryScope;
  kind: ButlerMemoryKind;
  subject: string;
  value: string;
  due?: string;
  provenance: ButlerMemoryProvenance;
  expiresAt?: number | null;
}

export interface ButlerLegacyImportOptions extends ButlerMemoryMutationOptions {
  mapLegacy: (entry: ButlerLegacyMemoryEntryV1) => ButlerLegacyImportMapping;
}

const MEMORY_KINDS = new Set<ButlerMemoryKind>(['alias', 'preference', 'commitment']);
const MEMORY_CONFIDENCES = new Set<ButlerMemoryConfidence>(['confirmed', 'legacy-unverified']);
const MEMORY_STATUSES = new Set<ButlerMemoryStatus>(['active', 'superseded', 'revoked']);
const DYNAMIC_WORK_OBJECT_PATTERN = /\b(pr|pull request|build|calendar|work item|todo)\b|拉取请求|构建|日程|工作项|待办/iu;
const DYNAMIC_WORK_STATE_PATTERN = /\b(open|opened|closed|merged|failed|failing|running|pending|status|today|done)\b|当前|今天|状态|进行中|失败|已失败|已合并|已关闭|已完成|未完成|待处理/iu;

function emptyState(): ButlerMemoryState {
  return { schemaVersion: BUTLER_MEMORY_SCHEMA_VERSION, records: [] };
}

function defaultCreateId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `memory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRequiredText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是非空字符串`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  return normalizeRequiredText(value, field);
}

function normalizeScopeSegment(value: unknown, field: string): string {
  return normalizeRequiredText(value, field).toLocaleLowerCase();
}

function normalizeOptionalScopeSegment(value: unknown, field: string): string | undefined {
  const normalized = normalizeOptionalText(value, field);
  return normalized?.toLocaleLowerCase();
}

function normalizeTimestamp(value: unknown, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} 必须是有限时间戳`);
  return Number(value);
}

function normalizeNullableTimestamp(value: unknown, field: string): number | null {
  if (value == null) return null;
  return normalizeTimestamp(value, field);
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
  return Array.from(new Set(value.map((item) => normalizeRequiredText(item, field))));
}

function sortRecords(records: readonly ButlerMemoryRecord[]): ButlerMemoryRecord[] {
  return [...records].sort((left, right) =>
    (right.createdAt - left.createdAt)
    || (right.confirmedAt ?? -1) - (left.confirmedAt ?? -1)
    || left.id.localeCompare(right.id));
}

function normalizeLegacyEntry(value: unknown): ButlerLegacyMemoryEntryV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ButlerLegacyMemoryEntryV1>;
  try {
    return {
      id: normalizeRequiredText(candidate.id, 'legacy.id'),
      text: normalizeRequiredText(candidate.text, 'legacy.text'),
      at: normalizeTimestamp(candidate.at, 'legacy.at'),
    };
  } catch {
    return undefined;
  }
}

function normalizeWriteTimes(input: ButlerMemoryWriteInput, now: number): Pick<ButlerMemoryRecord, 'createdAt' | 'confirmedAt' | 'expiresAt'> {
  const confidence = input.confidence ?? 'confirmed';
  const createdAt = input.createdAt == null ? now : normalizeTimestamp(input.createdAt, 'createdAt');
  const confirmedAt = input.confirmedAt === undefined
    ? (confidence === 'confirmed' ? createdAt : null)
    : normalizeNullableTimestamp(input.confirmedAt, 'confirmedAt');
  if (confidence === 'confirmed' && confirmedAt == null) throw new Error('confirmed 记录必须包含 confirmedAt');
  if (confidence === 'legacy-unverified' && confirmedAt != null) throw new Error('legacy-unverified 记录不能包含 confirmedAt');
  return {
    createdAt,
    confirmedAt,
    expiresAt: normalizeNullableTimestamp(input.expiresAt, 'expiresAt'),
  };
}

function dynamicWorkStateDetected(subject: string, value: string, due?: string): boolean {
  const haystack = `${subject}\n${value}\n${due ?? ''}`;
  return DYNAMIC_WORK_OBJECT_PATTERN.test(haystack) && DYNAMIC_WORK_STATE_PATTERN.test(haystack);
}

function normalizeWriteInput(input: ButlerMemoryWriteInput, now: number): Omit<ButlerMemoryRecord, 'id' | 'status' | 'supersedes' | 'supersededBy' | 'revokedAt' | 'restoredFrom'> {
  if (!MEMORY_KINDS.has(input.kind)) throw new Error('kind 不受支持');
  const subject = normalizeRequiredText(input.subject, 'subject');
  const value = normalizeRequiredText(input.value, 'value');
  const due = normalizeOptionalText(input.due, 'due');
  if (due && input.kind !== 'commitment') throw new Error('只有 commitment 可以包含 due');
  if (dynamicWorkStateDetected(subject, value, due)) {
    throw new Error('动态工作状态不能写入长期记忆');
  }
  const confidence = input.confidence ?? 'confirmed';
  if (!MEMORY_CONFIDENCES.has(confidence)) throw new Error('confidence 不受支持');
  return {
    kind: input.kind,
    scope: normalizeButlerMemoryScope(input.scope),
    subject,
    value,
    ...(due ? { due } : {}),
    provenance: normalizeButlerMemoryProvenance(input.provenance),
    confidence,
    ...normalizeWriteTimes(input, now),
  };
}

function sameScope(left: ButlerMemoryScope, right: ButlerMemoryScope): boolean {
  return left.server === right.server
    && left.account === right.account
    && left.project === right.project
    && left.room === right.room;
}

function samePayload(
  left: ButlerMemoryRecord,
  right: Omit<ButlerMemoryRecord, 'id' | 'status' | 'supersedes' | 'supersededBy' | 'revokedAt' | 'restoredFrom'>,
): boolean {
  return left.kind === right.kind
    && sameScope(left.scope, right.scope)
    && left.subject.trim().toLocaleLowerCase() === right.subject.trim().toLocaleLowerCase()
    && left.value === right.value
    && left.due === right.due
    && left.confidence === right.confidence
    && left.expiresAt === right.expiresAt;
}

function conflictKey(kind: ButlerMemoryKind, scope: ButlerMemoryScope, subject: string): string {
  return JSON.stringify({
    kind,
    server: scope.server,
    account: scope.account,
    project: scope.project ?? null,
    room: scope.room ?? null,
    subject: subject.trim().toLocaleLowerCase(),
  });
}

function normalizeLimit(limit: number | undefined): number {
  if (limit == null) return 20;
  if (!Number.isFinite(limit)) return 20;
  return Math.max(0, Math.trunc(limit));
}

function recordMatchesScope(record: ButlerMemoryRecord, scope: ButlerMemoryScope): boolean {
  if (record.scope.server !== scope.server || record.scope.account !== scope.account) return false;
  if (record.scope.project == null && record.scope.room == null) return true;
  return record.scope.project === scope.project && record.scope.room === scope.room;
}

function mergeRecord(
  state: ButlerMemoryState,
  input: Omit<ButlerMemoryRecord, 'id' | 'status' | 'supersedes' | 'supersededBy' | 'revokedAt' | 'restoredFrom'>,
  options: ButlerMemoryMutationOptions,
  extra?: Pick<ButlerMemoryRecord, 'restoredFrom'>,
): ButlerMemoryWriteResult {
  const normalizedState = normalizeButlerMemoryState(state);
  const activeConflicts = normalizedState.records.filter((record) =>
    record.status === 'active' && conflictKey(record.kind, record.scope, record.subject) === conflictKey(input.kind, input.scope, input.subject));
  const existing = extra?.restoredFrom ? undefined : activeConflicts.find((record) => samePayload(record, input));
  if (existing) return { state: normalizedState, record: existing, created: false };
  const createId = options.createId ?? defaultCreateId;
  const nextId = createId();
  const supersedes = activeConflicts.map((record) => record.id);
  const records = normalizedState.records.map((record) =>
    supersedes.includes(record.id)
      ? { ...record, status: 'superseded' as const, supersededBy: nextId }
      : record);
  const record: ButlerMemoryRecord = {
    id: nextId,
    ...input,
    status: 'active',
    supersedes,
    ...(extra?.restoredFrom ? { restoredFrom: extra.restoredFrom } : {}),
  };
  return {
    state: {
      schemaVersion: BUTLER_MEMORY_SCHEMA_VERSION,
      records: sortRecords([record, ...records]),
    },
    record,
    created: true,
  };
}

export function normalizeButlerMemoryScope(value: unknown): ButlerMemoryScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('scope 必须是对象');
  const candidate = value as Partial<ButlerMemoryScope>;
  const project = normalizeOptionalScopeSegment(candidate.project, 'scope.project');
  const room = normalizeOptionalScopeSegment(candidate.room, 'scope.room');
  return {
    server: normalizeScopeSegment(candidate.server, 'scope.server'),
    account: normalizeScopeSegment(candidate.account, 'scope.account'),
    ...(project ? { project } : {}),
    ...(room ? { room } : {}),
  };
}

export function normalizeButlerMemoryProvenance(value: unknown): ButlerMemoryProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provenance 必须是对象');
  const candidate = value as Partial<ButlerMemoryProvenance>;
  const sessionId = normalizeOptionalText(candidate.sessionId, 'provenance.sessionId');
  const taskId = normalizeOptionalText(candidate.taskId, 'provenance.taskId');
  const callId = normalizeOptionalText(candidate.callId, 'provenance.callId');
  const checkpointId = normalizeOptionalText(candidate.checkpointId, 'provenance.checkpointId');
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(callId ? { callId } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    butlerSource: normalizeRequiredText(candidate.butlerSource, 'provenance.butlerSource'),
    summary: normalizeRequiredText(candidate.summary, 'provenance.summary'),
  };
}

export function normalizeButlerMemoryRecord(value: unknown): ButlerMemoryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record 必须是对象');
  const candidate = value as Partial<ButlerMemoryRecord>;
  if (!MEMORY_KINDS.has(candidate.kind as ButlerMemoryKind)) throw new Error('record.kind 不受支持');
  const kind = candidate.kind as ButlerMemoryKind;
  const subject = normalizeRequiredText(candidate.subject, 'record.subject');
  const valueText = normalizeRequiredText(candidate.value, 'record.value');
  const due = normalizeOptionalText(candidate.due, 'record.due');
  if (due && kind !== 'commitment') throw new Error('只有 commitment 可以包含 due');
  if (dynamicWorkStateDetected(subject, valueText, due)) throw new Error('动态工作状态不能写入长期记忆');
  if (!MEMORY_CONFIDENCES.has(candidate.confidence as ButlerMemoryConfidence)) throw new Error('record.confidence 不受支持');
  if (!MEMORY_STATUSES.has(candidate.status as ButlerMemoryStatus)) throw new Error('record.status 不受支持');
  const confidence = candidate.confidence as ButlerMemoryConfidence;
  const confirmedAt = normalizeNullableTimestamp(candidate.confirmedAt, 'record.confirmedAt');
  if (confidence === 'confirmed' && confirmedAt == null) throw new Error('confirmed 记录必须包含 confirmedAt');
  if (confidence === 'legacy-unverified' && confirmedAt != null) throw new Error('legacy-unverified 记录不能包含 confirmedAt');
  const supersedes = normalizeStringArray(candidate.supersedes ?? [], 'record.supersedes');
  return {
    id: normalizeRequiredText(candidate.id, 'record.id'),
    kind,
    scope: normalizeButlerMemoryScope(candidate.scope),
    subject,
    value: valueText,
    ...(due ? { due } : {}),
    provenance: normalizeButlerMemoryProvenance(candidate.provenance),
    confidence,
    createdAt: normalizeTimestamp(candidate.createdAt, 'record.createdAt'),
    confirmedAt,
    expiresAt: normalizeNullableTimestamp(candidate.expiresAt, 'record.expiresAt'),
    status: candidate.status as ButlerMemoryStatus,
    supersedes,
    ...(candidate.supersededBy == null ? {} : { supersededBy: normalizeRequiredText(candidate.supersededBy, 'record.supersededBy') }),
    ...(candidate.revokedAt == null ? {} : { revokedAt: normalizeTimestamp(candidate.revokedAt, 'record.revokedAt') }),
    ...(candidate.restoredFrom == null ? {} : { restoredFrom: normalizeRequiredText(candidate.restoredFrom, 'record.restoredFrom') }),
  };
}

export function normalizeButlerMemoryState(value: unknown): ButlerMemoryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
  const candidate = value as Partial<ButlerMemoryState>;
  if (candidate.schemaVersion !== BUTLER_MEMORY_SCHEMA_VERSION || !Array.isArray(candidate.records)) return emptyState();
  return {
    schemaVersion: BUTLER_MEMORY_SCHEMA_VERSION,
    records: sortRecords(candidate.records.flatMap((record) => {
      try {
        return [normalizeButlerMemoryRecord(record)];
      } catch {
        return [];
      }
    })),
  };
}

export function parseButlerMemoryState(raw: string): ButlerMemoryState {
  if (!raw.trim()) return emptyState();
  try {
    return normalizeButlerMemoryState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

export function serializeButlerMemoryState(value: unknown): string {
  return JSON.stringify(normalizeButlerMemoryState(value));
}

export function rememberButlerMemory(
  state: ButlerMemoryState,
  input: ButlerMemoryWriteInput,
  options: ButlerMemoryMutationOptions = {},
): ButlerMemoryWriteResult {
  const now = options.now ?? Date.now();
  return mergeRecord(normalizeButlerMemoryState(state), normalizeWriteInput(input, now), options);
}

export function recallButlerMemory(
  state: ButlerMemoryState,
  scope: ButlerMemoryScope,
  options: ButlerMemoryRecallOptions = {},
): ButlerMemoryRecord[] {
  const normalizedState = normalizeButlerMemoryState(state);
  const normalizedScope = normalizeButlerMemoryScope(scope);
  const normalizedQuery = options.query?.trim().toLocaleLowerCase() ?? '';
  const limit = normalizeLimit(options.limit);
  const now = options.now ?? Date.now();
  const includeInactive = options.includeInactive === true || options.includeHistory === true;
  const includeHistory = options.includeHistory === true;
  return normalizedState.records
    .filter((record) => includeInactive || record.status === 'active')
    .filter((record) => includeHistory || record.expiresAt == null || record.expiresAt > now)
    .filter((record) => recordMatchesScope(record, normalizedScope))
    .filter((record) => options.kind == null || record.kind === options.kind)
    .filter((record) => {
      if (!normalizedQuery) return true;
      const haystack = `${record.subject}\n${record.value}\n${record.due ?? ''}`.toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .slice(0, limit);
}

export function revokeButlerMemory(
  state: ButlerMemoryState,
  id: string,
  options: ButlerMemoryMutationOptions = {},
): ButlerMemoryWriteResult | undefined {
  const normalizedState = normalizeButlerMemoryState(state);
  const normalizedId = normalizeRequiredText(id, 'id');
  const current = normalizedState.records.find((record) => record.id === normalizedId);
  if (!current) return undefined;
  if (current.status !== 'active') return { state: normalizedState, record: current, created: false };
  const now = options.now ?? Date.now();
  const record: ButlerMemoryRecord = {
    ...current,
    status: 'revoked',
    revokedAt: now,
  };
  return {
    state: {
      schemaVersion: BUTLER_MEMORY_SCHEMA_VERSION,
      records: sortRecords(normalizedState.records.map((item) => item.id === normalizedId ? record : item)),
    },
    record,
    created: false,
  };
}

export function restoreButlerMemory(
  state: ButlerMemoryState,
  id: string,
  options: ButlerMemoryRestoreOptions = {},
): ButlerMemoryWriteResult {
  const normalizedState = normalizeButlerMemoryState(state);
  const normalizedId = normalizeRequiredText(id, 'id');
  const target = normalizedState.records.find((record) => record.id === normalizedId);
  if (!target) throw new Error(`未找到记忆：${normalizedId}`);
  const now = options.now ?? Date.now();
  return mergeRecord(normalizedState, {
    kind: target.kind,
    scope: target.scope,
    subject: target.subject,
    value: target.value,
    ...(target.due ? { due: target.due } : {}),
    provenance: options.provenance
      ? normalizeButlerMemoryProvenance(options.provenance)
      : target.provenance,
    confidence: target.confidence,
    createdAt: now,
    confirmedAt: target.confidence === 'confirmed' ? now : null,
    expiresAt: target.expiresAt,
  }, options, { restoredFrom: target.id });
}

export function importLegacyButlerMemory(
  state: ButlerMemoryState,
  legacyEntries: readonly ButlerLegacyMemoryEntryV1[],
  options: ButlerLegacyImportOptions,
): ButlerMemoryWriteResult[] {
  let nextState = normalizeButlerMemoryState(state);
  const results: ButlerMemoryWriteResult[] = [];
  for (const rawEntry of legacyEntries) {
    const entry = normalizeLegacyEntry(rawEntry);
    if (!entry) continue;
    const mapped = options.mapLegacy(entry);
    const result = mergeRecord(nextState, normalizeWriteInput({
      ...mapped,
      confidence: 'legacy-unverified',
      createdAt: entry.at,
      confirmedAt: null,
      expiresAt: mapped.expiresAt ?? null,
    }, entry.at), options);
    nextState = result.state;
    results.push(result);
  }
  return results;
}
