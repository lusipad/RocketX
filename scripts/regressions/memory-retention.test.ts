import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/types';
import { rest } from '../../apps/web/src/lib/client';
import {
  canApplyRetainedRoomResult,
  omitRoomEntries,
  retainRecentRooms,
  trimRoomMessages,
} from '../../apps/web/src/lib/chatMemory';
import { TimedLruCache } from '../../apps/web/src/lib/timedLruCache';
import { useChat } from '../../apps/web/src/stores/chat';

function roomMessages(rid: string, count: number): RcMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    _id: `${rid}-${index + 1}`,
    rid,
    msg: `message-${index + 1}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    u: { _id: 'user', username: 'user' },
  }));
}

test('当前会话加最近八个会话保留完整数据，最旧会话被淘汰', () => {
  let order: string[] = [];
  let evicted: string[] = [];

  for (let index = 1; index <= 10; index++) {
    const result = retainRecentRooms(order, `room-${index}`, 8);
    order = result.order;
    evicted = result.evicted;
  }

  assert.deepEqual(order, [
    'room-2',
    'room-3',
    'room-4',
    'room-5',
    'room-6',
    'room-7',
    'room-8',
    'room-9',
    'room-10',
  ]);
  assert.deepEqual(evicted, ['room-1']);
});

test('重复打开已有会话只更新最近顺序，不误淘汰其他会话', () => {
  const result = retainRecentRooms(['room-1', 'room-2', 'room-3'], 'room-2', 8);

  assert.deepEqual(result.order, ['room-1', 'room-3', 'room-2']);
  assert.deepEqual(result.evicted, []);
});

test('切换账号或服务器后，即使房间 ID 相同也拒绝旧会话的迟到响应', () => {
  assert.equal(canApplyRetainedRoomResult(1, 1, ['same-room'], 'same-room'), true);
  assert.equal(canApplyRetainedRoomResult(1, 2, ['same-room'], 'same-room'), false);
});

test('淘汰房间只保留消息尾部并删除按房间缓存', () => {
  const messages = {
    active: [{ id: 1 }],
    old: Array.from({ length: 75 }, (_, index) => ({ id: index + 1 })),
  };

  const trimmed = trimRoomMessages(messages, ['old'], 60);
  const members = omitRoomEntries({ active: ['a'], old: ['b'] }, ['old']);
  const roles = omitRoomEntries({ active: ['owner'], old: ['moderator'] }, ['old']);

  assert.equal(trimmed.active, messages.active);
  assert.equal(trimmed.old.length, 60);
  assert.equal(trimmed.old[0]?.id, 16);
  assert.deepEqual(members, { active: ['a'] });
  assert.deepEqual(roles, { active: ['owner'] });
});

test('ADO 定时 LRU 缓存同时限制容量并优先保留最近访问项', () => {
  const cache = new TimedLruCache<string>(2, 1_000);
  cache.set('first', '1', 0);
  cache.set('second', '2', 10);
  assert.deepEqual(cache.get('first', 20), { hit: true, value: '1' });

  cache.set('third', '3', 30);

  assert.deepEqual(cache.get('second', 40), { hit: false });
  assert.deepEqual(cache.get('first', 40), { hit: true, value: '1' });
  assert.deepEqual(cache.get('third', 40), { hit: true, value: '3' });
  assert.equal(cache.size, 2);
});

test('ADO 定时 LRU 缓存会删除过期项并支持缓存 null', () => {
  const cache = new TimedLruCache<string | null>(2, 100);
  cache.set('missing', null, 0);

  assert.deepEqual(cache.get('missing', 50), { hit: true, value: null });
  assert.deepEqual(cache.get('missing', 101), { hit: false });
  assert.equal(cache.size, 0);
});

test('快速切换会话后，迟到历史响应不会重新填充已淘汰房间', async () => {
  const originalGetHistory = rest.getHistory;
  const originalGetMembers = rest.getMembers;
  const rooms = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => {
      const rid = `store-room-${index + 1}`;
      return [rid, { _id: rid, t: 'c' as const }];
    }),
  );
  let releaseOldHistory!: (messages: RcMessage[]) => void;
  const oldHistory = new Promise<RcMessage[]>((resolve) => {
    releaseOldHistory = resolve;
  });

  rest.getHistory = async (rid) =>
    rid === 'store-room-1' ? oldHistory : roomMessages(rid, 50);
  rest.getMembers = async () => [];
  useChat.setState({
    rooms,
    subscriptions: {},
    messages: { 'store-room-1': roomMessages('store-room-1', 75) },
    historyLoaded: {},
    hasMore: {},
    members: { 'store-room-1': [{ _id: 'member', username: 'member' }] },
    memberErrors: {},
    typing: {},
    readReceipts: {},
    roomRoles: {},
  });

  try {
    const staleOpen = useChat.getState().openRoom('store-room-1');
    for (let index = 2; index <= 10; index++) {
      await useChat.getState().openRoom(`store-room-${index}`);
    }
    releaseOldHistory(roomMessages('store-room-1', 50));
    await staleOpen;

    const state = useChat.getState();
    assert.equal(state.messages['store-room-1']?.length, 60);
    assert.equal(state.historyLoaded['store-room-1'], undefined);
    assert.equal(state.members['store-room-1'], undefined);
  } finally {
    rest.getHistory = originalGetHistory;
    rest.getMembers = originalGetMembers;
  }
});
