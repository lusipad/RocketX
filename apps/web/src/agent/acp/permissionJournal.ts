export interface AcpPermissionJournalEntry {
  requestId: string;
  sessionKey: string;
  nativeSessionId: string;
  agentId: string;
  workspaceRoot: string;
  title: string;
  accountScope: string;
  turnCount: number;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'expired';
  reason?: string;
}

const key = (scope: string) => `rcx-acp-permission-journal-v1:${scope}`;

export function readAcpPermissionJournal(scope: string): AcpPermissionJournalEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(scope)) ?? '[]');
    return Array.isArray(raw) ? raw.filter((entry): entry is AcpPermissionJournalEntry => Boolean(entry) && entry.accountScope === scope && typeof entry.requestId === 'string' && typeof entry.sessionKey === 'string' && typeof entry.expiresAt === 'number').slice(-100) : [];
  } catch { return []; }
}

export function writeAcpPermissionJournal(scope: string, entries: AcpPermissionJournalEntry[]): void {
  try { localStorage.setItem(key(scope), JSON.stringify(entries.filter((entry) => entry.accountScope === scope).slice(-100))); } catch { /* live permission handling still works when storage is unavailable */ }
}

export function expireDisconnectedAcpPermissions(scope: string, liveRequestIds: ReadonlySet<string>): AcpPermissionJournalEntry[] {
  const entries = readAcpPermissionJournal(scope).map((entry): AcpPermissionJournalEntry => liveRequestIds.has(entry.requestId) && entry.expiresAt > Date.now() ? entry : { ...entry, status: 'expired', reason: '原执行连接已失效或权限请求已超时，需重新请求权限' });
  writeAcpPermissionJournal(scope, entries);
  return entries.filter((entry) => entry.status === 'expired');
}
