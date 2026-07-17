export interface AgentSessionCard {
  version: 1;
  sessionId: string;
  tmid: string;
  hostUserId: string;
  hostUsername: string;
  hostDeviceId: string;
  leaseExpiresAt: number;
  status: 'active' | 'interrupted' | 'ended';
}

const MARKER = /<!--rocketx-agent:([^>]+)-->/;

export function renderAgentSessionCard(card: AgentSessionCard): string {
  const encoded = encodeURIComponent(JSON.stringify(card));
  const status = card.status === 'active' ? '运行中' : card.status === 'interrupted' ? '已中断' : '已结束';
  return [
    '🤖 **Codex 共享会话**',
    `主持人：@${card.hostUsername} · 状态：${status}`,
    `宿主租约至：${new Date(card.leaseExpiresAt).toLocaleString()}`,
    `<!--rocketx-agent:${encoded}-->`,
  ].join('\n');
}

export function parseAgentSessionCard(text: string): AgentSessionCard | null {
  const encoded = MARKER.exec(text)?.[1];
  if (!encoded) return null;
  try {
    const value = JSON.parse(decodeURIComponent(encoded)) as Partial<AgentSessionCard>;
    if (
      value.version !== 1 ||
      typeof value.sessionId !== 'string' ||
      typeof value.tmid !== 'string' ||
      typeof value.hostUserId !== 'string' ||
      typeof value.hostUsername !== 'string' ||
      typeof value.hostDeviceId !== 'string' ||
      typeof value.leaseExpiresAt !== 'number' ||
      !['active', 'interrupted', 'ended'].includes(value.status ?? '')
    ) {
      return null;
    }
    return value as AgentSessionCard;
  } catch {
    return null;
  }
}
