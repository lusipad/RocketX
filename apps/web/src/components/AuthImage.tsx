import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { assetUrl, isTauri, rest } from '../lib/client';

// path(站内相对路径) -> objectURL 缓存，避免重复拉取
const blobCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

async function loadAuthedBlob(path: string): Promise<string | null> {
  const cached = blobCache.get(path);
  if (cached) return cached;
  const running = inflight.get(path);
  if (running) return running;
  const promise = rest
    .fetchFile(path)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      blobCache.set(path, url);
      return url;
    })
    .catch(() => null)
    .finally(() => inflight.delete(path));
  inflight.set(path, promise);
  return promise;
}

/**
 * 站内图片（/file-upload、/avatar 等）：
 * - Web 端同源直连（cookie 认证已就位）；
 * - 桌面端 <img> 带不上认证（cookie 只作用于应用自身域），改为带头 fetch → blob。
 */
export default function AuthImage({
  path,
  fallback,
  ...imgProps
}: {
  path: string;
  /** 加载失败时渲染的内容 */
  fallback?: React.ReactNode;
} & ImgHTMLAttributes<HTMLImageElement>) {
  const needsBlob = isTauri && path.startsWith('/');
  const [src, setSrc] = useState<string | null>(
    needsBlob ? (blobCache.get(path) ?? null) : path.startsWith('/') ? assetUrl(path) : path,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!needsBlob) {
      setSrc(path.startsWith('/') ? assetUrl(path) : path);
      setFailed(false);
      return;
    }
    let alive = true;
    setFailed(false);
    void loadAuthedBlob(path).then((url) => {
      if (!alive) return;
      if (url) setSrc(url);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [path, needsBlob]);

  if (failed || (!src && needsBlob)) {
    return failed ? <>{fallback ?? null}</> : null;
  }
  return <img src={src ?? undefined} onError={() => setFailed(true)} {...imgProps} />;
}

// 下载统一走 lib/download.ts 的 saveFile（桌面端需要原生保存对话框，见那里的说明）
