import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLanOutboxEntry,
  selectLanReplayEntries,
  type LanOutboxEntry,
} from '../../apps/web/src/lan/outbox';
import { RcApiError } from '../../packages/rc-client/src/rest';
import { shouldUseLanFallback } from '../../apps/web/src/stores/chat';

function entry(
  messageId: string,
  originalTs: number,
  direction: LanOutboxEntry['direction'],
  status: LanOutboxEntry['status'],
): LanOutboxEntry {
  return {
    version: 1,
    scope: 'server\0alice',
    messageId,
    roomId: 'room-1',
    text: messageId,
    originalTs,
    author: { _id: 'alice', username: 'alice' },
    direction,
    status,
    updatedAt: originalTs,
  };
}

test('LAN 回灌只选择作者发出的未同步消息并按原始时间排序', () => {
  const selected = selectLanReplayEntries([
    entry('newer', 300, 'outgoing', 'lan-delivered'),
    entry('received', 100, 'incoming', 'received'),
    entry('synced', 50, 'outgoing', 'synced'),
    entry('older', 200, 'outgoing', 'syncing'),
  ]);
  assert.deepEqual(
    selected.map((item) => item.messageId),
    ['older', 'newer'],
  );
});

test('LAN outbox 拒绝损坏版本、空房间和非有限原始时间', () => {
  const valid = entry('message-1', 123, 'outgoing', 'lan-delivered');
  assert.equal(isLanOutboxEntry(valid), true);
  assert.equal(isLanOutboxEntry({ ...valid, version: 2 }), false);
  assert.equal(isLanOutboxEntry({ ...valid, roomId: '' }), false);
  assert.equal(isLanOutboxEntry({ ...valid, originalTs: Number.NaN }), false);
});

test('只有 Rocket.Chat 不可达或服务端故障时才降级 LAN，话题与业务错误不改路由', () => {
  assert.equal(shouldUseLanFallback(new TypeError('Failed to fetch')), true);
  assert.equal(shouldUseLanFallback(new RcApiError('server unavailable', 503)), true);
  assert.equal(shouldUseLanFallback(new RcApiError('forbidden', 403)), false);
  assert.equal(shouldUseLanFallback(new TypeError('Failed to fetch'), 'thread-1'), false);
});
