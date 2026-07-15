import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationRoomId } from '../../apps/web/src/lib/notificationNavigation';

test('通知导航只接受有限长度且无控制字符的房间 ID', () => {
  assert.equal(notificationRoomId({ rid: 'room-123' }), 'room-123');
  assert.equal(notificationRoomId(null), null);
  assert.equal(notificationRoomId({}), null);
  assert.equal(notificationRoomId({ rid: '' }), null);
  assert.equal(notificationRoomId({ rid: 'room\nother' }), null);
  assert.equal(notificationRoomId({ rid: 'x'.repeat(257) }), null);
});
