import { kernelStore } from '../kernel/store';
import type { AgentSession } from './session';

const APP_ID = 'builtin:shared-agent';

function sessionKey(serverId: string, userId: string, tmid: string): string {
  return `${encodeURIComponent(serverId)}:${encodeURIComponent(userId)}:${encodeURIComponent(tmid)}`;
}

export async function loadAgentSession(
  serverId: string,
  userId: string,
  tmid: string,
): Promise<AgentSession | undefined> {
  return kernelStore.appData.get<AgentSession>(APP_ID, sessionKey(serverId, userId, tmid));
}

export async function saveAgentSession(session: AgentSession, userId: string): Promise<void> {
  await kernelStore.appData.set(
    APP_ID,
    sessionKey(session.serverId, userId, session.tmid),
    session,
  );
}

export async function deleteAgentSession(
  serverId: string,
  userId: string,
  tmid: string,
): Promise<void> {
  await kernelStore.appData.delete(APP_ID, sessionKey(serverId, userId, tmid));
}

export async function listAgentSessions(serverId: string, userId: string): Promise<AgentSession[]> {
  const entries = await kernelStore.appData.list<AgentSession>(APP_ID);
  return entries
    .map((entry) => entry.value)
    .filter((session) => session.serverId === serverId && session.ownerUserId === userId);
}
