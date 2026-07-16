import { isTauri } from './http';

export type DiagnosticLevel = 'info' | 'warn' | 'error';

const SECRET_VALUE = /(["']?(?:authorization|x-auth-token|x-user-id|password|passwd|pat|token|authToken)["']?\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?["']?([^\s,;&"']+)["']?/gi;
const SECRET_QUERY = /([?&](?:password|passwd|pat|token|authToken|access_token)=)[^&#\s]*/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(SECRET_QUERY, '$1[REDACTED]')
    .replace(SECRET_VALUE, '$1[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1_000);
}

export function diagnosticErrorSummary(value: unknown): string {
  if (value instanceof Error) {
    return sanitizeDiagnosticText(`${value.name}: ${value.message}`);
  }
  return sanitizeDiagnosticText(typeof value === 'string' ? value : 'Unknown error');
}

export async function writeDiagnostic(
  level: DiagnosticLevel,
  area: string,
  message: string,
): Promise<void> {
  if (!isTauri) return;
  const safe = `[${sanitizeDiagnosticText(area)}] ${sanitizeDiagnosticText(message)}`;
  try {
    const logger = await import('@tauri-apps/plugin-log');
    await logger[level](safe);
  } catch {
    // 诊断记录不能反过来影响主流程。
  }
}

export interface DiagnosticSnapshot {
  appVersion: string;
  authStatus: string;
  chatConnection: string;
  serverOrigin: string;
  adoMode: string;
}

export function buildDiagnosticReport(snapshot: DiagnosticSnapshot, logs: string): string {
  const fields = [
    ['generated_at', new Date().toISOString()],
    ['app_version', snapshot.appVersion],
    ['runtime', 'desktop'],
    ['platform', typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent],
    ['auth_status', snapshot.authStatus],
    ['chat_connection', snapshot.chatConnection],
    ['rocket_chat_origin', snapshot.serverOrigin || 'not_configured'],
    ['ado_mode', snapshot.adoMode],
  ];
  const header = fields
    .map(([key, value]) => `${key}: ${sanitizeDiagnosticText(value)}`)
    .join('\n');
  const safeLogs = logs
    .split(/\r?\n/)
    .map((line) => sanitizeDiagnosticText(line))
    .join('\n');
  return `${header}\n\n--- recent logs ---\n${safeLogs || '(none)'}\n`;
}

export async function exportDiagnostics(snapshot: DiagnosticSnapshot): Promise<boolean> {
  if (!isTauri) throw new Error('诊断日志导出仅桌面端可用');
  const [{ invoke }, { save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const logs = await invoke<string>('collect_diagnostic_logs');
  const date = new Date().toISOString().slice(0, 10);
  const target = await save({ defaultPath: `RocketX-diagnostics-${date}.txt` });
  if (!target) return false;
  await writeFile(target, new TextEncoder().encode(buildDiagnosticReport(snapshot, logs)));
  return true;
}
