import type { RcxStoreBackend, RcxStoreName, StoreEntry, StoreKey } from './backend';
import { RCX_STORE_NAMES } from './backend';

export interface IndexedDbBackendOptions {
  name?: string;
  indexedDB?: IDBFactory;
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });

const toIdbKey = (key: StoreKey): IDBValidKey => key as IDBValidKey;

export const createIndexedDbBackend = (
  options: IndexedDbBackendOptions = {},
): RcxStoreBackend => {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available; inject createMemoryBackend() in tests');

  let database: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = factory.open(options.name ?? 'rocketchatx', 1);
      request.onupgradeneeded = () => {
        for (const store of RCX_STORE_NAMES) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked'));
    });
    return database;
  };

  const storeFor = async (name: RcxStoreName, mode: IDBTransactionMode) => {
    const db = await open();
    const transaction = db.transaction(name, mode);
    return { store: transaction.objectStore(name), transaction };
  };

  return {
    async get<T>(name: RcxStoreName, key: StoreKey): Promise<T | undefined> {
      const { store } = await storeFor(name, 'readonly');
      return requestResult(store.get(toIdbKey(key))) as Promise<T | undefined>;
    },

    async set<T>(name: RcxStoreName, key: StoreKey, value: T): Promise<void> {
      const { store, transaction } = await storeFor(name, 'readwrite');
      store.put(value, toIdbKey(key));
      await transactionDone(transaction);
    },

    async delete(name: RcxStoreName, key: StoreKey): Promise<void> {
      const { store, transaction } = await storeFor(name, 'readwrite');
      store.delete(toIdbKey(key));
      await transactionDone(transaction);
    },

    async entries<T>(name: RcxStoreName): Promise<Array<StoreEntry<T>>> {
      const { store } = await storeFor(name, 'readonly');
      return new Promise((resolve, reject) => {
        const entries: Array<StoreEntry<T>> = [];
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(entries);
            return;
          }
          entries.push({ key: cursor.key as StoreKey, value: cursor.value as T });
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error('Unable to read IndexedDB entries'));
      });
    },

    async clear(name: RcxStoreName): Promise<void> {
      const { store, transaction } = await storeFor(name, 'readwrite');
      store.clear();
      await transactionDone(transaction);
    },

    close(): void {
      if (!database) return;
      void database.then((db) => db.close(), () => undefined);
      database = undefined;
    },
  };
};
