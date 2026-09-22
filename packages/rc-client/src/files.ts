import type { RcRoomFile, RoomType } from './types';
import { capabilityEnabled, type RocketChatCapabilities } from './capabilities';
import { RcApiError, currentAuth, type RcRestEndpointContext } from './request';

export interface RocketChatFilesDomain {
  getRoomFiles(rid: string, type: RoomType, count?: number): Promise<RcRoomFile[]>;
  fetchFile(path: string): Promise<Blob>;
  fetchFileResponse(path: string): Promise<Response>;
  /** 断点续传的文件字节流；桌面端下载与预览都走它（issue #393） */
  openFileStream(path: string, options?: FileStreamOptions): Promise<FileByteStream>;
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

/**
 * 下载中断后的续传次数上限。
 *
 * 反向代理、安全网关和杀毒软件最爱掐的就是 HTML 附件：连接在传到一半时被断开，
 * 桌面端底层 reqwest 把任何 body 传输错误都显示成 `error decoding response body`
 * （issue #393）。一次性失败对用户毫无意义 —— 先按 Range 续传，续不上就整文件重下。
 */
const DOWNLOAD_RESUME_LIMIT = 3;

/**
 * 站内文件请求一律要求不压缩。
 *
 * 桌面端的 tauri-plugin-http 没有开 reqwest 的 gzip/br 特性：一旦中间的反向代理
 * 按 `text/html` 压缩了响应，客户端既解不开、也校验不了长度。浏览器会忽略这个
 * 禁止修改的请求头（网页端本来就由浏览器解压），桌面端则借 `unsafe-headers`
 * 真的发出去，把「html 下载到一半失败 / 存下来打不开」这类问题挡在源头。
 */
const IDENTITY_ENCODING: Record<string, string> = { 'Accept-Encoding': 'identity' };

export interface FileStreamOptions {
  /** 取消下载：中断读取，不再续传 */
  signal?: AbortSignal;
}

export interface FileByteStream {
  /** 传输中断时自动续传的字节流 */
  stream: ReadableStream<Uint8Array>;
  /** content-length；chunked / 压缩响应拿不到时为 null */
  total: number | null;
  /** content-type 的主体部分（去掉 charset 等参数）；响应没给时为 null */
  contentType: string | null;
}

/** 传输被掐断且续传用尽时抛它，保留原始错误，别让英文底层串直接糊到用户脸上 */
export class RcDownloadInterruptedError extends Error {
  constructor(
    public loaded: number,
    public total: number | null,
    cause: unknown,
  ) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    super(
      `下载中断：与服务器的连接在传输过程中被切断（已自动续传 ${DOWNLOAD_RESUME_LIMIT} 次仍未成功）。`
      + '常见原因是反向代理、安全网关或杀毒软件掐断了附件传输，请检查服务器与代理配置后重试。'
      + `（原始错误：${raw}）`,
    );
    this.name = 'RcDownloadInterruptedError';
    this.cause = cause;
  }
}

function isAbort(err: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError')
    || (err instanceof Error && err.name === 'AbortError')
  );
}

/** content-length 缺失时必须是 null：`Number(null)` 是 0，会把进度算成 Infinity% */
export function parseContentLength(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function fetchFileResponse(
  context: RcRestEndpointContext,
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const auth = currentAuth(context);
  const doFetch = context.fetchImpl ?? fetch;
  const absolute = /^https?:\/\//i.test(path);
  const base = context.baseUrl.replace(/\/+$/, '');
  const url = absolute ? path : `${base}${path}`;
  const ownServer = !absolute || (!!base && (url === base || url.startsWith(`${base}/`)));
  const extra = { ...IDENTITY_ENCODING, ...extraHeaders };
  const authHeaders: Record<string, string> = auth && ownServer
    ? { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId, ...extra }
    : { ...extra };
  const cookieAuth = ownServer
    && typeof location !== 'undefined'
    && new URL(url, location.href).origin === location.origin;

  let response: Response;
  if (!auth || !ownServer || cookieAuth) {
    response = await doFetch(url, cookieAuth
      ? { credentials: 'include', headers: extra }
      : { headers: extra });
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
      headers = serverOrigin && new URL(current).origin === serverOrigin ? authHeaders : { ...extra };
    }
  }
  if (!response.ok) throw new RcApiError(`HTTP ${response.status}`, response.status);
  return response;
}

/**
 * 打开一条「断了会自己接上」的文件字节流。
 *
 * 传输中断（桌面端表现为 `error decoding response body`，网页端是 network error）
 * 时先用 `Range: bytes=<已收字节>-` 续传；服务端不支持 Range（回 200 而不是 206）
 * 就整文件重下、丢掉已经拿到的前缀，对调用方始终是一条连续、完整的字节流。
 * 续传次数用尽才抛 RcDownloadInterruptedError —— 带中文解释和原始错误。
 *
 * 响应没有 body（某些代理 / 老 WebView）时退化成一次性 blob 包成的单块流。
 */
export async function openFileStream(
  context: RcRestEndpointContext,
  path: string,
  options?: FileStreamOptions,
): Promise<FileByteStream> {
  const first = await fetchFileResponse(context, path);
  const contentType = first.headers.get('content-type')?.split(';', 1)[0]?.trim() || null;
  const total = parseContentLength(first.headers.get('content-length'));

  if (!first.body) {
    const blob = await first.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      contentType,
      total: total ?? bytes.length,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          if (bytes.length) controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }

  let reader = first.body.getReader();
  let loaded = 0;
  /** 服务端不支持 Range 时重下整个文件，这里记下还要丢掉多少字节 */
  let skip = 0;
  let resumes = 0;

  /**
   * 接着已收到的字节续传。返回 false 表示服务端说没有更多字节了（416），按读完处理；
   * 续传次数用尽则抛 RcDownloadInterruptedError，带上最后一次的原始错误。
   */
  const resumeFrom = async (cause: unknown): Promise<boolean> => {
    let lastError = cause;
    while (resumes < DOWNLOAD_RESUME_LIMIT) {
      resumes += 1;
      try {
        const response = await fetchFileResponse(context, path, { Range: `bytes=${loaded}-` });
        if (!response.body) throw new RcApiError('续传响应没有可读取的内容', response.status || 502);
        reader = response.body.getReader();
        // 206 就是从断点接上；200 说明服务端不认 Range，整文件重下、丢掉已有前缀
        skip = response.status === 206 ? 0 : loaded;
        return true;
      } catch (err) {
        if (isAbort(err)) throw err;
        // 416 = 请求区间越过文件末尾。长度未知时这就是「已经传完了」；
        // content-length 明说还差字节的话，它只能是服务端自相矛盾，照样算失败。
        if (err instanceof RcApiError && err.status === 416 && total === null) return false;
        lastError = err;
      }
    }
    throw new RcDownloadInterruptedError(loaded, total, lastError);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (isAbort(err) || options?.signal?.aborted) throw err;
          if (!(await resumeFrom(err))) {
            controller.close();
            return;
          }
          continue;
        }
        if (chunk.done) {
          // 取消之后 read() 也会正常返回 done，别把用户主动取消当成中断去续传
          if (options?.signal?.aborted) {
            controller.close();
            return;
          }
          // content-length 说还有字节没到：连接是「干净地」断在半路（chunked 提前收尾、
          // 代理截断），照样当作中断续传，绝不把半截文件当成功交出去。
          if (total !== null && loaded < total) {
            if (!(await resumeFrom(new Error(`响应提前结束：只收到 ${loaded}/${total} 字节`)))) {
              controller.close();
              return;
            }
            continue;
          }
          controller.close();
          return;
        }
        let value = chunk.value;
        if (!value || value.length === 0) continue;
        if (skip > 0) {
          if (value.length <= skip) {
            skip -= value.length;
            continue;
          }
          value = value.subarray(skip);
          skip = 0;
        }
        loaded += value.length;
        controller.enqueue(value);
        return;
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });

  return { stream, total, contentType };
}

/** 收完整条流；中断续传由 openFileStream 兜住 */
async function drain(
  context: RcRestEndpointContext,
  path: string,
  options?: {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number | null) => void;
  },
): Promise<{ chunks: Uint8Array[]; contentType: string | null }> {
  const { stream, total, contentType } = await openFileStream(context, path, { signal: options?.signal });
  const reader = stream.getReader();
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
  return { chunks, contentType };
}

export async function fetchFile(context: RcRestEndpointContext, path: string): Promise<Blob> {
  // 类型留空而不是兜底成 octet-stream：<img src=blob:> 和剪贴板都按 blob.type 走，
  // 服务端没给 content-type 时让浏览器自己嗅探，别塞一个错的进去。
  const { chunks, contentType } = await drain(context, path);
  return new Blob(chunks as BlobPart[], { type: contentType ?? '' });
}

/**
 * 流式下载站内文件并回调进度。
 *
 * total 来自 content-length；chunked/压缩响应可能拿不到，此时 total 为 null，
 * 调用方要按「只有已加载字节数」展示。传输中断由 openFileStream 自动续传，
 * 续不回来才抛错（RcDownloadInterruptedError）。
 */
export async function fetchFileWithProgress(
  context: RcRestEndpointContext,
  path: string,
  options?: {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number | null) => void;
  },
): Promise<Blob> {
  const { chunks, contentType } = await drain(context, path, options);
  return new Blob(chunks as BlobPart[], { type: contentType ?? 'application/octet-stream' });
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
    /**
     * 上传字节进度（浏览器）。fetch 本身不提供「已发送字节」，要百分比只能在
     * 浏览器里退到 XHR（upload.onprogress）；桌面端 fetch 被 Tauri 插件接管、
     * 无进度事件，传了也不会生效——桌面百分比需要 Rust 通道（issue #385）。
     */
    onUploadProgress?: (loaded: number, total: number) => void;
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
  const restBasePath = context.capabilities.endpoint.restBasePath.replace(/\/+$/, '');
  const url = `${context.baseUrl}${restBasePath}/rooms.media/${rid}`;
  const multipartHeaders: Record<string, string> = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    ...(auth ? { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId } : {}),
  };

  // 浏览器 + 需要进度：XHR 的 upload.onprogress 是唯一拿得到「已发送字节」的通道。
  // 桌面端 fetchImpl 是 Tauri 插件（无进度），Node 无 XHR——都保持纯 fetch 路径。
  const browserXhr =
    !!opts.onUploadProgress && !context.fetchImpl && typeof XMLHttpRequest !== 'undefined';

  const parseResult = (status: number, text: string) => {
    const parsed: any = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    if (status < 200 || status >= 300) {
      throw new RcApiError(parsed?.error ?? `HTTP ${status}`, status, parsed?.errorType);
    }
    return parsed;
  };

  let responseStatus = 0;
  let responseText = '';
  if (browserXhr) {
    responseStatus = await new Promise<number>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const [header, value] of Object.entries(multipartHeaders)) {
        xhr.setRequestHeader(header, value);
      }
      xhr.upload.onprogress = (event) =>
        opts.onUploadProgress?.(event.loaded, event.total || body.size);
      const onAbort = () => {
        xhr.abort();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => opts.signal?.removeEventListener('abort', onAbort);
      const finish = (code: number) => {
        cleanup();
        responseText = xhr.responseText;
        resolve(code);
      };
      xhr.onload = () => finish(xhr.status);
      xhr.onerror = () => {
        cleanup();
        reject(new RcApiError('上传请求失败', 0));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException('上传已取消', 'AbortError'));
      };
      xhr.send(body);
    }).catch((err) => {
      if (opts.signal?.aborted) throw new DOMException('上传已取消', 'AbortError');
      throw err;
    });
  } else {
    const doFetch = context.fetchImpl ?? fetch;
    const response = await doFetch(url, {
      method: 'POST',
      headers: multipartHeaders,
      body,
      ...(opts.signal ? { signal: opts.signal } : {}),
    } as RequestInit);
    responseStatus = response.status;
    responseText = await response.text();
  }
  const data: any = await parseResult(responseStatus, responseText);
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
    openFileStream: (path, options) => {
      ensureDownload();
      return required(source, 'openFileStream')(path, options);
    },
    fetchFileWithProgress: (path, options) => {
      ensureDownload();
      return required(source, 'fetchFileWithProgress')(path, options);
    },
  };
}
