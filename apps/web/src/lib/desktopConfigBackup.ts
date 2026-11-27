import { readDesktopPreferencesScope, writeDesktopPreferencesScope } from '../platform/desktopCommands';
import { hasExistingRocketXUserState } from './firstRun';
import { isTauri } from './http';

export const CLIENT_STATE_BACKUP_SCOPE = '__rcx_client_state_v1__';
export const CLIENT_STATE_BACKUP_SCHEMA = 'rcx-client-state-v1';

const EXACT_BACKUP_KEYS = new Set([
  'rcx-server',
  'rcx-site-url',
  'rcx-owner',
  'rcx-local-mode',
  'rcx-first-run-v1',
  'rcx-desktop-defaults-v1',
  'rcx-workspace-source',
  'rcx-update-source',
  'rcx-theme',
  'rcx-locale',
  'rcx-ui',
  'rcx-nav-collapsed',
  'rcx-im-layout',
  'rocketx.butler.task-provider',
  'rcx-pi-configured-v1',
  'rcx-pi-migrated-v1',
  'rcx-runtime-mode-v1',
  'rcx-wi-template-url',
  'rcx-wi-template-cache',
  'rcx-user-cache',
]);

const SCOPED_BACKUP_BASES = [
  'rcx-calendar',
  'rcx-todos',
  'rcx-folders',
  'rcx-collapsed',
  'rcx-favorites',
  'rcx-aliases',
  'rcx-drafts',
  'rcx-prefs-cache',
  'rcx-workbench',
  'rcx-ado-web',
  'rcx-custom-queries',
  'rcx-wi-last-projects',
  'rcx-agent-environments',
  'rcx-butler-attention',
] as const;

export interface ClientStateBackupSnapshot {
  schema: typeof CLIENT_STATE_BACKUP_SCHEMA;
  updatedAt: number;
  entries: Record<string, string>;
}

function isAllowedBackupKey(key: string): boolean {
  if (key === 'rcx-auth') return false;
  if (EXACT_BACKUP_KEYS.has(key)) return true;
  return SCOPED_BACKUP_BASES.some((base) => key === base || key.startsWith(`${base}#`));
}

function sanitizeBackupValue(key: string, value: string): string {
  if (key !== 'rcx-workbench' && !key.startsWith('rcx-workbench#')) {
    return value;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
    if (!('pat' in parsed)) return value;
    const { pat: _omitted, ...rest } = parsed;
    return JSON.stringify(rest);
  } catch {
    return value;
  }
}

export function collectClientStateSnapshot(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
): ClientStateBackupSnapshot {
  const entries: Record<string, string> = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !isAllowedBackupKey(key)) continue;
    const value = storage.getItem(key);
    if (typeof value !== 'string') continue;
    entries[key] = sanitizeBackupValue(key, value);
  }
  return {
    schema: CLIENT_STATE_BACKUP_SCHEMA,
    updatedAt: Date.now(),
    entries,
  };
}

export function applyClientStateSnapshot(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  raw: unknown,
): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  const candidate = raw as { schema?: unknown; entries?: unknown };
  if (candidate.schema !== CLIENT_STATE_BACKUP_SCHEMA) return 0;
  if (!candidate.entries || typeof candidate.entries !== 'object' || Array.isArray(candidate.entries)) {
    return 0;
  }
  let applied = 0;
  for (const [key, value] of Object.entries(candidate.entries as Record<string, unknown>)) {
    if (!isAllowedBackupKey(key) || typeof value !== 'string') continue;
    try {
      if (storage.getItem(key) !== null) continue;
      storage.setItem(key, value);
      applied += 1;
    } catch {
      /* 存储受限时尽量恢复其余配置 */
    }
  }
  return applied;
}

export async function restoreDesktopClientStateIfEmpty(
  storage: Storage,
  timeoutMs = 800,
): Promise<boolean> {
  if (!isTauri || hasExistingRocketXUserState(storage)) return false;
  try {
    const raw = await Promise.race([
      readDesktopPreferencesScope(CLIENT_STATE_BACKUP_SCOPE),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return applyClientStateSnapshot(storage, raw) > 0;
  } catch {
    return false;
  }
}

export async function flushDesktopClientStateBackup(storage: Storage): Promise<void> {
  if (!isTauri) return;
  const snapshot = collectClientStateSnapshot(storage);
  if (Object.keys(snapshot.entries).length === 0) return;
  await writeDesktopPreferencesScope(
    CLIENT_STATE_BACKUP_SCOPE,
    snapshot as unknown as Record<string, unknown>,
  );
}

let uninstallMirror: (() => void) | null = null;

export function installDesktopClientStateMirror(storage: Storage): () => void {
  if (!isTauri) return () => {};
  if (uninstallMirror) return uninstallMirror;
  const proto = Object.getPrototypeOf(storage) as Storage;
  const originalSetItem = proto.setItem;
  const originalRemoveItem = proto.removeItem;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleFlush = (key: string) => {
    if (!isAllowedBackupKey(key)) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flushDesktopClientStateBackup(storage);
    }, 400);
  };
  proto.setItem = function patchedSetItem(key: string, value: string): void {
    originalSetItem.call(this, key, value);
    if (this === storage) scheduleFlush(key);
  };
  proto.removeItem = function patchedRemoveItem(key: string): void {
    originalRemoveItem.call(this, key);
    if (this === storage) scheduleFlush(key);
  };
  uninstallMirror = () => {
    if (timer !== null) clearTimeout(timer);
    proto.setItem = originalSetItem;
    proto.removeItem = originalRemoveItem;
    uninstallMirror = null;
  };
  return uninstallMirror;
}
