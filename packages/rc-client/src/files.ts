import type { RcRoomFile, RoomType } from './types';
import { capabilityEnabled, type RocketChatCapabilities } from './capabilities';
import { RcApiError, currentAuth, type RcRestEndpointContext } from './request';

export interface RocketChatFilesDomain {
  getRoomFiles(rid: string, type: RoomType, count?: number): Promise<RcRoomFile[]>;
  fetchFile(path: string): Promise<Blob>;
  fetchFileResponse(path: string): Promise<Response>;
  /** 流式下载并回调进度；signal 可取消（已建立的连接会被 reader.cancel 中断） */
  fetchFileWithProgress(
    path: string,
    options?: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number | null) => void;
    },
  ): Promise<Blob>;
}

export type RocketChatFilesSource = Partial<RocketChatFilesDomain> & {
  capabilities?: RocketChatCapabilities;
};

export async function fetchFileResponse(context: RcRestEndpointContext, path: string): Promise<Response> {
  const auth = currentAuth(context);
  const doFetch = context.fetchImpl ?? fetch;
  const absolute = /^https?:\/\//i.test(path);
  const base = context.baseUrl.replace(/\/+$/, '');
  const url = absolute ? path : `${base}${path}`;
  const ownServer = !absolute || (!!base && (url === base || url.startsWith(`${base}/`)));
  const authHeaders: Record<string, string> = auth && ownServer
    ? { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId }
    : {};
  const cookieAuth = ownServer
    && typeof location !== 'undefined'
    && new URL(url, location.href).origin === location.origin;

  let response: Response;
  if (!auth || !ownServer || cookieAuth) {
    response = await doFetch(url, cookieAuth ? { credentials: 'include' } : {});
  } else {
    let current = url;
    let headers: Record<string, string> = authHeaders;
    const serverOrigin = base ? new URL(base).origin : '';
    for (let redirects = 0; ; redirects += 1) {
      response = await doFetch(current, {
        headers,
        redirect: 'manual',
        maxRedirections: 0,
      } as RequestInit & { maxRedirections: number });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects >= 5) throw new RcApiError('文件下载重定向次数过多', 508);
      const locationHeader = response.headers.get('location');
      if (!locationHeader) throw new RcApiError('文件下载发生无法安全跟随的重定向', response.status || 502);
      current = new URL(locationHeader, current).href;
      headers = serverOrigin && new URL(current).origin === serverOrigin ? authHeaders : {};
    }
  }
  if (!response.ok) throw new RcApiError(`HTTP ${response.status}`, response.status);
  return response;
}

export async function fetchFile(context: RcRestEndpointContext, path: string): Promise<Blob> {
  const response = await fetchFileResponse(context, path);
  const blob = await response.blob();
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  return contentType && blob.type !== contentType
    ? blob.slice(0, blob.size, contentType)
    : blob;
}

/**
 * 流式下载站内文件并回调进度。
 *
 * total 来自 content-length；chunked/压缩响应可能拿不到，此时 total 为 null，
 * 调用方要按「只有已加载字节数」展示。响应没有 body（某些代理/老 WebView）时
 * 退化为一次性 blob，onProgress 只会收到终值。
 */
export async function fetchFileWithProgress(
  context: RcRestEndpointContext,
  path: string,
  options?: {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number | null) => void;
  },
): Promise<Blob> {
  const response = await fetchFileResponse(context, path);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
  const contentLength = response.headers.get('content-length');
  const total = contentLength !== null && Number.isFinite(Number(contentLength))
    ? Number(contentLength)
    : null;
  const body = response.body;
  if (!body) {
    const blob = await response.blob();
    options?.onProgress?.(blob.size, blob.size);
    return blob;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        options?.onProgress?.(loaded, total);
      }
    }
    // total 未知时补一次终值，让调用方的百分比展示能落到 100%
    if (total === null) options?.onProgress?.(loaded, loaded);
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks as BlobPart[], { type: contentType });
}

export async function getRoomFiles(context: RcRestEndpointContext, rid: string, type: RoomType, count = 50): Promise<RcRoomFile[]> {
  const endpoint = type === 'c' ? 'channels.files' : type === 'p' ? 'groups.files' : 'im.files';
  const response = await context.request<{ files: RcRoomFile[] }>('GET', endpoint, undefined, {
    roomId: rid,
    count,
    sort: JSON.stringify({ uploadedAt: -1 }),
  });
  return response.files ?? [];
}

export async function uploadMedia(
  context: RcRestEndpointContext,
  rid: string,
  file: Blob,
  opts: {
    msg?: string;
    tmid?: string;
    fileName?: string;
    /** 取消上传：浏览器/Tauri fetch 支持 signal；rooms.mediaConfirm 前都会中断 */
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const name = opts.fileName ?? (typeof File !== 'undefined' && file instanceof File ? file.name : 'file');
  const boundary = `----rcx${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const safeName = name.replace(/"/g, '%22').replace(/[\r\n]/g, ' ');
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Blob([head, file, tail]);
  const auth = currentAuth(context);
  const doFetch = context.fetchImpl ?? fetch;
  const restBasePath = context.capabilities.endpoint.restBasePath.replace(/\/+$/, '');
  const response = await doFetch(`${context.baseUrl}${restBasePath}/rooms.media/${rid}`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...(auth ? { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId } : {}),
    },
    body,
    ...(opts.signal ? { signal: opts.signal } : {}),
  } as RequestInit);
  const data: any = await response.json().catch(() => null);
  if (!response.ok) throw new RcApiError(data?.error ?? `HTTP ${response.status}`, response.status, data?.errorType);
  await context.request('POST', `rooms.mediaConfirm/${rid}/${data.file._id}`, {
    msg: opts.msg ?? '',
    ...(opts.tmid ? { tmid: opts.tmid } : {}),
  });
}

function required<K extends keyof RocketChatFilesDomain>(source: RocketChatFilesSource, key: K): NonNullable<RocketChatFilesDomain[K]> {
  const operation = source[key];
  if (typeof operation !== 'function') throw new Error(`Rocket.Chat files domain unavailable: ${String(key)}`);
  return operation.bind(source) as NonNullable<RocketChatFilesDomain[K]>;
}

export function createRocketChatFilesDomain(source: RocketChatFilesSource): RocketChatFilesDomain {
  const ensureDownload = () => {
    if (source.capabilities && !capabilityEnabled(source.capabilities, 'files')) {
      throw new Error('Rocket.Chat server does not advertise file transfer capability');
    }
  };
  return {
    getRoomFiles: (rid, type, count) => {
      ensureDownload();
      return required(source, 'getRoomFiles')(rid, type, Math.max(1, count ?? 50));
    },
    fetchFile: (path) => {
      ensureDownload();
      return required(source, 'fetchFile')(path);
    },
    fetchFileResponse: (path) => {
      ensureDownload();
      return required(source, 'fetchFileResponse')(path);
    },
    fetchFileWithProgress: (path, options) => {
      ensureDownload();
      return required(source, 'fetchFileWithProgress')(path, options);
    },
  };
}
