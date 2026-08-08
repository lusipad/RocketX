import type { AppDataStore } from '@rcx/rcx-store';
import type { AgentSession } from './session';

const APP_ID = 'builtin:shared-agent';

let sessionAppDataOverride: AppDataStore | undefined;

async function sessionAppData(): Promise<AppDataStore> {
  if (sessionAppDataOverride) return sessionAppDataOverride;
  const { kernelStore } = await import('../kernel/store');
  return kernelStore.appData;
}

export function setAgentSessionAppData(store: AppDataStore): () => void {
  const previous = sessionAppDataOverride;
  sessionAppDataOverride = store;
  return () => {
    sessionAppDataOverride = previous;
  };
}

function sessionKey(serverId: string, userId: string, tmid: string): string {
  return `${encodeURIComponent(serverId)}:${encodeURIComponent(userId)}:${encodeURIComponent(tmid)}`;
}

export async function loadAgentSession(
  serverId: string,
  userId: string,
  tmid: string,
): Promise<AgentSession | undefined> {
  return (await sessionAppData()).get<AgentSession>(APP_ID, sessionKey(serverId, userId, tmid));
}

export async function saveAgentSession(session: AgentSession, userId: string): Promise<void> {
  await (await sessionAppData()).set(
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
  await (await sessionAppData()).delete(APP_ID, sessionKey(serverId, userId, tmid));
}

export async function listAgentSessions(serverId: string, userId: string): Promise<AgentSession[]> {
  const entries = await (await sessionAppData()).list<AgentSession>(APP_ID);
  return entries
    .map((entry) => entry.value)
    .filter((session) => session.serverId === serverId && session.ownerUserId === userId);
}
