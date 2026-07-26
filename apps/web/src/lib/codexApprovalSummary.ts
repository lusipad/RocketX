import { permissionRequestSummary } from '../agent/safety';

/**
 * 审批请求的人话摘要。执行间与管家页共用——派活时点头这件事发生在管家页，
 * 用户不必知道执行间的存在。
 */
export function codexApprovalSummary(method: string, params: unknown): string {
  const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  if (typeof value.command === 'string') return value.command;
  if (Array.isArray(value.command)) return value.command.filter((item) => typeof item === 'string').join(' ');
  if (typeof value.fileChanges === 'object' && value.fileChanges !== null) return Object.keys(value.fileChanges).join('\n');
  const permissions = permissionRequestSummary(value.permissions ?? value.additionalPermissions);
  if (permissions.length) return permissions.join('\n');
  if (typeof value.grantRoot === 'string') return `写入目录：${value.grantRoot}`;
  if (typeof value.reason === 'string') return value.reason;
  return method;
}
