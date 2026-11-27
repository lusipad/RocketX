import { useEffect, useMemo, useState } from 'react';
import { t, useLocale, type ResolvedLocale } from '../i18n';
import {
  agentSessionCardLeaseIsActive,
  agentSessionCardSupersedesLocal,
  type AgentSessionCard,
} from '../agent/card';
import { agentBackend, type AgentSession, type AgentSessionStatus } from '../agent/session';

export const HOSTED_SESSION_STATUS_LABEL: Record<AgentSessionStatus, string> = {
  get starting() { return t('agent.hosted.status.starting'); },
  get ready() { return t('agent.hosted.status.ready'); },
  get running() { return t('agent.hosted.status.running'); },
  get 'waiting-approval'() { return t('agent.hosted.status.waitingApproval'); },
  get interrupted() { return t('agent.hosted.status.interrupted'); },
  get ended() { return t('agent.hosted.status.ended'); },
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

function projectName(session: AgentSession, locale?: ResolvedLocale): string {
  if (session.environmentName?.trim()) return session.environmentName.trim();
  const root = session.workspaceRoots[0];
  return root?.split(/[\\/]/).filter(Boolean).at(-1) || t('agent.hosted.noProject', undefined, locale);
}

function taskLabel(session: AgentSession, locale?: ResolvedLocale): string {
  if (session.currentTaskLabel?.trim()) return session.currentTaskLabel.trim();
  if (session.workItem) return `#${session.workItem.id} ${session.workItem.title}`;
  if (session.status === 'running' || session.status === 'waiting-approval') return t('agent.hosted.workingOnRoom', undefined, locale);
  if (session.status === 'interrupted') return t('agent.hosted.waitingRecovery', undefined, locale);
  if (session.status === 'ended') return t('agent.hosted.sessionEnded', undefined, locale);
  return t('agent.hosted.waitingCommand', undefined, locale);
}

function localItem(session: AgentSession, locale?: ResolvedLocale): HostedSessionItem {
  return {
    key: session.tmid,
    rid: session.rid,
    roomNameSnapshot: session.roomNameSnapshot,
    backend: agentBackend(session),
    status: session.status,
    project: projectName(session, locale),
    projectPath: session.workspaceRoots[0],
    task: taskLabel(session, locale),
    updatedAt: session.updatedAt,
    local: session,
  };
}

function remoteItem(card: AgentSessionCard, now: number, locale?: ResolvedLocale): HostedSessionItem {
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
    project: card.environmentName || t('agent.hosted.noProject', undefined, locale),
    task: card.currentTaskLabel
      || (card.workItem ? `#${card.workItem.id} ${card.workItem.title}` : status === 'interrupted' ? t('agent.hosted.waitingHostRecovery', undefined, locale) : t('agent.hosted.waitingCommand', undefined, locale)),
    updatedAt: card.leaseExpiresAt,
    remote: card,
  };
}

export function hostedSessionItems(
  sessions: Readonly<Record<string, AgentSession>>,
  remoteCards: Readonly<Record<string, AgentSessionCard>>,
  now = Date.now(),
  locale?: ResolvedLocale,
): HostedSessionItem[] {
  const keys = new Set([...Object.keys(sessions), ...Object.keys(remoteCards)]);
  return [...keys]
    .map((key) => {
      const local = sessions[key];
      const remote = remoteCards[key];
      if (agentSessionCardSupersedesLocal(local, remote, now)) return remoteItem(remote, now, locale);
      if (local) return localItem(local, locale);
      return remote ? remoteItem(remote, now, locale) : null;
    })
    .filter((item): item is HostedSessionItem => !!item)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function useHostedSessionItems(
  sessions: Readonly<Record<string, AgentSession>>,
  remoteCards: Readonly<Record<string, AgentSessionCard>>,
): HostedSessionItem[] {
  const locale = useLocale();
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
    () => hostedSessionItems(sessions, remoteCards, Date.now(), locale),
    [leaseGeneration, locale, remoteCards, sessions],
  );
}
