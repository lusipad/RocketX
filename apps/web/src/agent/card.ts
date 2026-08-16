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
  const localClaim = `${local.host.deviceId}\u0000${local.sessionId}`;
  const remoteClaim = `${remote.hostDeviceId}\u0000${remote.sessionId}`;
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

function encodeInvisibleMarker(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return Array.from(bytes, (byte) =>
    String.fromCodePoint(byte < 16 ? 0xfe00 + byte : 0xe0100 + byte - 16),
  ).join('');
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

export function stripAgentSessionMarker(text: string): string {
  return text.replace(INVISIBLE_MARKER, '').replace(LEGACY_MARKER, '').trimEnd();
}

export function renderAgentSessionCard(card: AgentSessionCard): string {
  const status = card.status === 'active' ? '运行中' : card.status === 'interrupted' ? '已中断' : '已结束';
  const visible = [
    card.workItem
      ? `🤖 **AI 工作项会话：#${card.workItem.id} ${card.workItem.title}**`
      : '🤖 **AI 托管已开启**',
    card.workItem?.project ? `ADO：${card.workItem.project}` : '',
    card.environmentName ? `本地项目：${card.environmentName}` : '',
    card.proposedBranch ? `计划分支：\`${card.proposedBranch}\`` : '',
    `主持人：@${card.hostUsername} · 状态：${status}`,
    card.status === 'active' ? '房间成员：使用 `@ai` 提问；权限与审批由主持人的 AI 管家会话控制。' : '',
    `宿主租约至：${new Date(card.leaseExpiresAt).toLocaleString()}`,
  ].filter(Boolean).join('\n');
  return `${visible}\u2063\u2063${encodeInvisibleMarker(JSON.stringify(card))}\u2063`;
}

export function parseAgentSessionCard(text: string): AgentSessionCard | null {
  const invisible = INVISIBLE_MARKER.exec(text)?.[1];
  const legacy = LEGACY_MARKER.exec(text)?.[1];
  if (!invisible && !legacy) return null;
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
      return null;
    }
    return value as AgentSessionCard;
  } catch {
    return null;
  }
}
