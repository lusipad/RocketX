import { BlobUrlCache } from './blobUrlCache';

export type AuthImageCacheKind = 'avatar' | 'content';

function cacheKind(path: string): AuthImageCacheKind {
  return path.startsWith('/avatar/') ? 'avatar' : 'content';
}

export class AuthImageBlobCache {
  private readonly avatars: BlobUrlCache;
  private readonly content: BlobUrlCache;

  constructor(
    avatarLimit: number,
    contentLimit: number,
    revoke: (url: string) => void,
  ) {
    this.avatars = new BlobUrlCache(avatarLimit, revoke);
    this.content = new BlobUrlCache(contentLimit, revoke);
  }

  get(path: string, key: string): string | null {
    return this.cache(path).get(key);
  }

  put(path: string, key: string, url: string): void {
    this.cache(path).put(key, url);
  }

  retain(path: string, key: string): void {
    this.cache(path).retain(key);
  }

  release(path: string, key: string): void {
    this.cache(path).release(key);
  }

  size(kind: AuthImageCacheKind): number {
    return kind === 'avatar' ? this.avatars.size : this.content.size;
  }

  private cache(path: string): BlobUrlCache {
    return cacheKind(path) === 'avatar' ? this.avatars : this.content;
  }
}
