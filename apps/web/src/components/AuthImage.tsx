import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import {
  assetUrl,
  getServerBase,
  isTauri,
  loadStoredAuth,
  normalizeAssetPath,
  rest,
} from '../lib/client';
import { AuthImageBlobCache } from '../lib/authImageCache';

// 头像比聊天图片更常复用，必须分池：否则浏览图片或打开大通讯录会把会话头像全部挤掉。
const blobCache = new AuthImageBlobCache(256, 128, (url) => URL.revokeObjectURL(url));
const inflight = new Map<string, Promise<string | null>>();

async function loadAuthedBlob(path: string, cacheKey: string): Promise<string | null> {
  const cached = blobCache.get(path, cacheKey);
  if (cached) return cached;
  const running = inflight.get(cacheKey);
  if (running) return running;
  const promise = rest
    .fetchFile(path)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      blobCache.put(path, cacheKey, url);
      return blobCache.get(path, cacheKey);
    })
    .catch(() => null)
    .finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, promise);
  return promise;
}

/**
 * 站内图片（/file-upload、/avatar 等）：
 * - Web 端同源直连（cookie 认证已就位）；
 * - 桌面端 <img> 带不上认证（cookie 只作用于应用自身域），改为带头 fetch → blob。
 */
export default function AuthImage({
  path: rawPath,
  fallback,
  ...imgProps
}: {
  path: string;
  /** 加载失败时渲染的内容 */
  fallback?: React.ReactNode;
} & ImgHTMLAttributes<HTMLImageElement>) {
  // Site_Url 拼的绝对地址重拼到当前连接地址（否则打到不可达的主机上，issue #19-8）
  const path = normalizeAssetPath(rawPath);
  const needsBlob = isTauri && path.startsWith('/');
  const cacheKey = `${getServerBase()}\0${loadStoredAuth()?.userId ?? ''}\0${path}`;
  const [src, setSrc] = useState<string | null>(
    needsBlob
      ? (blobCache.get(path, cacheKey) ?? null)
      : path.startsWith('/')
        ? assetUrl(path)
        : path,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!needsBlob) {
      setSrc(path.startsWith('/') ? assetUrl(path) : path);
      setFailed(false);
      return;
    }
    let alive = true;
    let retained = false;
    setFailed(false);
    const cached = blobCache.get(path, cacheKey);
    if (cached) {
      blobCache.retain(path, cacheKey);
      retained = true;
      setSrc(cached);
    } else {
      setSrc(null);
    }
    void loadAuthedBlob(path, cacheKey).then((url) => {
      if (!alive) return;
      if (url) {
        if (!retained) {
          blobCache.retain(path, cacheKey);
          retained = true;
        }
        setSrc(url);
      }
      else setFailed(true);
    });
    return () => {
      alive = false;
      if (retained) blobCache.release(path, cacheKey);
    };
  }, [path, needsBlob, cacheKey]);

  if (failed || (!src && needsBlob)) {
    return <>{fallback ?? null}</>;
  }
  return <img src={src ?? undefined} onError={() => setFailed(true)} {...imgProps} />;
}

// 下载统一走 lib/download.ts 的 saveFile（桌面端需要原生保存对话框，见那里的说明）
