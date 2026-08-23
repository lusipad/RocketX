import type { RocketChatCapabilities } from './capabilities';

export class RcApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public errorType?: string,
  ) {
    super(message);
    this.name = 'RcApiError';
  }
}

export interface RcRestOptions {
  /** Rocket.Chat 服务地址，留空表示同源（开发时经 Vite 代理） */
  baseUrl?: string;
  /** 每次请求实时取认证信息，优先于 setAuth 注入的内存状态。 */
  authProvider?: () => { authToken: string; userId: string } | null;
  /** 桌面端可注入 Tauri plugin-http 的 fetch。 */
  fetchImpl?: typeof fetch;
  /** 已认证请求收到 401 时通知上层登出。 */
  onAuthError?: () => void;
}

export interface RcRestRequestContext {
  baseUrl: string;
  authToken: string | null;
  userId: string | null;
  capabilities: RocketChatCapabilities;
  authProvider?: RcRestOptions['authProvider'];
  fetchImpl?: typeof fetch;
  onAuthError?: () => void;
}

export type RcRestMethod = 'GET' | 'POST';

export interface RcRestEndpointContext extends RcRestRequestContext {
  request<T>(
    method: RcRestMethod,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T>;
  setAuth(authToken: string | null, userId: string | null): void;
  currentUserId(): string | null;
}

export function currentAuth(context: RcRestRequestContext): { authToken: string; userId: string } | null {
  return context.authProvider?.() ?? (
    context.authToken && context.userId
      ? { authToken: context.authToken, userId: context.userId }
      : null
  );
}

export function sanitizeMultipartToken(value: string): string {
  return value.replace(/"/g, '%22').replace(/[\r\n]/g, ' ');
}

/** Multipart transport used by user/avatar and custom-emoji endpoints. */
export async function postMultipart(
  context: RcRestEndpointContext,
  path: string,
  fieldName: string,
  file: Blob,
  fileName: string,
  textFields?: Record<string, string | undefined>,
): Promise<any> {
  const boundary = `----rcx${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const parts: Uint8Array[] = [];
  const pushTextField = (name: string, value: string) => {
    parts.push(encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${sanitizeMultipartToken(name)}"\r\n\r\n` +
        `${value}\r\n`,
    ));
  };
  for (const [name, value] of Object.entries(textFields ?? {})) {
    if (value !== undefined) pushTextField(name, value);
  }
  parts.push(encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${sanitizeMultipartToken(fieldName)}"; filename="${sanitizeMultipartToken(fileName)}"\r\n` +
      `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
  ));
  parts.push(fileBytes, encoder.encode(`\r\n--${boundary}--\r\n`));
  const bodyLength = parts.reduce((total, part) => total + part.length, 0);
  const body = new Uint8Array(bodyLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  const auth = currentAuth(context);
  const doFetch = context.fetchImpl ?? fetch;
  const restBasePath = context.capabilities.endpoint.restBasePath.replace(/\/+$/, '');
  const response = await doFetch(`${context.baseUrl}${restBasePath}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...(auth ? { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId } : {}),
    },
    body,
  });
  const data: any = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RcApiError(data?.error ?? `HTTP ${response.status}`, response.status, data?.errorType);
  }
  return data;
}

/** The one transport path used by all Rocket.Chat endpoint domains. */
export async function request<T>(
  context: RcRestRequestContext,
  method: RcRestMethod,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const restBasePath = context.capabilities.endpoint.restBasePath.replace(/\/+$/, '');
  let url = `${context.baseUrl}${restBasePath}/${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) qs.set(key, String(value));
    }
    const serialized = qs.toString();
    if (serialized) url += `?${serialized}`;
  }
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers: Record<string, string> = {};
  if (!isForm) headers['Content-Type'] = 'application/json';
  const auth = currentAuth(context);
  if (auth) {
    headers['X-Auth-Token'] = auth.authToken;
    headers['X-User-Id'] = auth.userId;
  }
  const doFetch = context.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // Some endpoints intentionally return an empty response body.
  }
  if (!response.ok) {
    if (response.status === 401 && auth && path !== 'login') context.onAuthError?.();
    throw new RcApiError(
      data?.error ?? data?.message ?? `HTTP ${response.status}`,
      response.status,
      data?.errorType,
    );
  }
  return data as T;
}
