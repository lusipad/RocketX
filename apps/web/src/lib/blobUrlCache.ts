interface BlobUrlEntry {
  url: string;
  refs: number;
  usedAt: number;
}

export class BlobUrlCache {
  private readonly entries = new Map<string, BlobUrlEntry>();
  private clock = 0;

  constructor(
    private readonly limit: number,
    private readonly revoke: (url: string) => void,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.usedAt = ++this.clock;
    return entry.url;
  }

  put(key: string, url: string): void {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.url !== url && existing.refs === 0) this.revoke(existing.url);
      else if (existing.url !== url) {
        this.revoke(url);
        return;
      }
    }
    this.entries.set(key, { url, refs: existing?.refs ?? 0, usedAt: ++this.clock });
    this.prune(key);
  }

  retain(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs += 1;
    entry.usedAt = ++this.clock;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    this.prune();
  }

  private prune(protectedKey?: string): void {
    while (this.entries.size > this.limit) {
      const candidate = [...this.entries.entries()]
        .filter(([key, entry]) => key !== protectedKey && entry.refs === 0)
        .sort((left, right) => left[1].usedAt - right[1].usedAt)[0];
      if (!candidate) return;
      this.entries.delete(candidate[0]);
      this.revoke(candidate[1].url);
    }
  }
}
