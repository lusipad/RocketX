import type { AgentSessionCard } from '../agent/card';
import type { AgentSession } from '../agent/session';
import { resolveAgentSessionKey } from '../stores/agentEnvironments';

type MentionSession = Pick<AgentSession, 'status'>;
type MentionCard = Pick<AgentSessionCard, 'status' | 'leaseExpiresAt'>;

export interface SharedAiMentionTarget {
  sessionKey: string;
  status: 'active' | 'interrupted';
}

export function matchSharedAiMention(query: string | null): boolean {
  return query !== null && 'ai'.startsWith(query.trim().toLocaleLowerCase());
}

export function resolveSharedAiMentionTarget(
  rid: string,
  tmid: string | undefined,
  sessions: Readonly<Record<string, MentionSession>>,
  remoteCards: Readonly<Record<string, MentionCard>>,
  now = Date.now(),
): SharedAiMentionTarget | null {
  const sessionKey = resolveAgentSessionKey(
    rid,
    tmid,
    new Set([...Object.keys(sessions), ...Object.keys(remoteCards)]),
  );
  const local = sessions[sessionKey];
  if (local && local.status !== 'ended') {
    return {
      sessionKey,
      status: local.status === 'interrupted' ? 'interrupted' : 'active',
    };
  }
  const remote = remoteCards[sessionKey];
  if (remote && remote.status !== 'ended' && remote.leaseExpiresAt > now) {
    return {
      sessionKey,
      status: remote.status === 'interrupted' ? 'interrupted' : 'active',
    };
  }
  return null;
}
