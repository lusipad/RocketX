export const NOTIFICATION_OPEN_ROOM_EVENT = 'notification-open-room';

export interface NotificationNavigationTarget {
  id?: string;
  rid: string;
  mid: string;
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validNotificationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function notificationTargetKey(target: NotificationNavigationTarget): string {
  return target.id ?? `${target.rid}:${target.mid}`;
}

export function notificationTarget(payload: unknown): NotificationNavigationTarget | null {
  if (!payload || typeof payload !== 'object') return null;
  const { id, rid, mid } = payload as { id?: unknown; rid?: unknown; mid?: unknown };
  if (!validId(rid) || !validId(mid)) return null;
  if (id != null && !validNotificationId(id)) return null;
  return id ? { id, rid, mid } : { rid, mid };
}

export function notificationDestination(target: { rid: string }): 'butler-view' | 'messages' {
  return target.rid === 'butler' ? 'butler-view' : 'messages';
}

export function queueNotificationTarget(
  queue: readonly NotificationNavigationTarget[],
  target: NotificationNavigationTarget,
): NotificationNavigationTarget[] {
  const key = notificationTargetKey(target);
  return queue.some((entry) => notificationTargetKey(entry) === key)
    ? [...queue]
    : [...queue, target];
}

export function takeQueuedNotificationTarget(
  queue: readonly NotificationNavigationTarget[],
  authStatus: 'boot' | 'guest' | 'authing' | 'authed',
  chatReady: boolean,
): { queue: NotificationNavigationTarget[]; target: NotificationNavigationTarget | null } {
  const [next, ...rest] = queue;
  if (!next || authStatus !== 'authed') return { queue: [...queue], target: null };
  if (notificationDestination(next) === 'messages' && !chatReady) {
    return { queue: [...queue], target: null };
  }
  return { queue: rest, target: next };
}
