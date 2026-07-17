export const RCX_STORE_NAMES = ['apps', 'app-data', 'vectors', 'outbox', 'audit'] as const;

export type RcxStoreName = (typeof RCX_STORE_NAMES)[number];
export type StoreKey = string | number | Date | readonly StoreKey[];

export interface StoreEntry<T> {
  key: StoreKey;
  value: T;
}

export interface RcxStoreBackend {
  get<T>(store: RcxStoreName, key: StoreKey): Promise<T | undefined>;
  set<T>(store: RcxStoreName, key: StoreKey, value: T): Promise<void>;
  delete(store: RcxStoreName, key: StoreKey): Promise<void>;
  entries<T>(store: RcxStoreName): Promise<Array<StoreEntry<T>>>;
  clear(store: RcxStoreName): Promise<void>;
  close?(): void;
}
