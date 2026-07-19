import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/types';
import { collectMentionInbox } from '../../apps/web/src/lib/mentionInbox';

function message(id: string, rid: string, ts: string, mention = 'me'): RcMessage {
  return {
    _id: id,
    rid,
    msg: id,
    ts,
    u: { _id: 'u2', username: 'other' },
    mentions: [{ _id: mention === 'me' ? 'u1' : mention, username: mention }],
  };
}

test('全局 @我 按房间分页、排除群体/他人提及、跨房间去重并保留部分失败', async () => {
  const calls: Array<[string, number, number]> = [];
  const repeated = message('same', 'r1', '2026-07-17T10:00:00Z');
  const result = await collectMentionInbox(
    [
      { rid: 'r1', name: '一号群', userMentions: 120 },
      { rid: 'r2', name: '二号群', userMentions: 1 },
      { rid: 'r3', name: '无提及', userMentions: 0 },
    ],
    { _id: 'u1', username: 'me' },
    async (rid, offset, count) => {
      calls.push([rid, offset, count]);
      if (rid === 'r2') throw new Error('offline');
      const pages: Record<number, RcMessage[]> = {
        0: [repeated, message('other', rid, '2026-07-17T11:00:00Z', 'u9'), ...Array.from({ length: 48 }, (_, index) => message(`a${index}`, rid, `2026-07-16T${String(index % 24).padStart(2, '0')}:00:00Z`))],
        50: [repeated, ...Array.from({ length: 49 }, (_, index) => message(`b${index}`, rid, `2026-07-15T${String(index % 24).padStart(2, '0')}:00:00Z`))],
        100: Array.from({ length: 20 }, (_, index) => message(`c${index}`, rid, `2026-07-14T${String(index % 20).padStart(2, '0')}:00:00Z`)),
      };
      return { messages: pages[offset] ?? [], count: pages[offset]?.length ?? 0, offset, total: 120 };
    },
  );
  assert.deepEqual(calls.filter(([rid]) => rid === 'r1').map(([, offset]) => offset), [0, 50, 100]);
  assert.equal(calls.some(([rid]) => rid === 'r3'), false);
  assert.equal(result.items.filter((item) => item.message._id === 'same').length, 1);
  assert.equal(result.items.some((item) => item.message._id === 'other'), false);
  assert.deepEqual(result.warnings, ['二号群: offline']);
});
