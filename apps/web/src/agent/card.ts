import { leaseIsActive, type AgentBackend, type AgentSession } from './session';

export interface AgentSessionCard {
  version: 1;
  sessionId: string;
  /** 消息 ingest 时也会补齐，供全局托管页打开对应房间。 */
  rid?: string;
  tmid: string;
  roomNameSnapshot?: string;
  hostUserId: string;
  hostUsername: string;
  hostDeviceId: string;
  leaseExpiresAt: number;
  status: 'active' | 'interrupted' | 'ended';
  /** 旧卡片没有该字段时按 Codex 读取。 */
  backend?: AgentBackend;
  environmentName?: string;
  workItem?: { id: number; project?: string; title: string };
  proposedBranch?: string;
  currentTaskLabel?: string;
  /** 从 Rocket.Chat 消息 ID 派生；旧卡片缺少时回退原有设备/session 声明。 */
  claimId?: string;
}

export function agentSessionCardLeaseIsActive(card: AgentSessionCard, now = Date.now()): boolean {
  return card.status !== 'ended' && card.leaseExpiresAt > now;
}

export function agentSessionCardSupersedesLocal(
  local: AgentSession | undefined,
  remote: AgentSessionCard | undefined,
  now = Date.now(),
): remote is AgentSessionCard {
  if (!remote || !agentSessionCardLeaseIsActive(remote, now)) return false;
  if (!local || local.status === 'ended' || !leaseIsActive(local, now)) return true;
  if (local.status === 'interrupted' && remote.status === 'active') return true;
  if (local.status !== 'interrupted' && remote.status === 'interrupted') return false;
  // 两端同时持有有效声明时必须得出同一个赢家，否则双方都会把自己视为宿主并双重回复。
  const localClaim = local.leaseMessageId ?? `${local.host.deviceId}\u0000${local.sessionId}`;
  const remoteClaim = remote.claimId ?? `${remote.hostDeviceId}\u0000${remote.sessionId}`;
  return remoteClaim.localeCompare(localClaim) < 0;
}

export function agentSessionCardMatchesMessage(
  card: AgentSessionCard,
  message: { rid: string; tmid?: string },
): boolean {
  return card.tmid === (message.tmid ?? `room:${message.rid}`);
}

const LEGACY_MARKER = /<!--rocketx-agent:([^>]+)-->/;
const INVISIBLE_MARKER = /\u2063\u2063([\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+)\u2063/u;
const WORK_ITEM_HEADER = /^🤖 \*\*AI 工作项会话：#(\d+) (.+)\*\*$/mu;
const HOSTING_HEADER = /^🤖 \*\*AI 托管已开启\*\*$/mu;
const LEASE_ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
const LEASE_ID_PREFIX = 'RXh';
const LEASE_ID_BODY_LENGTH = 12;
const LEASE_ID_TOTAL_LENGTH = 17;
const LEASE_CUSTOM_FIELD = 'rocketxAgentLeaseV1';

interface AgentSessionCardMessage {
  _id: string;
  rid: string;
  tmid?: string;
  u: { _id: string; username: string };
  customFields?: Record<string, unknown>;
}

interface AgentSessionLeaseMetadata {
  version: 1;
  kind: 'shared-agent-lease';
  sessionId: string;
  tmid: string;
  hostUserId: string;
  backend?: AgentBackend;
}

function lineValue(text: string, label: string): string | undefined {
  const line = text.split('\n').find((candidate) => candidate.startsWith(label));
  const value = line?.slice(label.length).trim();
  return value || undefined;
}

function singleLine(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  return normalized || undefined;
}

function decodeInvisibleMarker(value: string): string {
  const bytes = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) throw new Error('Invalid invisible Agent marker');
    if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return codePoint - 0xfe00;
    if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return codePoint - 0xe0100 + 16;
    throw new Error('Invalid invisible Agent marker');
  });
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
}

function leaseChecksum(body: string): string {
  let first = 0;
  let second = 0;
  for (let index = 0; index < body.length; index += 1) {
    const value = LEASE_ID_CHARS.indexOf(body[index]);
    if (value < 0) throw new Error('Invalid Agent lease id body');
    first = (first + value + index) % LEASE_ID_CHARS.length;
    second = (second + first + value) % LEASE_ID_CHARS.length;
  }
  return `${LEASE_ID_CHARS[first]}${LEASE_ID_CHARS[second]}`;
}

function randomLeaseIdBody(): string {
  let value = '';
  for (let index = 0; index < LEASE_ID_BODY_LENGTH; index += 1) {
    value += LEASE_ID_CHARS[Math.floor(Math.random() * LEASE_ID_CHARS.length)];
  }
  return value;
}

function parseLeaseMetadata(
  message: AgentSessionCardMessage | undefined,
): AgentSessionLeaseMetadata | null {
  const value = message?.customFields?.[LEASE_CUSTOM_FIELD];
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? JSON.stringify(value)
      : null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentSessionLeaseMetadata>;
    if (
      parsed.version !== 1 ||
      parsed.kind !== 'shared-agent-lease' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.tmid !== 'string' ||
      typeof parsed.hostUserId !== 'string' ||
      (parsed.backend !== undefined && !['codex', 'deepseek'].includes(parsed.backend))
    ) return null;
    return parsed as AgentSessionLeaseMetadata;
  } catch {
    return null;
  }
}

function leaseMetadataMatchesCard(
  metadata: AgentSessionLeaseMetadata,
  card: AgentSessionCard,
  message: AgentSessionCardMessage,
): boolean {
  return (
    metadata.sessionId === card.sessionId &&
    metadata.tmid === card.tmid &&
    metadata.hostUserId === message.u._id &&
    (metadata.backend === undefined || metadata.backend === (card.backend ?? 'codex'))
  );
}

function parseVisibleAgentSessionCard(
  text: string,
  message: AgentSessionCardMessage | undefined,
): AgentSessionCard | null {
  if (!message || (!HOSTING_HEADER.test(text) && !WORK_ITEM_HEADER.test(text))) return null;
  const host = text.match(/^主持人：@(.+?) · 状态：(运行中|已中断|已结束)$/mu);
  const backendText = lineValue(text, '执行引擎：');
  const environmentName = lineValue(text, '本地项目：');
  const currentTaskLabel = lineValue(text, '当前任务：');
  const leaseText = lineValue(text, '宿主租约至：');
  const leaseExpiresAt = leaseText ? Date.parse(leaseText) : Number.NaN;
  if (
    !host
    || !['Codex', 'DeepSeek'].includes(backendText ?? '')
    || !environmentName
    || !currentTaskLabel
    || !Number.isFinite(leaseExpiresAt)
  ) return null;
  const status = host[2] === '运行中' ? 'active' : host[2] === '已中断' ? 'interrupted' : 'ended';
  const backend = backendText === 'DeepSeek' ? 'deepseek' : 'codex';
  const metadata = parseLeaseMetadata(message);
  const tmid = message.tmid ?? `room:${message.rid}`;
  const sessionId = metadata
    && metadata.tmid === tmid
    && metadata.hostUserId === message.u._id
    && (metadata.backend === undefined || metadata.backend === backend)
    ? metadata.sessionId
    : message._id;
  const workItem = WORK_ITEM_HEADER.exec(text);
  const workItemId = workItem ? Number(workItem[1]) : undefined;
  const workItemTitle = singleLine(workItem?.[2]);
  const project = lineValue(text, 'ADO：');
  const proposedBranch = lineValue(text, '计划分支：')?.replace(/^`|`$/gu, '');
  return {
    version: 1,
    sessionId,
    claimId: message._id,
    rid: message.rid,
    tmid,
    hostUserId: message.u._id,
    hostUsername: message.u.username || host[1],
    hostDeviceId: message._id,
    leaseExpiresAt,
    status,
    backend,
    environmentName,
    ...(workItemId !== undefined && workItemTitle
      ? { workItem: { id: workItemId, ...(project ? { project } : {}), title: workItemTitle } }
      : {}),
    ...(proposedBranch ? { proposedBranch } : {}),
    currentTaskLabel,
  };
}

export function stripAgentSessionMarker(text: string): string {
  return text.replace(INVISIBLE_MARKER, '').replace(LEGACY_MARKER, '').trimEnd();
}

export function createAgentSessionLeaseMessageId(): string {
  const body = `${LEASE_ID_PREFIX}${randomLeaseIdBody()}`;
  return `${body}${leaseChecksum(body)}`;
}

export function isAgentSessionLeaseMessageId(value: string): boolean {
  if (value.length !== LEASE_ID_TOTAL_LENGTH || !value.startsWith(LEASE_ID_PREFIX)) return false;
  const body = value.slice(0, LEASE_ID_TOTAL_LENGTH - 2);
  return value === `${body}${leaseChecksum(body)}`;
}

export function agentSessionLeaseCustomFields(
  card: Pick<AgentSessionCard, 'sessionId' | 'tmid' | 'hostUserId' | 'backend'>,
): Record<string, string> {
  return {
    [LEASE_CUSTOM_FIELD]: JSON.stringify({
      version: 1,
      kind: 'shared-agent-lease',
      sessionId: card.sessionId,
      tmid: card.tmid,
      hostUserId: card.hostUserId,
      ...(card.backend ? { backend: card.backend } : {}),
    } satisfies AgentSessionLeaseMetadata),
  };
}

export function agentSessionCardAuthority(
  text: string,
  message: AgentSessionCardMessage | undefined,
  parsedCard?: AgentSessionCard | null,
): 'custom-fields' | 'lease-message-id' | 'legacy-marker' | 'visible' | 'none' {
  const card = parsedCard ?? parseAgentSessionCard(text, message);
  if (!card) return 'none';
  const metadata = parseLeaseMetadata(message);
  if (metadata && message && leaseMetadataMatchesCard(metadata, card, message)) return 'custom-fields';
  if (message && isAgentSessionLeaseMessageId(message._id)) return 'lease-message-id';
  if (LEGACY_MARKER.test(text) || INVISIBLE_MARKER.test(text)) return 'legacy-marker';
  return 'visible';
}

export function renderAgentSessionCard(card: AgentSessionCard): string {
  const status = card.status === 'active' ? '运行中' : card.status === 'interrupted' ? '已中断' : '已结束';
  const project = singleLine(card.environmentName) || singleLine(card.workItem?.project) || '未指定项目';
  const task = singleLine(card.currentTaskLabel)
    || (card.workItem ? `#${card.workItem.id} ${singleLine(card.workItem.title) || '未命名工作项'}` : undefined)
    || (card.status === 'interrupted' ? '等待恢复' : card.status === 'ended' ? '托管已结束' : '等待房间指令');
  return [
    card.workItem
      ? `🤖 **AI 工作项会话：#${card.workItem.id} ${singleLine(card.workItem.title) || '未命名工作项'}**`
      : '🤖 **AI 托管已开启**',
    card.workItem?.project ? `ADO：${singleLine(card.workItem.project)}` : '',
    `本地项目：${project}`,
    `当前任务：${task}`,
    card.proposedBranch ? `计划分支：\`${singleLine(card.proposedBranch)}\`` : '',
    `执行引擎：${card.backend === 'deepseek' ? 'DeepSeek' : 'Codex'}`,
    `主持人：@${card.hostUsername} · 状态：${status}`,
    card.status === 'active' ? '房间成员：使用 `@ai` 提问；权限与审批由主持人的 AI 管家会话控制。' : '',
    `宿主租约至：${new Date(card.leaseExpiresAt).toISOString()}`,
  ].filter(Boolean).join('\n');
}

export function parseAgentSessionCard(
  text: string,
  message?: AgentSessionCardMessage,
): AgentSessionCard | null {
  const invisible = INVISIBLE_MARKER.exec(text)?.[1];
  const legacy = LEGACY_MARKER.exec(text)?.[1];
  if (!invisible && !legacy) return parseVisibleAgentSessionCard(text, message);
  try {
    const json = invisible ? decodeInvisibleMarker(invisible) : decodeURIComponent(legacy!);
    const value = JSON.parse(json) as Partial<AgentSessionCard>;
    if (
      value.version !== 1 ||
      typeof value.sessionId !== 'string' ||
      (value.rid !== undefined && typeof value.rid !== 'string') ||
      typeof value.tmid !== 'string' ||
      (value.roomNameSnapshot !== undefined && typeof value.roomNameSnapshot !== 'string') ||
      typeof value.hostUserId !== 'string' ||
      typeof value.hostUsername !== 'string' ||
      typeof value.hostDeviceId !== 'string' ||
      typeof value.leaseExpiresAt !== 'number' ||
      !['active', 'interrupted', 'ended'].includes(value.status ?? '') ||
      (value.backend !== undefined && !['codex', 'deepseek'].includes(value.backend)) ||
      (value.currentTaskLabel !== undefined && typeof value.currentTaskLabel !== 'string')
    ) {
      return parseVisibleAgentSessionCard(text, message);
    }
    return value as AgentSessionCard;
  } catch {
    return parseVisibleAgentSessionCard(text, message);
  }
}
