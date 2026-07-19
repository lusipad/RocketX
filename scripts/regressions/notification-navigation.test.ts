import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notificationDestination,
  notificationTarget,
} from '../../apps/web/src/lib/notificationNavigation';

test('通知导航只接受有限长度且无控制字符的房间与消息 ID', () => {
  assert.deepEqual(notificationTarget({ rid: 'room-123', mid: 'message-456' }), {
    rid: 'room-123',
    mid: 'message-456',
  });
  assert.equal(notificationTarget(null), null);
  assert.equal(notificationTarget({}), null);
  assert.equal(notificationTarget({ rid: '', mid: 'message' }), null);
  assert.equal(notificationTarget({ rid: 'room\nother', mid: 'message' }), null);
  assert.equal(notificationTarget({ rid: 'x'.repeat(257), mid: 'message' }), null);
  assert.equal(notificationTarget({ rid: 'room', mid: '' }), null);
  assert.equal(notificationTarget({ rid: 'room', mid: 'message\nother' }), null);
  assert.equal(notificationTarget({ rid: 'room', mid: 'x'.repeat(257) }), null);
});

test('管家通知进入管家页，聊天通知仍进入消息页', () => {
  assert.equal(notificationDestination({ rid: 'butler' }), 'butler-view');
  assert.equal(notificationDestination({ rid: 'room-123' }), 'messages');
});
