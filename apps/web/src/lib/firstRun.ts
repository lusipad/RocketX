export const FIRST_RUN_STORAGE_KEY = 'rcx-first-run-v1';
export const DESKTOP_DEFAULTS_STORAGE_KEY = 'rcx-desktop-defaults-v1';

export type FirstRunState = 'complete' | 'pending';
export type DesktopDefaultsStatus = 'fresh' | 'applied' | 'legacy-migrated';
export type DesktopDefaultsEffectResult =
  | 'pending'
  | 'enabled'
  | 'skipped'
  | 'denied'
  | 'unavailable'
  | 'failed'
  | 'preserved';
export type DesktopDefaultsAppliedResult = Exclude<DesktopDefaultsEffectResult, 'pending' | 'preserved'>;
export type DesktopDefaultsStep = 'notifications' | 'autostart';
export type DesktopDefaultsRecord = {
  version: 1;
  status: DesktopDefaultsStatus;
  notifications: DesktopDefaultsEffectResult;
  autostart: DesktopDefaultsEffectResult;
};

type StorageReader = Pick<Storage, 'getItem'> | undefined;
type StorageWriter = Pick<Storage, 'setItem'> | undefined;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | undefined;
type NotificationPermissionResult = 'granted' | 'denied' | 'unavailable';

const EXISTING_USER_STATE_KEYS = [
  FIRST_RUN_STORAGE_KEY,
  'rcx-auth',
  'rcx-owner',
  'rcx-server',
  'rcx-workspace-source',
] as const;

const DESKTOP_DEFAULTS_STATUSES = new Set<DesktopDefaultsStatus>(['fresh', 'applied', 'legacy-migrated']);
const DESKTOP_DEFAULTS_RESULTS = new Set<DesktopDefaultsEffectResult>([
  'pending',
  'enabled',
  'skipped',
  'denied',
  'unavailable',
  'failed',
  'preserved',
]);
const DESKTOP_DEFAULTS_APPLIED_RESULTS = new Set<DesktopDefaultsAppliedResult>([
  'enabled',
  'skipped',
  'denied',
  'unavailable',
  'failed',
]);

function readStorageValue(storage: StorageReader, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorageValue(storage: StorageWriter, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function isDesktopDefaultsRecord(value: unknown): value is DesktopDefaultsRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DesktopDefaultsRecord>;
  if (!(candidate.version === 1 &&
    DESKTOP_DEFAULTS_STATUSES.has(candidate.status as DesktopDefaultsStatus) &&
    DESKTOP_DEFAULTS_RESULTS.has(candidate.notifications as DesktopDefaultsEffectResult) &&
    DESKTOP_DEFAULTS_RESULTS.has(candidate.autostart as DesktopDefaultsEffectResult))) return false;
  if (candidate.status === 'fresh') {
    return candidate.notifications === 'pending' && candidate.autostart === 'pending';
  }
  if (candidate.status === 'legacy-migrated') {
    return candidate.notifications === 'preserved' && candidate.autostart === 'preserved';
  }
  return DESKTOP_DEFAULTS_APPLIED_RESULTS.has(candidate.notifications as DesktopDefaultsAppliedResult) &&
    DESKTOP_DEFAULTS_APPLIED_RESULTS.has(candidate.autostart as DesktopDefaultsAppliedResult);
}

function buildDesktopDefaultsRecord(
  status: DesktopDefaultsStatus,
  notifications: DesktopDefaultsEffectResult,
  autostart: DesktopDefaultsEffectResult,
): DesktopDefaultsRecord {
  return {
    version: 1,
    status,
    notifications,
    autostart,
  };
}

function saveDesktopDefaultsRecord(
  storage: StorageWriter,
  record: DesktopDefaultsRecord,
): DesktopDefaultsRecord | null {
  return writeStorageValue(storage, DESKTOP_DEFAULTS_STORAGE_KEY, JSON.stringify(record)) ? record : null;
}

export function loadFirstRunState(storage: StorageReader): FirstRunState | null {
  const value = readStorageValue(storage, FIRST_RUN_STORAGE_KEY);
  return value === 'complete' || value === 'pending' ? value : null;
}

export function loadDesktopDefaultsRecord(storage: StorageReader): DesktopDefaultsRecord | null {
  const value = readStorageValue(storage, DESKTOP_DEFAULTS_STORAGE_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isDesktopDefaultsRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 旧版本没有桌面默认标记；只认用户配置，忽略启动时自动生成的设备/UI 状态。 */
export function hasExistingRocketXUserState(storage: StorageReader): boolean {
  if (!storage) return true;
  try {
    return EXISTING_USER_STATE_KEYS.some((key) => storage.getItem(key) !== null);
  } catch {
    // 无法确认设备为空时按旧安装保护，绝不冒险重开系统级默认。
    return true;
  }
}

export function prepareDesktopDefaultsRecord(input: {
  storage: StorageLike;
  releaseDesktop: boolean;
  hasExistingUserState: boolean;
}): DesktopDefaultsRecord | null {
  if (!input.releaseDesktop) return null;

  const raw = readStorageValue(input.storage, DESKTOP_DEFAULTS_STORAGE_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (isDesktopDefaultsRecord(parsed)) return parsed;
    } catch {
      /* 已存在但损坏的记录必须迁移成 preserved，而不是重新 fresh */
    }
    return saveDesktopDefaultsRecord(
      input.storage,
      buildDesktopDefaultsRecord('legacy-migrated', 'preserved', 'preserved'),
    );
  }

  if (input.hasExistingUserState) {
    return saveDesktopDefaultsRecord(
      input.storage,
      buildDesktopDefaultsRecord('legacy-migrated', 'preserved', 'preserved'),
    );
  }

  return saveDesktopDefaultsRecord(
    input.storage,
    buildDesktopDefaultsRecord('fresh', 'pending', 'pending'),
  );
}

export function saveAppliedDesktopDefaults(
  storage: StorageWriter,
  result: { notifications: DesktopDefaultsAppliedResult; autostart: DesktopDefaultsAppliedResult },
): DesktopDefaultsRecord | null {
  return saveDesktopDefaultsRecord(
    storage,
    buildDesktopDefaultsRecord('applied', result.notifications, result.autostart),
  );
}

export function shouldShowFirstRun(input: {
  desktop: boolean;
  serverUrl: string;
  hasWorkspaceSource: boolean;
  state: FirstRunState | null;
}): boolean {
  if (!input.desktop) return false;
  if (input.state === 'pending') return true;
  if (input.state === 'complete') return false;
  return !input.serverUrl.trim() && !input.hasWorkspaceSource;
}

export function completeFirstRun(storage: StorageWriter): void {
  writeStorageValue(storage, FIRST_RUN_STORAGE_KEY, 'complete');
}

export function resetFirstRun(storage: StorageWriter = localStorage): void {
  writeStorageValue(storage, FIRST_RUN_STORAGE_KEY, 'pending');
}

function mapNotificationPermission(result: NotificationPermissionResult): DesktopDefaultsAppliedResult {
  switch (result) {
    case 'granted':
      return 'enabled';
    case 'denied':
      return 'denied';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'failed';
  }
}

export async function applyDesktopDefaults(input: {
  releaseDesktop: boolean;
  notificationsChecked: boolean;
  autostartChecked: boolean;
  requestNotifications: () => NotificationPermissionResult | Promise<NotificationPermissionResult>;
  enableAutostart: () => boolean | Promise<boolean>;
  onProgress?: (step: DesktopDefaultsStep, result: DesktopDefaultsAppliedResult) => void;
}): Promise<{ notifications: DesktopDefaultsAppliedResult; autostart: DesktopDefaultsAppliedResult }> {
  let notifications: DesktopDefaultsAppliedResult = 'skipped';
  let autostart: DesktopDefaultsAppliedResult = 'skipped';

  if (!input.releaseDesktop) {
    return { notifications, autostart };
  }

  if (input.notificationsChecked) {
    try {
      notifications = mapNotificationPermission(await input.requestNotifications());
    } catch {
      notifications = 'failed';
    }
  }
  input.onProgress?.('notifications', notifications);

  if (input.autostartChecked) {
    try {
      autostart = (await input.enableAutostart()) ? 'enabled' : 'failed';
    } catch {
      autostart = 'failed';
    }
  }
  input.onProgress?.('autostart', autostart);

  return { notifications, autostart };
}
