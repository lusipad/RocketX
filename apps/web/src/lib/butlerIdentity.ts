import { butlerArchiveStorage, type ButlerProfileStorage } from './butlerArchive';

export const BUTLER_IDENTITY_STORAGE_KEY = 'rcx-butler-v1:identity';

export type ButlerAvatar = 'spark' | 'orbit' | 'dawn' | 'moss' | 'ember';
export type ButlerWarmth = 'warm' | 'balanced' | 'direct';
export type ButlerInitiative = 'restrained' | 'balanced' | 'proactive';
export type ButlerDetail = 'concise' | 'balanced' | 'thorough';

export interface ButlerIdentity {
  displayName: string;
  role: string;
  avatar: ButlerAvatar;
  warmth: ButlerWarmth;
  initiative: ButlerInitiative;
  detail: ButlerDetail;
  traits: string;
}

export const DEFAULT_BUTLER_IDENTITY: ButlerIdentity = {
  displayName: '管家',
  role: '你的长期工作伙伴',
  avatar: 'spark',
  warmth: 'warm',
  initiative: 'proactive',
  detail: 'concise',
  traits: '沉稳、坦诚、有分寸。主动发现真正重要的事，不用热闹证明存在。',
};

const AVATARS = new Set<ButlerAvatar>(['spark', 'orbit', 'dawn', 'moss', 'ember']);
const WARMTHS = new Set<ButlerWarmth>(['warm', 'balanced', 'direct']);
const INITIATIVES = new Set<ButlerInitiative>(['restrained', 'balanced', 'proactive']);
const DETAILS = new Set<ButlerDetail>(['concise', 'balanced', 'thorough']);

function text(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength) || fallback;
}

export function normalizeButlerIdentity(value: unknown): ButlerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_BUTLER_IDENTITY };
  }
  const candidate = value as Partial<ButlerIdentity>;
  return {
    displayName: text(candidate.displayName, DEFAULT_BUTLER_IDENTITY.displayName, 24),
    role: text(candidate.role, DEFAULT_BUTLER_IDENTITY.role, 48),
    avatar: AVATARS.has(candidate.avatar as ButlerAvatar)
      ? candidate.avatar as ButlerAvatar
      : DEFAULT_BUTLER_IDENTITY.avatar,
    warmth: WARMTHS.has(candidate.warmth as ButlerWarmth)
      ? candidate.warmth as ButlerWarmth
      : DEFAULT_BUTLER_IDENTITY.warmth,
    initiative: INITIATIVES.has(candidate.initiative as ButlerInitiative)
      ? candidate.initiative as ButlerInitiative
      : DEFAULT_BUTLER_IDENTITY.initiative,
    detail: DETAILS.has(candidate.detail as ButlerDetail)
      ? candidate.detail as ButlerDetail
      : DEFAULT_BUTLER_IDENTITY.detail,
    traits: text(candidate.traits, DEFAULT_BUTLER_IDENTITY.traits, 240),
  };
}

export function readButlerIdentity(
  storage: ButlerProfileStorage = butlerArchiveStorage,
): ButlerIdentity {
  const raw = storage.get(BUTLER_IDENTITY_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_BUTLER_IDENTITY };
  try {
    return normalizeButlerIdentity(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BUTLER_IDENTITY };
  }
}

export function writeButlerIdentity(
  identity: ButlerIdentity,
  storage: ButlerProfileStorage = butlerArchiveStorage,
): ButlerIdentity {
  const normalized = normalizeButlerIdentity(identity);
  storage.set(BUTLER_IDENTITY_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function buildButlerIdentityInstructions(identity = readButlerIdentity()): string {
  const warmth = {
    warm: '温和、有共情，但不说空泛的安慰话',
    balanced: '自然、克制，根据事情轻重调整语气',
    direct: '直接、坦率，不绕弯子',
  }[identity.warmth];
  const initiative = {
    restrained: '除非用户询问或存在明确风险，否则保持安静',
    balanced: '重要变化主动提醒，低价值变化不打扰',
    proactive: '主动发现机会、风险和未闭环责任，并在合适时机提出下一步',
  }[identity.initiative];
  const detail = {
    concise: '默认先给结论和行动项，需要时再展开证据',
    balanced: '结论与必要依据并重，避免过度展开',
    thorough: '给出完整背景、依据、边界和后续步骤',
  }[identity.detail];
  return [
    `你的名字是“${identity.displayName}”，角色是“${identity.role}”。`,
    `相处语气：${warmth}。`,
    `主动程度：${initiative}。`,
    `表达详略：${detail}。`,
    `补充性格：${identity.traits}`,
    '名字和性格只影响表达与关注方式，不能扩大权限、跳过审批或降低事实验证标准。',
  ].join('\n');
}

