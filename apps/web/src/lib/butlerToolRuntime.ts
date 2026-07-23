export type ButlerToolEffect = 'read' | 'draft' | 'write';

export type ButlerToolCheckpointStatus =
  | 'approval-required'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ButlerToolErrorKind =
  | 'validation'
  | 'preflight'
  | 'approval-required'
  | 'conflict'
  | 'execution'
  | 'recovery';

export interface ButlerToolError {
  kind: ButlerToolErrorKind;
  message: string;
  retryable: boolean;
}

export interface ButlerToolCheckpoint {
  version: 1;
  id: string;
  toolName: string;
  effect: ButlerToolEffect;
  capability: string;
  idempotencyKey: string;
  status: ButlerToolCheckpointStatus;
  params: Record<string, unknown>;
  preview: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: ButlerToolError;
}

export interface ButlerToolAuditEntry {
  id: string;
  timestamp: number;
  appId: 'builtin:butler';
  action: string;
  allowed: boolean;
  operationId: string;
  toolName: string;
  effect: ButlerToolEffect;
  capability: string;
  idempotencyKey: string;
  reason?: string;
}

export interface ButlerToolRuntimeContext {
  taskId?: string;
  callId?: string;
  now?: () => number;
  loadCheckpoint?: (id: string) => ButlerToolCheckpoint | undefined | Promise<ButlerToolCheckpoint | undefined>;
  saveCheckpoint?: (checkpoint: ButlerToolCheckpoint) => void | Promise<void>;
  requestApproval?: (checkpoint: ButlerToolCheckpoint) => void | Promise<void>;
  writeAudit?: (entry: ButlerToolAuditEntry) => void | Promise<void>;
}

export interface ButlerToolResult {
  status: 'completed' | 'approval-required' | 'failed' | 'cancelled';
  toolName: string;
  effect: ButlerToolEffect;
  capability: string;
  preview?: string;
  content?: string;
  error?: ButlerToolError;
  checkpoint?: ButlerToolCheckpoint;
}

export interface ButlerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: ButlerToolEffect;
  capability: string;
  invoke: (args: Record<string, unknown>, context?: ButlerToolRuntimeContext) => Promise<ButlerToolResult>;
  approve?: (checkpoint: ButlerToolCheckpoint, context?: ButlerToolRuntimeContext) => Promise<ButlerToolResult>;
}

export interface ButlerToolPreflight {
  allowed: boolean;
  preview?: string;
  reason?: string;
}

export interface ButlerToolDefinition<TArgs extends Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: ButlerToolEffect;
  capability: string;
  preflight?: (args: TArgs) => ButlerToolPreflight | Promise<ButlerToolPreflight>;
  preview?: (args: TArgs) => string;
  idempotencyKey?: (args: TArgs, context: ButlerToolRuntimeContext) => string;
  execute: (
    args: TArgs,
    input: { checkpoint: ButlerToolCheckpoint; context: ButlerToolRuntimeContext },
  ) => string | Promise<string>;
}

interface CreateCheckpointInput {
  id?: string;
  toolName: string;
  effect: ButlerToolEffect;
  capability: string;
  idempotencyKey?: string;
  status: ButlerToolCheckpointStatus;
  params: Record<string, unknown>;
  preview: string;
  attempts?: number;
  now?: number;
  result?: string;
  error?: ButlerToolError;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hash(value: string): string {
  let result = 14_695_981_039_346_656_037n;
  for (let index = 0; index < value.length; index += 1) {
    result ^= BigInt(value.charCodeAt(index));
    result = BigInt.asUintN(64, result * 1_099_511_628_211n);
  }
  return result.toString(36);
}

function checkpointId(idempotencyKey: string): string {
  return `butler-op-${hash(idempotencyKey)}`;
}

function runtimeNow(context: ButlerToolRuntimeContext): number {
  return context.now?.() ?? Date.now();
}

function isEffect(value: unknown): value is ButlerToolEffect {
  return value === 'read' || value === 'draft' || value === 'write';
}

function isStatus(value: unknown): value is ButlerToolCheckpointStatus {
  return value === 'approval-required'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled';
}

function isError(value: unknown): value is ButlerToolError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ButlerToolError>;
  return (
    candidate.kind === 'validation'
    || candidate.kind === 'preflight'
    || candidate.kind === 'approval-required'
    || candidate.kind === 'conflict'
    || candidate.kind === 'execution'
    || candidate.kind === 'recovery'
  ) && typeof candidate.message === 'string' && typeof candidate.retryable === 'boolean';
}

export function createButlerToolCheckpoint(input: CreateCheckpointInput): ButlerToolCheckpoint {
  const now = Number.isFinite(input.now) ? input.now! : Date.now();
  const rawIdempotencyKey = input.idempotencyKey
    ?? `${input.toolName}:${stableJson(input.params)}`;
  const idempotencyKey = `butler-key-${hash(rawIdempotencyKey)}`;
  return {
    version: 1,
    id: input.id ?? checkpointId(idempotencyKey),
    toolName: input.toolName,
    effect: input.effect,
    capability: input.capability,
    idempotencyKey,
    status: input.status,
    params: stableValue(input.params) as Record<string, unknown>,
    preview: input.preview,
    attempts: input.attempts ?? 0,
    createdAt: now,
    updatedAt: now,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

/** Persisted checkpoints are untrusted input; callers should catch invalid records. */
export function normalizeButlerToolCheckpoint(value: unknown): ButlerToolCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool checkpoint 必须是对象');
  const candidate = value as Partial<ButlerToolCheckpoint>;
  if (candidate.version !== 1) throw new Error('tool checkpoint 版本不受支持');
  if (!candidate.id || typeof candidate.id !== 'string') throw new Error('tool checkpoint id 无效');
  if (!candidate.toolName || typeof candidate.toolName !== 'string') throw new Error('tool checkpoint toolName 无效');
  if (!isEffect(candidate.effect)) throw new Error('tool checkpoint effect 无效');
  if (!candidate.capability || typeof candidate.capability !== 'string') throw new Error('tool checkpoint capability 无效');
  if (!candidate.idempotencyKey || typeof candidate.idempotencyKey !== 'string') throw new Error('tool checkpoint idempotencyKey 无效');
  if (!isStatus(candidate.status)) throw new Error('tool checkpoint status 无效');
  if (!candidate.params || typeof candidate.params !== 'object' || Array.isArray(candidate.params)) throw new Error('tool checkpoint params 无效');
  if (typeof candidate.preview !== 'string') throw new Error('tool checkpoint preview 无效');
  if (!Number.isInteger(candidate.attempts) || candidate.attempts! < 0) throw new Error('tool checkpoint attempts 无效');
  if (!Number.isFinite(candidate.createdAt) || !Number.isFinite(candidate.updatedAt)) throw new Error('tool checkpoint 时间无效');
  if (candidate.result !== undefined && typeof candidate.result !== 'string') throw new Error('tool checkpoint result 无效');
  if (candidate.error !== undefined && !isError(candidate.error)) throw new Error('tool checkpoint error 无效');
  return {
    version: 1,
    id: candidate.id,
    toolName: candidate.toolName,
    effect: candidate.effect,
    capability: candidate.capability,
    idempotencyKey: candidate.idempotencyKey,
    status: candidate.status,
    params: stableValue(candidate.params) as Record<string, unknown>,
    preview: candidate.preview,
    attempts: candidate.attempts!,
    createdAt: candidate.createdAt!,
    updatedAt: candidate.updatedAt!,
    ...(candidate.result !== undefined ? { result: candidate.result } : {}),
    ...(candidate.error ? { error: { ...candidate.error } } : {}),
  };
}

export function recoverButlerToolCheckpoint(
  checkpoint: ButlerToolCheckpoint,
  now = Date.now(),
): ButlerToolCheckpoint {
  if (checkpoint.status !== 'running') return checkpoint;
  return {
    ...checkpoint,
    status: 'failed',
    updatedAt: now,
    error: {
      kind: 'recovery',
      message: '上次执行在完成前中断，请核对副作用后再明确重试。',
      retryable: true,
    },
  };
}

function auditId(checkpoint: ButlerToolCheckpoint, status: ButlerToolCheckpointStatus, now: number): string {
  return `${checkpoint.id}:${status}:${now}`;
}

async function writeAudit(
  checkpoint: ButlerToolCheckpoint,
  context: ButlerToolRuntimeContext,
): Promise<void> {
  if (!context.writeAudit) return;
  const now = runtimeNow(context);
  await context.writeAudit({
    id: auditId(checkpoint, checkpoint.status, now),
    timestamp: now,
    appId: 'builtin:butler',
    action: `butler.tool.${checkpoint.toolName}.${checkpoint.status}`,
    allowed: checkpoint.status !== 'failed' && checkpoint.status !== 'cancelled',
    operationId: checkpoint.id,
    toolName: checkpoint.toolName,
    effect: checkpoint.effect,
    capability: checkpoint.capability,
    idempotencyKey: checkpoint.idempotencyKey,
    ...(checkpoint.error?.message ? { reason: checkpoint.error.message } : {}),
  });
}

async function saveCheckpoint(
  checkpoint: ButlerToolCheckpoint,
  context: ButlerToolRuntimeContext,
): Promise<void> {
  await context.saveCheckpoint?.(checkpoint);
  try {
    await writeAudit(checkpoint, context);
  } catch (error) {
    console.warn('[Butler tool runtime] 审计写入失败', error);
  }
}

export async function recordButlerToolCheckpoint(
  checkpoint: ButlerToolCheckpoint,
  context: ButlerToolRuntimeContext = {},
): Promise<void> {
  await saveCheckpoint(checkpoint, context);
}

async function currentCheckpoint(
  checkpoint: ButlerToolCheckpoint,
  context: ButlerToolRuntimeContext,
): Promise<ButlerToolCheckpoint> {
  return await context.loadCheckpoint?.(checkpoint.id) ?? checkpoint;
}

export async function beginButlerToolCheckpoint(
  checkpoint: ButlerToolCheckpoint,
  context: ButlerToolRuntimeContext = {},
): Promise<ButlerToolCheckpoint> {
  const current = await currentCheckpoint(checkpoint, context);
  if (current.status === 'running') throw new Error('工具正在执行，不能重复提交');
  if (current.status === 'completed') return current;
  if (current.status === 'cancelled') throw new Error('工具调用已取消');
  const running: ButlerToolCheckpoint = {
    ...current,
    status: 'running',
    attempts: current.attempts + 1,
    updatedAt: runtimeNow(context),
    error: undefined,
  };
  await saveCheckpoint(running, context);
  return running;
}

export async function completeButlerToolCheckpoint(
  checkpoint: ButlerToolCheckpoint,
  result: string,
  context: ButlerToolRuntimeContext = {},
): Promise<ButlerToolCheckpoint> {
  const current = await currentCheckpoint(checkpoint, context);
  if (current.status === 'completed') return current;
  if (current.status !== 'running') throw new Error('工具不在执行状态，不能标记完成');
  const completed: ButlerToolCheckpoint = {
    ...current,
    status: 'completed',
    result,
    updatedAt: runtimeNow(context),
    error: undefined,
  };
  await saveCheckpoint(completed, context);
  return completed;
}

export async function failButlerToolCheckpoint(
  checkpoint: ButlerToolCheckpoint,
  error: ButlerToolError,
  context: ButlerToolRuntimeContext = {},
): Promise<ButlerToolCheckpoint> {
  const current = await currentCheckpoint(checkpoint, context);
  if (current.status === 'completed' || current.status === 'cancelled') return current;
  const failed: ButlerToolCheckpoint = {
    ...current,
    status: 'failed',
    updatedAt: runtimeNow(context),
    error,
  };
  await saveCheckpoint(failed, context);
  return failed;
}

function resultFromCheckpoint(checkpoint: ButlerToolCheckpoint): ButlerToolResult {
  const status = checkpoint.status === 'running' ? 'failed' : checkpoint.status;
  return {
    status,
    toolName: checkpoint.toolName,
    effect: checkpoint.effect,
    capability: checkpoint.capability,
    preview: checkpoint.preview,
    ...(checkpoint.result !== undefined ? { content: checkpoint.result } : {}),
    ...(checkpoint.error ? { error: checkpoint.error } : {}),
    checkpoint,
  };
}

function failedResult(
  definition: Pick<ButlerToolDefinition<Record<string, unknown>>, 'name' | 'effect' | 'capability'>,
  kind: ButlerToolErrorKind,
  message: string,
  retryable = false,
): ButlerToolResult {
  return {
    status: 'failed',
    toolName: definition.name,
    effect: definition.effect,
    capability: definition.capability,
    error: { kind, message, retryable },
  };
}

function typeMatches(value: unknown, type: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  return true;
}

function validateValue(value: unknown, schema: unknown, path: string): string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const definition = schema as Record<string, unknown>;
  if (!typeMatches(value, definition.type)) return `${path} 类型必须是 ${String(definition.type)}`;
  if (definition.type === 'array' && Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateValue(value[index], definition.items, `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (definition.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const properties = definition.properties && typeof definition.properties === 'object'
    ? definition.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(definition.required)
    ? definition.required.filter((item): item is string => typeof item === 'string')
    : [];
  const missing = required.find((key) => !(key in record));
  if (missing) return `${path}.${missing} 为必填字段`;
  if (definition.additionalProperties === false) {
    const extra = Object.keys(record).find((key) => !(key in properties));
    if (extra) return `${path}.${extra} 不是允许的字段`;
  }
  for (const [key, child] of Object.entries(record)) {
    if (!(key in properties)) continue;
    const error = validateValue(child, properties[key], `${path}.${key}`);
    if (error) return error;
  }
  return undefined;
}

function validateArguments(args: Record<string, unknown>, parameters: Record<string, unknown>): string | undefined {
  return validateValue(args, parameters, 'args');
}

function operationKey<TArgs extends Record<string, unknown>>(
  definition: ButlerToolDefinition<TArgs>,
  args: TArgs,
  context: ButlerToolRuntimeContext,
): string {
  if (definition.idempotencyKey) return definition.idempotencyKey(args, context);
  const scope = context.taskId || context.callId || 'session';
  return `${scope}:${definition.name}:${stableJson(args)}`;
}

async function executeApproved<TArgs extends Record<string, unknown>>(
  definition: ButlerToolDefinition<TArgs>,
  checkpoint: ButlerToolCheckpoint,
  context: ButlerToolRuntimeContext,
): Promise<ButlerToolResult> {
  const stored = await context.loadCheckpoint?.(checkpoint.id);
  const current = stored ?? checkpoint;
  if (current.idempotencyKey !== checkpoint.idempotencyKey || current.toolName !== definition.name) {
    return failedResult(definition as ButlerToolDefinition<Record<string, unknown>>, 'conflict', 'checkpoint 与工具调用不匹配');
  }
  if (current.status === 'completed') return resultFromCheckpoint(current);
  if (current.status === 'cancelled') return resultFromCheckpoint(current);
  if (current.status === 'running') {
    return failedResult(definition as ButlerToolDefinition<Record<string, unknown>>, 'conflict', '工具正在执行，不能重复提交', true);
  }

  const args = current.params as TArgs;
  const preflight = await definition.preflight?.(args) ?? { allowed: true, preview: current.preview };
  if (!preflight.allowed) {
    const failed: ButlerToolCheckpoint = {
      ...current,
      status: 'failed',
      updatedAt: runtimeNow(context),
      error: { kind: 'preflight', message: preflight.reason ?? '能力预检未通过', retryable: true },
    };
    await saveCheckpoint(failed, context);
    return resultFromCheckpoint(failed);
  }

  const running: ButlerToolCheckpoint = {
    ...current,
    status: 'running',
    attempts: current.attempts + 1,
    updatedAt: runtimeNow(context),
    preview: preflight.preview ?? current.preview,
    error: undefined,
  };
  await saveCheckpoint(running, context);
  try {
    const content = await definition.execute(args, { checkpoint: running, context });
    const completed: ButlerToolCheckpoint = {
      ...running,
      status: 'completed',
      result: content,
      updatedAt: runtimeNow(context),
      error: undefined,
    };
    await saveCheckpoint(completed, context);
    return resultFromCheckpoint(completed);
  } catch (error) {
    const failed: ButlerToolCheckpoint = {
      ...running,
      status: 'failed',
      updatedAt: runtimeNow(context),
      error: {
        kind: 'execution',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
    await saveCheckpoint(failed, context);
    return resultFromCheckpoint(failed);
  }
}

export function defineButlerTool<TArgs extends Record<string, unknown>>(
  definition: ButlerToolDefinition<TArgs>,
): ButlerTool {
  const invoke = async (
    rawArgs: Record<string, unknown>,
    context: ButlerToolRuntimeContext = {},
  ): Promise<ButlerToolResult> => {
    const validationError = validateArguments(rawArgs, definition.parameters);
    if (validationError) {
      return failedResult(
        definition as ButlerToolDefinition<Record<string, unknown>>,
        'validation',
        validationError,
      );
    }
    const args = rawArgs as TArgs;
    let preflight: ButlerToolPreflight;
    try {
      preflight = await definition.preflight?.(args) ?? { allowed: true };
    } catch (error) {
      return failedResult(
        definition as ButlerToolDefinition<Record<string, unknown>>,
        'preflight',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!preflight.allowed) {
      return failedResult(
        definition as ButlerToolDefinition<Record<string, unknown>>,
        'preflight',
        preflight.reason ?? '能力预检未通过',
      );
    }
    const preview = preflight.preview ?? definition.preview?.(args) ?? definition.description;
    const rawIdempotencyKey = operationKey(definition, args, context);
    const checkpoint = createButlerToolCheckpoint({
      toolName: definition.name,
      effect: definition.effect,
      capability: definition.capability,
      idempotencyKey: rawIdempotencyKey,
      status: 'approval-required',
      params: args,
      preview,
      now: runtimeNow(context),
    });
    const stored = await context.loadCheckpoint?.(checkpoint.id);
    if (stored) {
      if (stored.idempotencyKey !== checkpoint.idempotencyKey || stored.toolName !== definition.name) {
        return failedResult(
          definition as ButlerToolDefinition<Record<string, unknown>>,
          'conflict',
          'checkpoint id 冲突',
        );
      }
      if (definition.effect === 'write' || stored.status === 'completed') return resultFromCheckpoint(stored);
    }
    if (definition.effect === 'write') {
      await saveCheckpoint(checkpoint, context);
      await context.requestApproval?.(checkpoint);
      return resultFromCheckpoint(checkpoint);
    }
    return executeApproved(definition, checkpoint, context);
  };

  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    effect: definition.effect,
    capability: definition.capability,
    invoke,
    ...(definition.effect === 'write'
      ? { approve: (checkpoint: ButlerToolCheckpoint, context: ButlerToolRuntimeContext = {}) => (
        executeApproved(definition, checkpoint, context)
      ) }
      : {}),
  };
}

export async function cancelButlerToolCheckpoint(
  checkpoint: ButlerToolCheckpoint,
  context: ButlerToolRuntimeContext = {},
): Promise<ButlerToolCheckpoint> {
  const stored = await context.loadCheckpoint?.(checkpoint.id);
  const current = stored ?? checkpoint;
  if (current.status === 'completed' || current.status === 'cancelled') return current;
  const cancelled: ButlerToolCheckpoint = {
    ...current,
    status: 'cancelled',
    updatedAt: runtimeNow(context),
    error: undefined,
  };
  await saveCheckpoint(cancelled, context);
  return cancelled;
}

export function formatButlerToolResult(result: ButlerToolResult): string {
  if (result.status === 'completed') return result.content ?? '';
  if (result.status === 'approval-required') {
    return `approval-required：${result.preview ?? '该写操作需要用户确认'}；尚未执行。`;
  }
  if (result.status === 'cancelled') return '工具调用已取消。';
  const prefix = result.error?.kind === 'validation' ? '工具参数无效' : '工具执行失败';
  return `${prefix}：${result.error?.message ?? '未知错误'}`;
}
