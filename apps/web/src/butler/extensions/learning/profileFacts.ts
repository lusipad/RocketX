import {
  createButlerLearningId,
  normalizeButlerLearningText,
  type ProfileFact,
  type ProfileFactKind,
  type ProfileFactOrigin,
  type ProfileFactStatus,
} from './model';

export interface ParsedProfileDocument {
  candidates: ProfileFact[];
  rejectedLines: string[];
}

const FACT_KIND_LABELS: Record<ProfileFactKind, string> = {
  identity: '身份',
  preference: '偏好',
  'work-context': '工作背景',
  'working-style': '工作方式',
  boundary: '边界',
};
const FACT_LABEL_KINDS = new Map(
  Object.entries(FACT_KIND_LABELS).map(([kind, label]) => [label, kind as ProfileFactKind]),
);
const RESERVED_PROFILE_PATTERN =
  /(password|passwd|token|secret|api[-_ ]?key|credential|system prompt|权限|授权|密钥|密码|令牌|凭据)/i;
const PROFILE_LINE_PATTERN =
  /^-\s+\*\*([^·*]+?)\s*·\s*([^*]+?)\*\*[：:]\s*(.*?)\s*(?:<!--\s*profile:([a-zA-Z0-9-]+)\s*-->)?\s*$/;

export function createProfileFact(input: {
  kind: ProfileFactKind;
  subject: string;
  value: string;
  origin: ProfileFactOrigin;
  confirmed?: boolean;
  replacesId?: string;
  now?: number;
}): ProfileFact {
  const now = input.now ?? Date.now();
  const subject = normalizeButlerLearningText(input.subject, 80);
  const value = normalizeButlerLearningText(input.value);
  if (!subject || !value) throw new Error('资料名称和内容不能为空');
  if (RESERVED_PROFILE_PATTERN.test(`${subject} ${value}`)) {
    throw new Error('Profile 不保存密码、令牌、密钥、权限或系统指令');
  }
  return {
    id: createButlerLearningId('profile'),
    kind: input.kind,
    subject,
    value,
    status: input.confirmed ? 'confirmed' : 'candidate',
    origin: input.origin,
    createdAt: now,
    updatedAt: now,
    ...(input.replacesId ? { replacesId: input.replacesId } : {}),
  };
}

export function confirmProfileFact(
  facts: readonly ProfileFact[],
  id: string,
  now = Date.now(),
): ProfileFact[] {
  const candidate = facts.find((fact) => fact.id === id);
  if (!candidate) return [...facts];
  return facts.map((fact) => {
    const superseded = fact.status === 'confirmed'
      && fact.id !== candidate.id
      && (
        fact.id === candidate.replacesId
        || (fact.kind === candidate.kind && fact.subject === candidate.subject)
      );
    if (superseded) {
      return { ...fact, status: 'revoked', updatedAt: now };
    }
    return fact.id === id ? { ...fact, status: 'confirmed', updatedAt: now } : fact;
  });
}

export function setProfileFactStatus(
  facts: readonly ProfileFact[],
  id: string,
  status: ProfileFactStatus,
  now = Date.now(),
): ProfileFact[] {
  return facts.map((fact) => fact.id === id ? { ...fact, status, updatedAt: now } : fact);
}

function renderProfileSection(title: string, facts: readonly ProfileFact[]): string[] {
  return [
    `## ${title}`,
    '',
    ...(facts.length
      ? facts.map((fact) =>
        `- **${FACT_KIND_LABELS[fact.kind]} · ${fact.subject}**：${fact.value} <!-- profile:${fact.id} -->`)
      : ['_暂无_']),
    '',
  ];
}

export function renderButlerProfileMarkdown(facts: readonly ProfileFact[]): string {
  const ordered = [...facts].sort((a, b) => a.createdAt - b.createdAt);
  return [
    '# Profile',
    '',
    '> 这是 Butler 对你的可见理解。明示内容可直接确认；观察和外部编辑只会进入待确认区。',
    '> 不要在这里保存密码、令牌、密钥、权限指令或其他敏感信息。',
    '',
    ...renderProfileSection('已确认', ordered.filter((fact) => fact.status === 'confirmed')),
    ...renderProfileSection('待确认', ordered.filter((fact) => fact.status === 'candidate')),
    ...renderProfileSection('已撤销', ordered.filter((fact) => fact.status === 'revoked')),
  ].join('\n').trimEnd() + '\n';
}

export function parseExternalButlerProfileMarkdown(
  markdown: string,
  existingFacts: readonly ProfileFact[],
  now = Date.now(),
): ParsedProfileDocument {
  const existingById = new Map(existingFacts.map((fact) => [fact.id, fact]));
  const candidates: ProfileFact[] = [];
  const rejectedLines: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('- ') || line === '- _暂无_') continue;
    const match = PROFILE_LINE_PATTERN.exec(line);
    if (!match) {
      rejectedLines.push(line);
      continue;
    }
    const [, label, rawSubject, rawValue, id] = match;
    const kind = FACT_LABEL_KINDS.get(label.trim());
    const subject = normalizeButlerLearningText(rawSubject, 80);
    const value = normalizeButlerLearningText(rawValue);
    if (!kind || !subject || !value || RESERVED_PROFILE_PATTERN.test(`${subject} ${value}`)) {
      rejectedLines.push(line);
      continue;
    }
    const existing = id ? existingById.get(id) : undefined;
    if (existing && existing.kind === kind && existing.subject === subject && existing.value === value) {
      continue;
    }
    try {
      candidates.push(createProfileFact({
        kind,
        subject,
        value,
        origin: 'external-edit',
        replacesId: existing?.id,
        now,
      }));
    } catch {
      rejectedLines.push(line);
    }
  }
  return { candidates, rejectedLines };
}
