import test from 'node:test';
import assert from 'node:assert/strict';
import type { RcMessage } from '../../packages/rc-client/src/types';
import { collectUnreadHistory } from '../../apps/web/src/lib/unreadHistory';

function historyMessage(index: number): RcMessage {
  return {
    _id: `m${index}`,
    rid: 'room',
    msg: `message ${index}`,
    ts: new Date(Date.UTC(2026, 6, 17, 0, index)).toISOString(),
    u: { _id: 'u', username: 'user' },
  };
}

test('230 条未读用 5 页无副作用拉全、去重并按时间正序返回', async () => {
  const all = Array.from({ length: 230 }, (_, index) => historyMessage(index + 1));
  const pages = [
    all.slice(180),
    [all[179], ...all.slice(130, 179)],
    [all[130], ...all.slice(81, 130)],
    [all[81], ...all.slice(32, 81)],
    [all[32], ...all.slice(0, 32)],
  ];
  const calls: Array<string | undefined> = [];
  const result = await collectUnreadHistory(
    { rid: 'room', type: 'c', lastSeen: '2026-07-17T00:00:00.000Z' },
    async (_rid, _type, count, latest) => {
      assert.equal(count, 50);
      calls.push(latest);
      return pages[calls.length - 1] ?? [];
    },
  );
  assert.equal(calls.length, 5);
  assert.equal(result.pages, 5);
  assert.equal(result.truncated, false);
  assert.equal(result.messages.length, 230);
  assert.equal(result.messages[0]._id, 'm1');
  assert.equal(result.messages.at(-1)?._id, 'm230');
});

test('到达页数上限会明确标 truncated，不能伪装成完整摘要', async () => {
  let call = 0;
  const result = await collectUnreadHistory(
    { rid: 'room', type: 'p', lastSeen: '2026-07-17T00:00:00.000Z', pageSize: 2, maxPages: 2 },
    async () => {
      call += 1;
      return [historyMessage(10 - call * 2), historyMessage(11 - call * 2)];
    },
  );
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, true);
});

test('unread 计数不参与判断，alert 场景仍严格按 lastSeen 边界采集', async () => {
  const result = await collectUnreadHistory(
    { rid: 'room', type: 'd', lastSeen: '2026-07-17T00:05:00.000Z' },
    async () => [historyMessage(4), historyMessage(5), historyMessage(6)],
  );
  assert.deepEqual(result.messages.map((message) => message._id), ['m6']);
  assert.equal(result.truncated, false);
});
