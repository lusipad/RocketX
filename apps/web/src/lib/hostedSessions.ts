import { useEffect, useMemo, useState } from 'react';
import {
  agentSessionCardLeaseIsActive,
  agentSessionCardSupersedesLocal,
  type AgentSessionCard,
} from '../agent/card';
import { agentBackend, type AgentSession, type AgentSessionStatus } from '../agent/session';

export const HOSTED_SESSION_STATUS_LABEL: Record<AgentSessionStatus, string> = {
  starting: '正在启动',
  ready: '待命',
  running: '正在工作',
  'waiting-approval': '等待审批',
  interrupted: '已中断',
  ended: '已结束',
};

export interface HostedSessionItem {
  key: string;
  rid: string;
  roomNameSnapshot?: string;
  backend: 'codex' | 'deepseek';
  status: AgentSessionStatus;
  project: string;
  projectPath?: string;
  task: string;
  updatedAt: number;
  local?: AgentSession;
  remote?: AgentSessionCard;
}

function projectName(session: AgentSession): string {
  if (session.environmentName?.trim()) return session.environmentName.trim();
  const root = session.workspaceRoots[0];
  return root?.split(/[\\/]/).filter(Boolean).at(-1) || '未指定项目';
}

function taskLabel(session: AgentSession): string {
  if (session.currentTaskLabel?.trim()) return session.currentTaskLabel.trim();
  if (session.workItem) return `#${session.workItem.id} ${session.workItem.title}`;
  if (session.status === 'running' || session.status === 'waiting-approval') return '正在处理房间任务';
  if (session.status === 'interrupted') return '等待恢复';
  if (session.status === 'ended') return '托管已结束';
  return '等待房间指令';
}

function localItem(session: AgentSession): HostedSessionItem {
  return {
    key: session.tmid,
    rid: session.rid,
    roomNameSnapshot: session.roomNameSnapshot,
    backend: agentBackend(session),
    status: session.status,
    project: projectName(session),
    projectPath: session.workspaceRoots[0],
    task: taskLabel(session),
    updatedAt: session.updatedAt,
    local: session,
  };
}

function remoteItem(card: AgentSessionCard, now: number): HostedSessionItem {
  const status = card.status === 'ended'
    ? 'ended'
    : card.status === 'interrupted' || !agentSessionCardLeaseIsActive(card, now)
      ? 'interrupted'
      : 'running';
  return {
    key: card.tmid,
    rid: card.rid || (card.tmid.startsWith('room:') ? card.tmid.slice('room:'.length) : ''),
    roomNameSnapshot: card.roomNameSnapshot,
    backend: card.backend === 'deepseek' ? 'deepseek' : 'codex',
    status,
    project: card.environmentName || '未指定项目',
    task: card.currentTaskLabel
      || (card.workItem ? `#${card.workItem.id} ${card.workItem.title}` : status === 'interrupted' ? '等待宿主恢复' : '等待房间指令'),
    updatedAt: card.leaseExpiresAt,
    remote: card,
  };
}

export function hostedSessionItems(
  sessions: Readonly<Record<string, AgentSession>>,
  remoteCards: Readonly<Record<string, AgentSessionCard>>,
  now = Date.now(),
): HostedSessionItem[] {
  const keys = new Set([...Object.keys(sessions), ...Object.keys(remoteCards)]);
  return [...keys]
    .map((key) => {
      const local = sessions[key];
      const remote = remoteCards[key];
      if (agentSessionCardSupersedesLocal(local, remote, now)) return remoteItem(remote, now);
      if (local) return localItem(local);
      return remote ? remoteItem(remote, now) : null;
    })
    .filter((item): item is HostedSessionItem => !!item)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function useHostedSessionItems(
  sessions: Readonly<Record<string, AgentSession>>,
  remoteCards: Readonly<Record<string, AgentSessionCard>>,
): HostedSessionItem[] {
  const [leaseGeneration, setLeaseGeneration] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const expiries = Object.entries(remoteCards).flatMap(([key, card]) => {
      if (card.status === 'ended' || card.leaseExpiresAt <= now) return [];
      const local = sessions[key];
      const localExpiry = local
        && local.status !== 'ended'
        && local.status !== 'interrupted'
        && local.host.expiresAt > now
        ? [local.host.expiresAt]
        : [];
      return [card.leaseExpiresAt, ...localExpiry];
    });
    const nextExpiry = expiries.length > 0 ? Math.min(...expiries) : undefined;
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setLeaseGeneration((current) => current + 1),
      Math.max(1, nextExpiry - now + 25),
    );
    return () => window.clearTimeout(timer);
  }, [leaseGeneration, remoteCards, sessions]);

  return useMemo(
    () => hostedSessionItems(sessions, remoteCards),
    [leaseGeneration, remoteCards, sessions],
  );
}
