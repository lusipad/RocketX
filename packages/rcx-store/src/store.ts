import type { RcxStoreBackend, RcxStoreName } from './backend';
import { createIndexedDbBackend, type IndexedDbBackendOptions } from './indexed-db';

export interface NamedEntry<T> {
  id: string;
  value: T;
}

export interface NamedStore {
  get<T>(id: string): Promise<T | undefined>;
  set<T>(id: string, value: T): Promise<void>;
  delete(id: string): Promise<void>;
  list<T>(): Promise<Array<NamedEntry<T>>>;
  clear(): Promise<void>;
}

export interface AppDataEntry<T> {
  key: string;
  value: T;
}

export interface AppDataStore {
  get<T>(appId: string, key: string): Promise<T | undefined>;
  set<T>(appId: string, key: string, value: T): Promise<void>;
  delete(appId: string, key: string): Promise<void>;
  list<T>(appId: string): Promise<Array<AppDataEntry<T>>>;
  clear(appId: string): Promise<void>;
  clearAllForApp(appId: string): Promise<void>;
}

export interface AuditEntry {
  appId: string;
  action: string;
  allowed: boolean;
  reason?: string;
  [key: string]: unknown;
}

export type AuditRecord<T extends AuditEntry = AuditEntry> = T & {
  id: string;
  timestamp: number;
};

export interface AuditStore {
  append<T extends AuditEntry>(entry: T): Promise<AuditRecord<T>>;
  list<T extends AuditEntry = AuditEntry>(): Promise<Array<AuditRecord<T>>>;
  clear(): Promise<void>;
}

export interface RcxStore {
  apps: NamedStore;
  appData: AppDataStore;
  vectors: NamedStore;
  outbox: NamedStore;
  audit: AuditStore;
  close(): void;
}

export interface CreateRcxStoreOptions extends IndexedDbBackendOptions {
  backend?: RcxStoreBackend;
}

const createNamedStore = (backend: RcxStoreBackend, name: RcxStoreName): NamedStore => ({
  get: <T>(id: string) => backend.get<T>(name, id),
  set: <T>(id: string, value: T) => backend.set(name, id, value),
  delete: (id: string) => backend.delete(name, id),
  list: async <T>() =>
    (await backend.entries<T>(name)).map(({ key, value }) => ({ id: String(key), value })),
  clear: () => backend.clear(name),
});

const createAppDataStore = (backend: RcxStoreBackend): AppDataStore => ({
  get: <T>(appId: string, key: string) => backend.get<T>('app-data', [appId, key]),
  set: <T>(appId: string, key: string, value: T) => backend.set('app-data', [appId, key], value),
  delete: (appId: string, key: string) => backend.delete('app-data', [appId, key]),
  list: async <T>(appId: string) =>
    (await backend.entries<T>('app-data'))
      .filter(({ key }) => Array.isArray(key) && key[0] === appId)
      .map(({ key, value }) => ({ key: String((key as readonly StoreKeyPart[])[1]), value })),
  clear: async (appId: string) => {
    const entries = await backend.entries('app-data');
    await Promise.all(
      entries
        .filter(({ key }) => Array.isArray(key) && key[0] === appId)
        .map(({ key }) => backend.delete('app-data', key)),
    );
  },
  clearAllForApp: async (appId: string) => {
    const entries = await backend.entries('app-data');
    await Promise.all(
      entries
        .filter(
          ({ key }) =>
            Array.isArray(key) &&
            (key[0] === appId || (typeof key[0] === 'string' && key[0].endsWith(`:${appId}`))),
        )
        .map(({ key }) => backend.delete('app-data', key)),
    );
  },
});

type StoreKeyPart = string | number | Date | readonly StoreKeyPart[];

let auditSequence = 0;
const createAuditId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  auditSequence += 1;
  return `audit-${Date.now()}-${auditSequence}`;
};

const createAuditStore = (backend: RcxStoreBackend): AuditStore => ({
  async append<T extends AuditEntry>(entry: T): Promise<AuditRecord<T>> {
    const record = { ...entry, id: createAuditId(), timestamp: Date.now() } as AuditRecord<T>;
    await backend.set('audit', record.id, record);
    return record;
  },
  async list<T extends AuditEntry = AuditEntry>(): Promise<Array<AuditRecord<T>>> {
    const records = (await backend.entries<AuditRecord<T>>('audit')).map(({ value }) => value);
    return records.sort((left, right) => left.timestamp - right.timestamp);
  },
  clear: () => backend.clear('audit'),
});

export const createRcxStore = (options: CreateRcxStoreOptions = {}): RcxStore => {
  const backend = options.backend ?? createIndexedDbBackend(options);
  return {
    apps: createNamedStore(backend, 'apps'),
    appData: createAppDataStore(backend),
    vectors: createNamedStore(backend, 'vectors'),
    outbox: createNamedStore(backend, 'outbox'),
    audit: createAuditStore(backend),
    close: () => backend.close?.(),
  };
};
