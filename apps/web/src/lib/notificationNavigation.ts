export const NOTIFICATION_OPEN_ROOM_EVENT = 'notification-open-room';

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function notificationTarget(payload: unknown): { rid: string; mid: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const { rid, mid } = payload as { rid?: unknown; mid?: unknown };
  return validId(rid) && validId(mid) ? { rid, mid } : null;
}
