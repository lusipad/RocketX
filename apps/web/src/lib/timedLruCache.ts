export type CacheLookup<T> = { hit: true; value: T } | { hit: false };

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

export class TimedLruCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly limit: number,
    private readonly ttlMs: number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string, now = Date.now()): CacheLookup<T> {
    const entry = this.entries.get(key);
    if (!entry) return { hit: false };
    if (now - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return { hit: false };
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { hit: true, value: entry.value };
  }

  set(key: string, value: T, now = Date.now()): void {
    for (const [entryKey, entry] of this.entries) {
      if (now - entry.storedAt >= this.ttlMs) this.entries.delete(entryKey);
    }
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: now });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
