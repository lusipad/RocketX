import type { NativeWorkCard, NativeWorkSessionRecord } from '../platform/desktopCommands';
import type { AcpManagedSessionState } from '../stores/acpAgents';

export function workContextPathKey(path: string): string {
  const slashes = path.trim().replace(/\\/g, '/');
  if (/^\/+$/u.test(slashes)) return '/';
  if (/^[a-z]:\/+$/iu.test(slashes)) return `${slashes.slice(0, 2).toLowerCase()}/`;
  const normalized = slashes.replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

export function resolvePortalWorkContext(input: {
  cards: NativeWorkCard[];
  sessions: NativeWorkSessionRecord[];
  acpSessions: AcpManagedSessionState[];
  activeThreadId?: string | null;
  activeWorkspaceRoot?: string;
  currentRuntime: 'pi' | 'codex';
  selectedCardId: string | null;
}) {
  const candidates = input.activeThreadId ? input.sessions.filter((session) => (
    session.runtime === input.currentRuntime
    && session.nativeSessionId === input.activeThreadId
    && (!input.activeWorkspaceRoot || workContextPathKey(session.workspaceRoot) === workContextPathKey(input.activeWorkspaceRoot))
  )) : [];
  // 同一来源有冲突关联时保持空态，不依据数组顺序挑选其他工作。
  const currentCardIds = new Set(candidates.map((session) => session.todoId));
  const currentCardId = currentCardIds.size === 1 ? candidates[0]?.todoId ?? null : null;
  const cardId = input.selectedCardId ?? currentCardId;
  const card = input.cards.find((item) => item.id === cardId) ?? null;
  const acpSession = card
    ? input.acpSessions.filter((item) => item.linkedTodoId === card.id)
      .sort((a, b) => b.createdAt - a.createdAt || a.sessionKey.localeCompare(b.sessionKey))[0] ?? null
    : null;
  const showsCurrentConversation = !input.selectedCardId
    || (card !== null && card.id === currentCardId);
  return { card, acpSession, showsCurrentConversation };
}
