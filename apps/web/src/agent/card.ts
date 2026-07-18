export interface AgentSessionCard {
  version: 1;
  sessionId: string;
  tmid: string;
  hostUserId: string;
  hostUsername: string;
  hostDeviceId: string;
  leaseExpiresAt: number;
  status: 'active' | 'interrupted' | 'ended';
  environmentName?: string;
  workItem?: { id: number; project?: string; title: string };
  proposedBranch?: string;
}

export function agentSessionCardMatchesMessage(
  card: AgentSessionCard,
  message: { rid: string; tmid?: string },
): boolean {
  return card.tmid === (message.tmid ?? `room:${message.rid}`);
}

const MARKER = /<!--rocketx-agent:([^>]+)-->/;

export function stripAgentSessionMarker(text: string): string {
  return text.replace(MARKER, '').trimEnd();
}

export function renderAgentSessionCard(card: AgentSessionCard): string {
  const encoded = encodeURIComponent(JSON.stringify(card));
  const status = card.status === 'active' ? '运行中' : card.status === 'interrupted' ? '已中断' : '已结束';
  return [
    card.workItem
      ? `🤖 **AI 工作项会话：#${card.workItem.id} ${card.workItem.title}**`
      : '🤖 **AI 托管已开启**',
    card.workItem?.project ? `ADO：${card.workItem.project}` : '',
    card.environmentName ? `本地项目：${card.environmentName}` : '',
    card.proposedBranch ? `计划分支：\`${card.proposedBranch}\`` : '',
    `主持人：@${card.hostUsername} · 状态：${status}`,
    card.status === 'active' ? '房间成员：使用 `@ai` 提问；默认只读，代码修改仍由主持人的本机审批。' : '',
    `宿主租约至：${new Date(card.leaseExpiresAt).toLocaleString()}`,
    `<!--rocketx-agent:${encoded}-->`,
  ].filter(Boolean).join('\n');
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
