import type { RcRoomFile, RoomType } from './types';
import { capabilityEnabled, type RocketChatCapabilities } from './capabilities';
import { RcApiError, currentAuth, type RcRestEndpointContext } from './request';

export interface RocketChatFilesDomain {
  getRoomFiles(rid: string, type: RoomType, count?: number): Promise<RcRoomFile[]>;
  fetchFile(path: string): Promise<Blob>;
  fetchFileResponse(path: string): Promise<Response>;
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
  return (await fetchFileResponse(context, path)).blob();
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
  opts: { msg?: string; tmid?: string; fileName?: string } = {},
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
  });
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
  };
}
