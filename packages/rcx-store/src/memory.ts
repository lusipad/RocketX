import type { RcxStoreBackend, RcxStoreName, StoreEntry, StoreKey } from './backend';
import { RCX_STORE_NAMES } from './backend';

interface MemoryEntry {
  key: StoreKey;
  value: unknown;
}

const clone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return value;
};

const normalizeKey = (key: StoreKey): unknown => {
  if (Array.isArray(key)) return ['array', key.map(normalizeKey)];
  if (key instanceof Date) return ['date', key.toISOString()];
  return [typeof key, key];
};

const serializeKey = (key: StoreKey): string => JSON.stringify(normalizeKey(key));

export const createMemoryBackend = (): RcxStoreBackend => {
  const stores = new Map<RcxStoreName, Map<string, MemoryEntry>>(
    RCX_STORE_NAMES.map((name) => [name, new Map()]),
  );

  return {
    async get<T>(store: RcxStoreName, key: StoreKey): Promise<T | undefined> {
      const entry = stores.get(store)?.get(serializeKey(key));
      return entry ? clone(entry.value as T) : undefined;
    },

    async set<T>(store: RcxStoreName, key: StoreKey, value: T): Promise<void> {
      stores.get(store)?.set(serializeKey(key), { key: clone(key), value: clone(value) });
    },

    async delete(store: RcxStoreName, key: StoreKey): Promise<void> {
      stores.get(store)?.delete(serializeKey(key));
    },

    async entries<T>(store: RcxStoreName): Promise<Array<StoreEntry<T>>> {
      return [...(stores.get(store)?.values() ?? [])].map((entry) => ({
        key: clone(entry.key),
        value: clone(entry.value as T),
      }));
    },

    async clear(store: RcxStoreName): Promise<void> {
      stores.get(store)?.clear();
    },
  };
};
