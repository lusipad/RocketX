import { sanitizeDiagnosticText, writeDiagnostic } from './diagnostics';
import { ensureHttpOrigin, httpFetch } from './http';

export type LoginFailureKind =
  | 'invalid_address'
  | 'unreachable'
  | 'dns'
  | 'tls'
  | 'proxy'
  | 'timeout'
  | 'scope'
  | 'http_status'
  | 'not_rocket_chat'
  | 'credentials'
  | 'session_expired'
  | 'unknown';

export type LoginFailureStage = 'probe' | 'login';

export interface LoginFailureDisplay {
  kind: LoginFailureKind;
  stage: LoginFailureStage;
  summary: string;
  detail: string | null;
  diagnostic: string;
}

const HTTP_STATUS_PATTERN = /\b(?:http|status)\s*(\d{3})\b/i;

function rawLoginFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function safeLoginFailure(error: unknown): string {
  return sanitizeDiagnosticText(rawLoginFailure(error));
}

function extractHttpStatus(raw: string): number | null {
  const match = raw.match(HTTP_STATUS_PATTERN);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
}

export function classifyLoginFailure(error: unknown): LoginFailureKind {
  const raw = rawLoginFailure(error);
  if (/^invalid_address$|invalid url|failed to parse url/i.test(raw)) return 'invalid_address';
  if (/session.*expired|token.*expired|login.*expired/i.test(raw)) return 'session_expired';
  if (/^not_rocket_chat$|http 404|status 404|unexpected token.*</i.test(raw)) {
    return 'not_rocket_chat';
  }
  if (/unauthorized|invalid user|invalid password|user not found|status 401|http 401/i.test(raw)) {
    return 'credentials';
  }
  if (/proxy|status 407|tunnel|pac script|socks/i.test(raw)) return 'proxy';
  if (/getaddrinfo|enotfound|dns|name or service not known|could not resolve host/i.test(raw)) return 'dns';
  if (/certificate|tls|ssl|self signed|unknown ca|handshake|peer verification/i.test(raw)) return 'tls';
  if (/timed? ?out|deadline exceeded|timeout/i.test(raw)) return 'timeout';
  if (/cors|origin|scope|not allowed|denied by policy/i.test(raw)) return 'scope';
  if (extractHttpStatus(raw) !== null) return 'http_status';
  if (/^unreachable$|^unreadable$|fetch|network|load failed|error sending request|connection/i.test(raw)) {
    return 'unreachable';
  }
  return 'unknown';
}

function summaryForFailure(kind: LoginFailureKind, stage: LoginFailureStage): string {
  if (kind === 'invalid_address') return '服务器地址无效，请填写以 http:// 或 https:// 开头的完整地址';
  if (kind === 'credentials') return '用户名或密码错误';
  if (kind === 'session_expired') return '登录已失效，请重新登录';
  if (kind === 'not_rocket_chat') return '该地址不是可用的 Rocket.Chat 服务，请检查是否填到了正确的站点根地址';
  if (kind === 'tls') {
    return stage === 'probe'
      ? '无法检查服务器，请确认该 HTTPS 证书在这台机器上受信任'
      : '登录请求失败，请确认该 HTTPS 证书在这台机器上受信任';
  }
  if (kind === 'dns') {
    return stage === 'probe'
      ? '无法检查服务器，请确认服务器地址可解析且当前网络可访问'
      : '登录请求失败，请确认服务器地址可解析且当前网络可访问';
  }
  if (kind === 'proxy') {
    return stage === 'probe'
      ? '无法检查服务器，请检查代理、网关或 VPN 配置'
      : '登录请求失败，请检查代理、网关或 VPN 配置';
  }
  if (kind === 'timeout') {
    return stage === 'probe' ? '检查服务器超时，请稍后重试' : '登录请求超时，请稍后重试';
  }
  if (kind === 'scope') {
    return stage === 'probe'
      ? '桌面端当前没有权限访问该服务器，请检查跨域或网络白名单配置'
      : '桌面端当前没有权限发起登录请求，请检查跨域或网络白名单配置';
  }
  if (kind === 'http_status') {
    return stage === 'probe' ? '服务器检查失败，请稍后重试' : '登录请求失败，请稍后重试';
  }
  if (kind === 'unreachable') {
    return stage === 'probe'
      ? '无法检查服务器，请检查地址、网络、VPN 或桌面端访问权限'
      : '登录请求没有成功发出，请检查地址、网络、VPN 或桌面端访问权限';
  }
  return stage === 'probe' ? '检查服务器失败，请查看详细原因后重试' : '登录失败，请查看详细原因后重试';
}

function detailLabel(kind: LoginFailureKind, raw: string): string | null {
  if (!raw) return null;
  if (kind === 'invalid_address' || kind === 'credentials' || kind === 'session_expired' || kind === 'not_rocket_chat') {
    return null;
  }
  if (kind === 'dns') return `域名解析失败：${raw}`;
  if (kind === 'tls') return `证书/TLS 校验失败：${raw}`;
  if (kind === 'proxy') return `代理或网关连接失败：${raw}`;
  if (kind === 'timeout') return `请求超时：${raw}`;
  if (kind === 'scope') return `桌面端网络权限受限：${raw}`;
  if (kind === 'http_status') {
    const status = extractHttpStatus(raw);
    return status ? `服务器返回 HTTP ${status}：${raw}` : `服务器返回异常状态：${raw}`;
  }
  if (kind === 'unreachable') {
    if (/^(?:unreachable|unreadable)$/i.test(raw)) {
      return '桌面网络通道没有读取到可用响应；常见原因是代理或网关中断、系统证书不受信任，或服务器提前关闭连接';
    }
    return `底层网络错误：${raw}`;
  }
  return `底层原因：${raw}`;
}

export function describeLoginFailure(
  error: unknown,
  stage: LoginFailureStage = 'login',
): LoginFailureDisplay {
  const kind = classifyLoginFailure(error);
  const raw = safeLoginFailure(error);
  const detail = detailLabel(kind, raw);
  return {
    kind,
    stage,
    summary: summaryForFailure(kind, stage),
    detail,
    diagnostic: `stage=${stage} kind=${kind} detail=${detail ?? raw ?? 'n/a'}`,
  };
}

export function loginFailureMessage(
  error: unknown,
  stage: LoginFailureStage = 'login',
): string {
  return describeLoginFailure(error, stage).summary;
}

export async function writeLoginDiagnostic(
  error: unknown,
  stage: LoginFailureStage,
): Promise<LoginFailureDisplay> {
  const failure = describeLoginFailure(error, stage);
  await writeDiagnostic('error', 'auth', failure.diagnostic);
  return failure;
}

export async function probeRocketChat(baseUrl: string): Promise<string> {
  await ensureHttpOrigin(baseUrl);
  const response = await httpFetch(`${baseUrl}/api/info`);
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
