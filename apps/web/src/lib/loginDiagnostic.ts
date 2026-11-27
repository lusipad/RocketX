import { t } from '../i18n';
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
  if (kind === 'invalid_address') return t('auth.diagnostic.summary.invalidAddress');
  if (kind === 'credentials') return t('auth.diagnostic.summary.credentials');
  if (kind === 'session_expired') return t('auth.diagnostic.summary.sessionExpired');
  if (kind === 'not_rocket_chat') return t('auth.diagnostic.summary.notRocketChat');
  if (kind === 'tls') {
    return t(stage === 'probe' ? 'auth.diagnostic.summary.tlsProbe' : 'auth.diagnostic.summary.tlsLogin');
  }
  if (kind === 'dns') {
    return t(stage === 'probe' ? 'auth.diagnostic.summary.dnsProbe' : 'auth.diagnostic.summary.dnsLogin');
  }
  if (kind === 'proxy') {
    return t(stage === 'probe' ? 'auth.diagnostic.summary.proxyProbe' : 'auth.diagnostic.summary.proxyLogin');
  }
  if (kind === 'timeout') {
    return t(stage === 'probe' ? 'auth.diagnostic.summary.timeoutProbe' : 'auth.diagnostic.summary.timeoutLogin');
  }
  if (kind === 'scope') {
    return t(stage === 'probe' ? 'auth.diagnostic.summary.scopeProbe' : 'auth.diagnostic.summary.scopeLogin');
  }
  if (kind === 'http_status') {
    return t(stage === 'probe' ? 'auth.diagnostic.summary.httpStatusProbe' : 'auth.diagnostic.summary.httpStatusLogin');
  }
  if (kind === 'unreachable') {
    return t(stage === 'probe' ? 'auth.diagnostic.summary.unreachableProbe' : 'auth.diagnostic.summary.unreachableLogin');
  }
  return t(stage === 'probe' ? 'auth.diagnostic.summary.unknownProbe' : 'auth.diagnostic.summary.unknownLogin');
}

function detailLabel(kind: LoginFailureKind, raw: string): string | null {
  if (!raw) return null;
  if (kind === 'invalid_address' || kind === 'credentials' || kind === 'session_expired' || kind === 'not_rocket_chat') {
    return null;
  }
  if (kind === 'dns') return t('auth.diagnostic.detail.dns', { raw });
  if (kind === 'tls') return t('auth.diagnostic.detail.tls', { raw });
  if (kind === 'proxy') return t('auth.diagnostic.detail.proxy', { raw });
  if (kind === 'timeout') return t('auth.diagnostic.detail.timeout', { raw });
  if (kind === 'scope') return t('auth.diagnostic.detail.scope', { raw });
  if (kind === 'http_status') {
    const status = extractHttpStatus(raw);
    return status
      ? t('auth.diagnostic.detail.httpStatusWithCode', { status, raw })
      : t('auth.diagnostic.detail.httpStatusUnknown', { raw });
  }
  if (kind === 'unreachable') {
    if (/^(?:unreachable|unreadable)$/i.test(raw)) {
      return t('auth.diagnostic.detail.unreachableEmpty');
    }
    return t('auth.diagnostic.detail.unreachableRaw', { raw });
  }
  return t('auth.diagnostic.detail.unknown', { raw });
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
