/**
 * 站内图片加载失败的原因分类。
 *
 * issue #382 反复八轮停在「请提供失败样本」，机制性原因不是缺样本，而是客户端
 * 不产生证据：`AuthImage` 旧实现用 `.catch(() => null)` 把 401、网络中断、
 * Tauri 通道读不出、零字节响应、嗅探异常全部塌缩成同一句「图片加载失败」。
 * 用户看到的现象一模一样，导出的日志里也一样什么都没有。
 *
 * 这里只负责把原因分出类别并生成一行可脱敏落盘的诊断串；界面文案不变。
 */

import { sanitizeDiagnosticText, writeDiagnostic } from './diagnostics';

/** 响应成功但零字节：<img> 会静默失败，必须在拿到 blob 时就判掉。 */
export const AUTH_IMAGE_EMPTY_RESPONSE = 'auth_image_empty_response';
/** 字节已到手，但 WebView 解不出来（声明 MIME 与真实字节不符等）。 */
export const AUTH_IMAGE_RENDER_FAILED = 'auth_image_render_failed';

export type AuthImageFailureKind =
  | 'unauthorized'
  | 'not_found'
  | 'server'
  | 'http_status'
  | 'network'
  | 'empty'
  | 'decode'
  | 'render'
  | 'unknown';

export interface AuthImageFailure {
  kind: AuthImageFailureKind;
  status: number | null;
  diagnostic: string;
}

const HTTP_STATUS_PATTERN = /\b(?:http|status)\s*(\d{3})\b/i;
const DECODE_PATTERN = /blob|arraybuffer|could not be read|decode|unsupported image|invalid image/i;
const NETWORK_PATTERN =
  /failed to fetch|network|error sending request|load failed|connection|timed? ?out|timeout|aborted|unreachable/i;

function rawFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/** RcApiError 带数字 status；原生通道抛出的错误没有。 */
function failureStatus(error: unknown): number | null {
  const carried = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof carried === 'number' && Number.isFinite(carried)) return carried;
  const match = rawFailure(error).match(HTTP_STATUS_PATTERN);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function kindForStatus(status: number): AuthImageFailureKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'http_status';
}

export function classifyAuthImageFailure(error: unknown): AuthImageFailureKind {
  const raw = rawFailure(error);
  if (raw === AUTH_IMAGE_EMPTY_RESPONSE) return 'empty';
  if (raw === AUTH_IMAGE_RENDER_FAILED) return 'render';
  const status = failureStatus(error);
  if (status !== null) return kindForStatus(status);
  // 解码类要排在网络类之前：两者的措辞有重叠（both mention "read"/"load"）。
  if (DECODE_PATTERN.test(raw)) return 'decode';
  if (NETWORK_PATTERN.test(raw)) return 'network';
  return 'unknown';
}

export function describeAuthImageFailure(path: string, error: unknown): AuthImageFailure {
  const kind = classifyAuthImageFailure(error);
  const status = failureStatus(error);
  const safePath = sanitizeDiagnosticText(path);
  const safeDetail = sanitizeDiagnosticText(rawFailure(error) || 'n/a');
  return {
    kind,
    status,
    diagnostic: `path=${safePath} kind=${kind} status=${status ?? 'n/a'} detail=${safeDetail}`,
  };
}

export async function writeAuthImageDiagnostic(
  path: string,
  error: unknown,
): Promise<AuthImageFailure> {
  const failure = describeAuthImageFailure(path, error);
  await writeDiagnostic('warn', 'image', failure.diagnostic);
  return failure;
}
