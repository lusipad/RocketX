import assert from 'node:assert/strict';
import test from 'node:test';
import { createActiveRoomStreams } from '../../apps/web/src/lib/roomStreams';

test('切换会话时只保留当前房间的三条实时订阅', () => {
  const calls: string[] = [];
  const switchRoom = createActiveRoomStreams(
    (stream, key) => calls.push(`sub:${stream}:${key}`),
    (stream, key) => calls.push(`unsub:${stream}:${key}`),
  );
  switchRoom('room-a');
  switchRoom('room-a');
  switchRoom('room-b');

  assert.deepEqual(calls, [
    'sub:stream-room-messages:room-a',
    'sub:stream-notify-room:room-a/deleteMessage',
    'sub:stream-notify-room:room-a/user-activity',
    'unsub:stream-room-messages:room-a',
    'unsub:stream-notify-room:room-a/deleteMessage',
    'unsub:stream-notify-room:room-a/user-activity',
    'sub:stream-room-messages:room-b',
    'sub:stream-notify-room:room-b/deleteMessage',
    'sub:stream-notify-room:room-b/user-activity',
  ]);
});
