const SENSITIVE_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  'credentials',
  'secrets',
]);

const SENSITIVE_FILES = [
  /^\.env(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^(?:credentials|secrets?)\.(?:json|ya?ml|toml|ini)$/i,
  /^config\.json$/i,
];

function normalizedPath(value: string): string {
  const replaced = value.trim().replaceAll('\\', '/');
  const drive = /^[a-z]:\//i.exec(replaced)?.[0].toLowerCase() ?? '';
  const absolute = drive || replaced.startsWith('/');
  if (!absolute) throw new Error('工作区路径必须是绝对路径');
  const prefix = drive || '/';
  const source = drive ? replaced.slice(drive.length) : replaced.slice(1);
  const parts: string[] = [];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new Error('工作区路径越过根目录');
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `${prefix}${parts.join('/')}`.replace(/\/$/, '').toLowerCase();
}

export function pathIsSensitive(path: string): boolean {
  const normalized = normalizedPath(path);
  const parts = normalized.split('/').filter(Boolean);
  return parts.some((part, index) => {
    if (SENSITIVE_SEGMENTS.has(part)) return true;
    return index === parts.length - 1 && SENSITIVE_FILES.some((pattern) => pattern.test(part));
  });
}

export function assertAllowedWorkspacePath(path: string, roots: readonly string[]): void {
  const target = normalizedPath(path);
  if (pathIsSensitive(target)) throw new Error('Agent 不允许访问敏感路径');
  const allowed = roots.some((root) => {
    const normalizedRoot = normalizedPath(root);
    return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`);
  });
  if (!allowed) throw new Error('Agent 只能访问会话工作区白名单');
}

export function commandMentionsSensitivePath(command: string): boolean {
  return /(?:^|[\s"'`\\/])(?:\.env(?:\.[\w.-]+)?|\.ssh|\.aws|\.azure|\.gnupg|\.kube|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|[\s"'`\\/])/i.test(
    command,
  );
}

export function commandRequestMentionsSensitivePath(command: unknown): boolean {
  if (typeof command === 'string') return commandMentionsSensitivePath(command);
  return Array.isArray(command)
    ? command.some((part) => typeof part === 'string' && commandMentionsSensitivePath(part))
    : false;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-z0-9_-]{16,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[a-z0-9]{20,}\b/gi,
  /\bgithub_pat_[a-z0-9_]{20,}\b/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bBearer\s+[a-z0-9._~+/-]{16,}=*\b/gi,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi,
];

export function redactAgentOutput(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let value = text;
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, () => {
      redacted += 1;
      return '[已脱敏]';
    });
  }
  value = value.replace(
    /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*([^\s,;]{8,})/gi,
    (_match, label: string) => {
      redacted += 1;
      return `${label}=[已脱敏]`;
    },
  );
  return { text: value, redacted };
}
