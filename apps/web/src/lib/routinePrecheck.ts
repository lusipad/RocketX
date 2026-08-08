import { tsMs, type RcMessage } from '@rcx/rc-client';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import type { Routine } from '../stores/routines';

function lastRunAt(routine: Routine): number {
  return routine.runs
    .filter((run) => run.status === 'ok')
    .reduce((latest, run) => Math.max(latest, run.at), 0);
}

function directlyMentionsMe(message: RcMessage): boolean {
  const me = useAuth.getState().user;
  if (!me) return false;
  return !!message.mentions?.some((mention) =>
    mention.type !== 'team' &&
    (mention._id === me._id ||
      mention.username.toLocaleLowerCase() === me.username.toLocaleLowerCase()));
}

function hasNewMentions(routine: Routine): boolean {
  const chat = useChat.getState();
  const mentionedRoomIds = Object.values(chat.subscriptions)
    .filter((subscription) => (subscription.userMentions ?? 0) > 0)
    .map((subscription) => subscription.rid);
  if (mentionedRoomIds.length === 0) return false;

  const since = lastRunAt(routine);
  if (since === 0) return true;
  for (const rid of mentionedRoomIds) {
    if ((chat.messages[rid] ?? []).some((message) =>
      tsMs(message.ts) > since && directlyMentionsMe(message))) {
      return true;
    }
  }

  const hasNewRoomActivity = mentionedRoomIds.some((rid) => {
    const room = chat.rooms[rid];
    const latestCachedMessage = (chat.messages[rid] ?? [])
      .reduce((latest, message) => Math.max(latest, tsMs(message.ts)), 0);
    return Math.max(tsMs(room?.lm), tsMs(room?.lastMessage?.ts), latestCachedMessage) > since;
  });
  if (!hasNewRoomActivity) return false;

  // userMentions 没有时间戳，新房间活动的缓存又可能不完整；此时放行比漏掉真实的新 @ 更稳妥。
  return true;
}

function roomMatches(
  roomRef: string,
  rid: string,
  subscription: ReturnType<typeof useChat.getState>['subscriptions'][string] | undefined,
  room: ReturnType<typeof useChat.getState>['rooms'][string] | undefined,
): boolean {
  const normalized = roomRef.trim().toLocaleLowerCase();
  return [rid, subscription?.name, subscription?.fname, room?.name, room?.fname]
    .some((candidate) => candidate?.toLocaleLowerCase() === normalized);
}

function hasRoomActivity(routine: Routine): boolean {
  const selectedRooms = routine.params?.rooms ?? [];
  if (selectedRooms.length === 0) return false;
  const chat = useChat.getState();
  const since = lastRunAt(routine);

  return Object.keys({ ...chat.rooms, ...chat.subscriptions }).some((rid) => {
    const subscription = chat.subscriptions[rid];
    const room = chat.rooms[rid];
    if (!selectedRooms.some((roomRef) => roomMatches(roomRef, rid, subscription, room))) {
      return false;
    }
    const latestCachedMessage = (chat.messages[rid] ?? [])
      .reduce((latest, message) => Math.max(latest, tsMs(message.ts)), 0);
    const latest = Math.max(
      tsMs(room?.lm),
      tsMs(room?.lastMessage?.ts),
      latestCachedMessage,
    );
    return latest > since;
  });
}

export function shouldRunRoutine(routine: Routine, _now: number): boolean {
  switch (routine.precheck ?? 'none') {
    case 'new-mentions':
      return hasNewMentions(routine);
    case 'room-activity':
      return hasRoomActivity(routine);
    case 'none':
      return true;
  }
}
