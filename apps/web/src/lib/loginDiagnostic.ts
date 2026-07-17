import { ensureHttpOrigin, httpFetch } from './http';

export type LoginFailureKind =
  | 'invalid_address'
  | 'unreachable'
  | 'not_rocket_chat'
  | 'credentials'
  | 'session_expired'
  | 'unknown';

const FAILURE_MESSAGES: Record<LoginFailureKind, string> = {
  invalid_address: '服务器地址无效，请填写以 http:// 或 https:// 开头的完整地址',
  unreachable: '无法连接服务器，请检查地址、网络、VPN、证书或浏览器跨域设置',
  not_rocket_chat: '该地址不是可用的 Rocket.Chat 服务，请检查是否填到了正确的站点根地址',
  credentials: '用户名或密码错误',
  session_expired: '登录已失效，请重新登录',
  unknown: '登录失败，请重试',
};

export function classifyLoginFailure(error: unknown): LoginFailureKind {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/^invalid_address$|invalid url|failed to parse url/i.test(raw)) return 'invalid_address';
  if (/unauthorized|invalid user|invalid password|user not found|status 401|http 401/i.test(raw)) {
    return 'credentials';
  }
  if (/session.*expired|token.*expired|login.*expired/i.test(raw)) return 'session_expired';
  if (/^not_rocket_chat$|http 404|status 404|unexpected token.*</i.test(raw)) {
    return 'not_rocket_chat';
  }
  if (
    /fetch|network|load failed|error sending request|connection|dns|certificate|tls|timed? ?out|not allowed|scope/i.test(
      raw,
    )
  ) {
    return 'unreachable';
  }
  return 'unknown';
}

export function loginFailureMessage(error: unknown): string {
  const kind = classifyLoginFailure(error);
  if (kind !== 'unknown') return FAILURE_MESSAGES[kind];
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return raw || FAILURE_MESSAGES.unknown;
}

export async function probeRocketChat(baseUrl: string): Promise<string> {
  let response: Response;
  try {
    await ensureHttpOrigin(baseUrl);
    response = await httpFetch(`${baseUrl}/api/info`);
  } catch (error) {
    if (import.meta.env.DEV) throw error;
    throw new Error(classifyLoginFailure(error) === 'invalid_address' ? 'invalid_address' : 'unreachable');
  }
  if (!response.ok) throw new Error(response.status === 404 ? 'not_rocket_chat' : `HTTP ${response.status}`);
  try {
    const data = (await response.json()) as { version?: string; info?: { version?: string } };
    const version = data.version ?? data.info?.version;
    if (!version) throw new Error('not_rocket_chat');
    return version;
  } catch (error) {
    if (error instanceof Error && error.message === 'not_rocket_chat') throw error;
    throw new Error('not_rocket_chat');
  }
}
