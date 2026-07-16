const ROOM_STREAMS = [
  ['stream-room-messages', (rid: string) => rid],
  ['stream-notify-room', (rid: string) => `${rid}/deleteMessage`],
  ['stream-notify-room', (rid: string) => `${rid}/user-activity`],
] as const;

export function createActiveRoomStreams(
  subscribe: (stream: string, key: string) => void,
  unsubscribe: (stream: string, key: string) => void,
) {
  let activeRid: string | null = null;
  return (rid: string) => {
    if (rid === activeRid) return;
    if (activeRid) {
      for (const [stream, keyOf] of ROOM_STREAMS) unsubscribe(stream, keyOf(activeRid));
    }
    activeRid = rid;
    for (const [stream, keyOf] of ROOM_STREAMS) subscribe(stream, keyOf(rid));
  };
}
