export const NOTIFICATION_OPEN_ROOM_EVENT = 'notification-open-room';

export function notificationRoomId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || !('rid' in payload)) return null;
  const rid = (payload as { rid?: unknown }).rid;
  if (
    typeof rid !== 'string' ||
    rid.length === 0 ||
    rid.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(rid)
  ) {
    return null;
  }
  return rid;
}
