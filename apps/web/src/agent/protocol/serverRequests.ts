import type { ServerRequest } from './generated/ServerRequest';

export type ServerRequestMethod = ServerRequest['method'];
export type ServerRequestPolicy =
  | 'host-approval'
  | 'host-input'
  | 'dynamic-tool'
  | 'local-safe'
  | 'safe-reject';

export const SERVER_REQUEST_POLICIES = {
  'item/commandExecution/requestApproval': 'host-approval',
  'item/fileChange/requestApproval': 'host-approval',
  'item/tool/requestUserInput': 'host-input',
  'mcpServer/elicitation/request': 'host-input',
  'item/permissions/requestApproval': 'host-approval',
  'item/tool/call': 'dynamic-tool',
  'account/chatgptAuthTokens/refresh': 'safe-reject',
  'attestation/generate': 'safe-reject',
  'currentTime/read': 'local-safe',
  applyPatchApproval: 'host-approval',
  execCommandApproval: 'host-approval',
} as const satisfies Record<ServerRequestMethod, ServerRequestPolicy>;

export function serverRequestPolicy(method: string): ServerRequestPolicy | 'unknown' {
  return Object.prototype.hasOwnProperty.call(SERVER_REQUEST_POLICIES, method)
    ? SERVER_REQUEST_POLICIES[method as ServerRequestMethod]
    : 'unknown';
}
