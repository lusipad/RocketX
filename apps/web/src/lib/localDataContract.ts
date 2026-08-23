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

export interface LocalDataMigrationPlanEntry {
  key: string;
  domain?: LocalDataDomain;
  action: 'unchanged' | 'migrate' | 'rejected' | 'unknown';
  fromVersion?: number;
  toVersion?: number;
  reason?: string;
}

export interface LocalDataMigrationPlan {
  valid: boolean;
  entries: LocalDataMigrationPlanEntry[];
  unknownKeys: string[];
  rejectedKeys: string[];
}

export interface LocalDataMigrationOptions {
  storage?: LocalDataStorage;
  keys?: readonly string[];
  scope?: string;
  schemas?: Readonly<Record<LocalDataDomain, LocalDataSchemaDescriptor>>;
  dryRun?: boolean;
  now?: () => number;
}

export interface LocalDataMigrationReport extends LocalDataMigrationPlan {
  dryRun: boolean;
  executed: string[];
  skipped: string[];
  backup: string;
  rolledBack: boolean;
  error?: string;
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
  migrations?: readonly LocalDataMigration[];
  validate?: (value: unknown) => boolean;
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

interface ParsedLocalDataRecord {
  value: unknown;
  version: number;
  scope?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function schemaPatternMatch(schema: LocalDataSchemaDescriptor, key: string): { version?: number } | null {
  if (schema.key === key) return {};
  if (!schema.keyPattern) return null;
  const parts = schema.keyPattern.split(/(\{version\}|\{server\}|\{user\})/g);
  const source = parts.map((part) => {
    if (part === '{version}') return '(?<version>[0-9]+)';
    if (part === '{server}' || part === '{user}') return '[^:]+';
    return escapeRegExp(part);
  }).join('');
  const match = new RegExp(`^${source}$`).exec(key);
  if (!match) return null;
  const version = match.groups?.version;
  return version === undefined ? {} : { version: Number(version) };
}

function schemaForKey(
  schemas: Readonly<Record<LocalDataDomain, LocalDataSchemaDescriptor>>,
  key: string,
): { schema: LocalDataSchemaDescriptor; keyVersion?: number } | null {
  for (const schema of Object.values(schemas)) {
    const match = schemaPatternMatch(schema, key);
    if (match) return { schema, keyVersion: match.version };
  }
  return null;
}

function parseLocalDataRecord(
  raw: string,
  schema: LocalDataSchemaDescriptor,
  keyVersion?: number,
): ParsedLocalDataRecord {
  const parsed: unknown = JSON.parse(raw);
  if (isEnvelope(parsed)) {
    if (!Number.isInteger(parsed.version) || parsed.version < 0) {
      throw new Error(`本地数据 ${schema.domain} 的版本无效`);
    }
    return { value: parsed.data, version: parsed.version, scope: parsed.scope };
  }
  if (schema.legacy !== 'raw') {
    throw new Error(`本地数据 ${schema.domain} 缺少版本 envelope`);
  }
  return { value: parsed, version: keyVersion ?? schema.version };
}

function planLocalDataMigrationKey(
  key: string,
  raw: string | null,
  schemas: Readonly<Record<LocalDataDomain, LocalDataSchemaDescriptor>>,
  scope?: string,
): LocalDataMigrationPlanEntry {
  const registered = schemaForKey(schemas, key);
  if (!registered) return { key, action: 'unknown', reason: '未注册的本地数据 key' };
  const { schema, keyVersion } = registered;
  if (raw === null) return { key, domain: schema.domain, action: 'unchanged', reason: '记录不存在' };
  try {
    const record = parseLocalDataRecord(raw, schema, keyVersion);
    if (scope !== undefined && record.scope !== undefined && record.scope !== scope) {
      return { key, domain: schema.domain, action: 'rejected', fromVersion: record.version, toVersion: schema.version, reason: 'scope 不匹配' };
    }
    if (record.version > schema.version) {
      return { key, domain: schema.domain, action: 'rejected', fromVersion: record.version, toVersion: schema.version, reason: '记录来自未来版本' };
    }
    const migrated = migrateValue(record.value, record.version, schema.version, schema.migrations);
    if (!migrated) {
      return { key, domain: schema.domain, action: 'rejected', fromVersion: record.version, toVersion: schema.version, reason: '缺少连续迁移步骤' };
    }
    if (schema.validate && !schema.validate(migrated.value)) {
      return { key, domain: schema.domain, action: 'rejected', fromVersion: record.version, toVersion: schema.version, reason: '迁移结果未通过 schema 校验' };
    }
    return {
      key,
      domain: schema.domain,
      action: migrated.migrated ? 'migrate' : 'unchanged',
      fromVersion: record.version,
      toVersion: schema.version,
    };
  } catch (error) {
    return {
      key,
      domain: schema.domain,
      action: 'rejected',
      toVersion: schema.version,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 只读取已注册领域，生成确定性的迁移计划。计划阶段不写入 storage，
 * 未知 key、未来版本、scope 冲突和缺失迁移都会显式拒绝。
 */
export function planLocalDataMigrations(options: LocalDataMigrationOptions = {}): LocalDataMigrationPlan {
  const storage = storageFor(options.storage);
  const schemas = options.schemas ?? LOCAL_DATA_SCHEMAS;
  const keys = storage ? listStorageKeys(storage, options.keys) : [...(options.keys ?? [])];
  const entries = keys
    .map((key) => planLocalDataMigrationKey(key, storage?.getItem(key) ?? null, schemas, options.scope));
  const unknownKeys = entries.filter((entry) => entry.action === 'unknown').map((entry) => entry.key);
  const rejectedKeys = entries.filter((entry) => entry.action === 'rejected').map((entry) => entry.key);
  return { valid: unknownKeys.length === 0 && rejectedKeys.length === 0, entries, unknownKeys, rejectedKeys };
}

/**
 * 执行显式迁移。成功前先导出受影响 key 的快照；任何写入失败都会恢复
 * 整个快照。dry-run 复用同一计划路径，因此不会隐式修改用户数据。
 */
export function executeLocalDataMigrations(options: LocalDataMigrationOptions = {}): LocalDataMigrationReport {
  const storage = storageFor(options.storage);
  const plan = planLocalDataMigrations(options);
  const migrationKeys = plan.entries.filter((entry) => entry.action === 'migrate').map((entry) => entry.key);
  const backup = backupLocalData({ keys: migrationKeys, storage: storage ?? undefined, now: options.now });
  const dryRun = options.dryRun === true;
  const skipped = plan.entries.filter((entry) => entry.action !== 'migrate').map((entry) => entry.key);
  if (!plan.valid || dryRun || !storage) {
    return { ...plan, dryRun, executed: [], skipped, backup, rolledBack: false };
  }

  const previous = new Map<string, string | null>();
  const executed: string[] = [];
  try {
    for (const entry of plan.entries) {
      if (entry.action !== 'migrate') continue;
      const registered = schemaForKey(options.schemas ?? LOCAL_DATA_SCHEMAS, entry.key);
      const schema = registered?.schema;
      if (!schema) throw new Error(`迁移 key 未注册：${entry.key}`);
      const raw = storage.getItem(entry.key);
      if (raw === null) throw new Error(`迁移记录不存在：${entry.key}`);
      const record = parseLocalDataRecord(raw, schema, registered.keyVersion);
      const migrated = migrateValue(record.value, record.version, schema.version, schema.migrations);
      if (!migrated) throw new Error(`迁移步骤失效：${entry.key}`);
      previous.set(entry.key, raw);
      writeLocalData(entry.key, schema.version, migrated.value, {
        storage,
        scope: record.scope ?? options.scope,
        now: options.now,
      });
      executed.push(entry.key);
    }
    return { ...plan, dryRun: false, executed, skipped, backup, rolledBack: false };
  } catch (error) {
    for (const [key, raw] of previous) {
      try {
        if (raw === null) storage.removeItem(key);
        else storage.setItem(key, raw);
      } catch {
        // 尽力恢复；报告仍明确标记已尝试回滚。
      }
    }
    return {
      ...plan,
      dryRun: false,
      executed: [],
      skipped,
      backup,
      rolledBack: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
