import type { NativeDispatchActionRecord, NativeWorkSessionRecord } from '../platform/desktopCommands';
import { NATIVE_CODEX_COMMAND_SCHEMA, NATIVE_COMMAND_EXECUTOR } from '../platform/workRuntimeContract';

function metadata(json: string | null | undefined): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json ?? '{}');
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** A routing reservation, never proof of a live controller or native authorization. */
export function isNativeHostSession(session: Pick<NativeWorkSessionRecord, 'configSnapshotJson'>): boolean {
  const config = metadata(session.configSnapshotJson);
  // Unknown Host metadata must not fall back to the legacy ACP/Pi executor.
  return config !== null ? Object.hasOwn(config, 'nativeHost')
    : /"nativeHost"\s*:/.test(session.configSnapshotJson ?? '');
}

export function isNativeHostWork(todoId: string, sessions: readonly NativeWorkSessionRecord[]): boolean {
  return sessions.some((session) => session.todoId === todoId && isNativeHostSession(session));
}

export function isNativeHostAction(action: Pick<NativeDispatchActionRecord, 'idempotencyKey' | 'specJson'>): boolean {
  if (action.idempotencyKey?.startsWith('native-codex:v1:')) return true;
  const spec = metadata(action.specJson);
  return spec?.schema === NATIVE_CODEX_COMMAND_SCHEMA || spec?.executor === NATIVE_COMMAND_EXECUTOR
    || (typeof spec?.schema === 'string' && spec.schema.startsWith('rocketx.native-codex-command.'));
}

export const NATIVE_HOST_CONTROL_REASON = '该工作由本机后台运行服务控制，请使用原生工作入口';
