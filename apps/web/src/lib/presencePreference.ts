export const PRESENCE_STATUSES = ['online', 'away', 'busy', 'offline'] as const;

export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

const PRESENCE_PREFERENCE_VERSION = 1;

function storageKey(server: string, userId: string): string {
  const normalizedServer = server.trim().replace(/\/+$/, '').toLocaleLowerCase() || 'same-origin';
  return `rcx-presence-v${PRESENCE_PREFERENCE_VERSION}:${encodeURIComponent(normalizedServer)}:${encodeURIComponent(userId)}`;
}

export function isPresenceStatus(value: unknown): value is PresenceStatus {
  return PRESENCE_STATUSES.includes(value as PresenceStatus);
}

export function loadPresencePreference(server: string, userId: string): PresenceStatus | null {
  try {
    const value = localStorage.getItem(storageKey(server, userId));
    return isPresenceStatus(value) ? value : null;
  } catch {
    return null;
  }
}

export function savePresencePreference(
  server: string,
  userId: string,
  status: PresenceStatus,
): void {
  try {
    localStorage.setItem(storageKey(server, userId), status);
  } catch {
    // 无痕模式或存储不可用时，服务器状态仍然已经生效。
  }
}

/** 没有本机显式偏好时，应用每次打开都应恢复在线。 */
export function startupPresence(server: string, userId: string): PresenceStatus {
  return loadPresencePreference(server, userId) ?? 'online';
}
