/**
 * RocketX 本地领域数据合同。
 *
 * 这里故意只依赖 Storage 形状，Web 使用 localStorage，桌面端可以注入
 * Tauri/SQLite 的同步 bridge。业务 Store 不需要知道底层存储在哪里。
 */

export interface LocalDataStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export interface VersionedLocalData<T> {
  version: number;
  scope?: string;
  /** Reserved for future stores; omitted by default to preserve old payloads. */
  updatedAt?: number;
  data: T;
}

export interface LocalDataMigration {
  from: number;
  to: number;
  migrate: (value: unknown) => unknown;
}

export interface LocalDataReadOptions {
  scope?: string;
  storage?: LocalDataStorage;
  migrations?: readonly LocalDataMigration[];
  persistMigration?: boolean;
  quarantineCorrupt?: boolean;
  now?: () => number;
  onCorrupt?: (raw: string) => void;
}

export interface LocalDataWriteOptions {
  scope?: string;
  storage?: LocalDataStorage;
  now?: () => number;
}

export type LocalDataDomain = 'todo' | 'calendar' | 'preferences' | 'attention';

export interface LocalDataSchemaDescriptor {
  domain: LocalDataDomain;
  key: string;
  version: number;
  scope: 'global' | 'account';
  legacy: 'raw' | 'versioned';
  backend: 'local-storage' | 'native-sqlite' | 'dual';
  keyPattern?: string;
}

/** 正式领域 schema 注册表。动态账号 key 由 keyPattern 描述。 */
export const LOCAL_DATA_SCHEMAS: Readonly<Record<LocalDataDomain, LocalDataSchemaDescriptor>> = {
  todo: { domain: 'todo', key: 'rcx-todos', version: 1, scope: 'account', legacy: 'raw', backend: 'dual' },
  calendar: { domain: 'calendar', key: 'rcx-calendar', version: 1, scope: 'account', legacy: 'raw', backend: 'local-storage' },
  preferences: { domain: 'preferences', key: 'rcx-prefs-cache', version: 1, scope: 'account', legacy: 'raw', backend: 'local-storage' },
  attention: {
    domain: 'attention',
    key: 'rcx-notification-aggregation',
    keyPattern: 'rcx-notification-aggregation-v{version}:{server}:{user}',
    version: 1,
    scope: 'account',
    legacy: 'versioned',
    backend: 'local-storage',
  },
};

export function getLocalDataSchema(domain: LocalDataDomain): LocalDataSchemaDescriptor {
  return LOCAL_DATA_SCHEMAS[domain];
}

function defaultStorage(): LocalDataStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function storageFor(storage?: LocalDataStorage): LocalDataStorage | null {
  return storage ?? defaultStorage();
}

function isEnvelope(value: unknown): value is { version: number; scope?: string; data: unknown } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { version?: unknown }).version === 'number'
    && 'data' in value;
}

function quarantine(key: string, raw: string, storage: LocalDataStorage, now: () => number): void {
  const suffix = `${Math.max(0, Math.floor(now()))}`;
  try {
    storage.setItem(`${key}#corrupt#${suffix}`, raw);
  } catch {
    // 隔离失败不应遮蔽业务 fallback。
  }
}

function migrateValue(
  value: unknown,
  fromVersion: number,
  targetVersion: number,
  migrations: readonly LocalDataMigration[] | undefined,
): { value: unknown; migrated: boolean } | null {
  if (fromVersion > targetVersion) return null;
  let version = fromVersion;
  let current = value;
  let migrated = false;
  while (version < targetVersion) {
    const step = migrations?.find((item) => item.from === version);
    if (!step || step.to <= step.from || step.to > targetVersion) return null;
    current = step.migrate(current);
    version = step.to;
    migrated = true;
  }
  return { value: current, migrated };
}

/** Read a versioned record while accepting the pre-contract legacy payload. */
export function readLocalData<T>(
  key: string,
  version: number,
  fallback: T,
  decode: (value: unknown) => T | undefined,
  options: LocalDataReadOptions = {},
): T {
  const storage = storageFor(options.storage);
  if (!storage) return fallback;
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    const envelope = isEnvelope(parsed) ? parsed : null;
    if (envelope && options.scope !== undefined && envelope.scope !== options.scope) return fallback;

    // 旧数组/对象没有版本信息，直接交给当前 decoder，保留旧 key 合同。
    const sourceVersion = envelope?.version ?? version;
    let value = envelope?.data ?? parsed;
    if (sourceVersion !== version) {
      const migrated = migrateValue(value, sourceVersion, version, options.migrations);
      if (!migrated) return fallback;
      value = migrated.value;
    }
    const decoded = decode(value);
    if (decoded === undefined) return fallback;
    if (sourceVersion !== version && options.persistMigration) {
      writeLocalData(key, version, value, {
        scope: options.scope ?? envelope?.scope,
        storage,
        now: options.now,
      });
    }
    return decoded;
  } catch {
    if (raw !== null) {
      if (options.quarantineCorrupt !== false) quarantine(key, raw, storage, options.now ?? Date.now);
      try { options.onCorrupt?.(raw); } catch { /* callback is observational */ }
    }
    return fallback;
  }
}

/**
 * 写入 envelope。setItem 失败时尽力恢复旧值，避免半写入记录被下一次启动读取。
 */
export function writeLocalData<T>(
  key: string,
  version: number,
  data: T,
  options: LocalDataWriteOptions = {},
): void {
  const storage = storageFor(options.storage);
  if (!storage) return;
  const previous = storage.getItem(key);
  const envelope: VersionedLocalData<T> = {
    version,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    data,
  };
  const serialized = JSON.stringify(envelope);
  try {
    storage.setItem(key, serialized);
  } catch (error) {
    try {
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
    } catch {
      // 回滚也失败时保留原始写入错误。
    }
    throw error;
  }
}

export function removeLocalData(key: string, storage?: LocalDataStorage): void {
  storageFor(storage)?.removeItem(key);
}

export interface LocalDataBackup {
  format: 'rocketx-local-data-backup';
  version: 1;
  createdAt: number;
  records: Record<string, string>;
}

export interface LocalDataBackupOptions {
  keys?: readonly string[];
  storage?: LocalDataStorage;
  now?: () => number;
}

export interface LocalDataRestoreOptions extends LocalDataBackupOptions {
  dryRun?: boolean;
  conflict?: 'replace' | 'keep';
}

export interface LocalDataRestoreReport {
  dryRun: boolean;
  restored: string[];
  skipped: string[];
  rolledBack: boolean;
}

function listStorageKeys(storage: LocalDataStorage, keys?: readonly string[]): string[] {
  if (keys) return [...new Set(keys)].filter((key) => key.length > 0);
  const result: string[] = [];
  for (let index = 0; index < (storage.length ?? 0); index += 1) {
    const key = storage.key?.(index);
    if (key !== null && key !== undefined) result.push(key);
  }
  return result;
}

export function backupLocalData(options: LocalDataBackupOptions = {}): string {
  const storage = storageFor(options.storage);
  const records: Record<string, string> = {};
  if (storage) {
    for (const key of listStorageKeys(storage, options.keys)) {
      const value = storage.getItem(key);
      if (value !== null) records[key] = value;
    }
  }
  const backup: LocalDataBackup = {
    format: 'rocketx-local-data-backup',
    version: 1,
    createdAt: Math.max(0, Math.floor((options.now ?? Date.now)())),
    records,
  };
  return JSON.stringify(backup);
}

export function parseLocalDataBackup(input: string | LocalDataBackup): LocalDataBackup {
  const value: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('本地数据备份格式无效');
  }
  const backup = value as Partial<LocalDataBackup>;
  if (backup.format !== 'rocketx-local-data-backup' || backup.version !== 1
    || !backup.records || typeof backup.records !== 'object' || Array.isArray(backup.records)) {
    throw new Error('本地数据备份版本不受支持');
  }
  const records: Record<string, string> = {};
  for (const [key, raw] of Object.entries(backup.records)) {
    if (!key || typeof raw !== 'string') throw new Error('本地数据备份记录无效');
    records[key] = raw;
  }
  return {
    format: 'rocketx-local-data-backup',
    version: 1,
    createdAt: typeof backup.createdAt === 'number' ? backup.createdAt : 0,
    records,
  };
}

/** 先计算报告；非 dry-run 写入失败时恢复整个快照。 */
export function restoreLocalData(
  input: string | LocalDataBackup,
  options: LocalDataRestoreOptions = {},
): LocalDataRestoreReport {
  const backup = parseLocalDataBackup(input);
  const storage = storageFor(options.storage);
  const conflict = options.conflict ?? 'replace';
  const restored: string[] = [];
  const skipped: string[] = [];
  if (!storage) {
    return {
      dryRun: options.dryRun === true,
      restored,
      skipped: Object.keys(backup.records),
      rolledBack: false,
    };
  }

  const previous = new Map<string, string | null>();
  for (const [key, raw] of Object.entries(backup.records)) {
    const current = storage.getItem(key);
    if (current !== null && conflict === 'keep') {
      skipped.push(key);
      continue;
    }
    restored.push(key);
    previous.set(key, current);
    if (!options.dryRun) {
      try {
        storage.setItem(key, raw);
      } catch (error) {
        for (const [rollbackKey, rollbackValue] of previous) {
          try {
            if (rollbackValue === null) storage.removeItem(rollbackKey);
            else storage.setItem(rollbackKey, rollbackValue);
          } catch { /* best effort rollback */ }
        }
        throw error;
      }
    }
  }
  return { dryRun: options.dryRun === true, restored, skipped, rolledBack: false };
}
