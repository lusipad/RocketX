import test from 'node:test';
import assert from 'node:assert/strict';
import type { RcMessage } from '../../packages/rc-client/src/types';
import { collectMentionInbox } from '../../apps/web/src/lib/mentionInbox';
import { buildTodayItems, todayCompletion } from '../../apps/web/src/lib/today';

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

test('今日纳入直接提及、到期事项、未结束工作项、相关 PR 和需关注构建', () => {
  const mention = message('m1', 'r1', '2026-07-17T09:00:00Z');
  const input = {
    mentions: [{ message: mention, roomName: '项目群' }],
    todos: [
      { id: 'late', rid: 'r1', mid: 'm2', roomName: '项目群', excerpt: '逾期', author: 'A', due: '2026-07-16', done: false, createdAt: 1 },
      { id: 'today', rid: 'r1', mid: 'm3', roomName: '项目群', excerpt: '今天', author: 'A', due: '2026-07-17', done: false, createdAt: 1 },
      { id: 'future', rid: 'r1', mid: 'm4', roomName: '项目群', excerpt: '未来', author: 'A', due: '2026-07-18', done: false, createdAt: 1 },
    ],
    events: [{ id: 'e1', title: '例会', date: '2026-07-17', allDay: false, startTime: '10:00', color: '#000', source: 'manual' as const, createdAt: 1 }],
    workItems: [
      { id: 7, title: '修 bug', type: 'Bug', state: 'Active', project: 'P', webUrl: 'https://ado/7' },
      { id: 8, title: '已完成', type: 'Bug', state: 'Done', project: 'P', webUrl: 'https://ado/8' },
    ],
    pullRequests: [
      { id: 9, title: '待我评审', repo: 'R', creator: 'B', creatorUnique: 'b', reviewers: [], sourceBranch: 'feature', targetBranch: 'main', webUrl: 'https://ado/pr/9', rel: 'review' as const },
      { id: 10, title: '我提的 PR', repo: 'R', creator: 'A', creatorUnique: 'a', reviewers: [], sourceBranch: 'fix', targetBranch: 'main', webUrl: 'https://ado/pr/10', rel: 'mine' as const },
    ],
    builds: [
      { id: 11, buildNumber: '20260717.1', definition: 'CI', project: 'P', status: 'completed', result: 'failed', requestedFor: 'A', queueTime: '2026-07-17T01:00:00Z', finishTime: '2026-07-17T01:10:00Z', webUrl: 'https://ado/build/11' },
      { id: 12, buildNumber: '20260717.2', definition: 'CI', project: 'P', status: 'completed', result: 'succeeded', requestedFor: 'A', queueTime: '2026-07-17T02:00:00Z', finishTime: '2026-07-17T02:10:00Z', webUrl: 'https://ado/build/12' },
    ],
    ipmsg: [
      { id: 'ip1', peerId: 'peer1', senderName: '旧客户端', direction: 'incoming' as const, text: '局域网消息', timestamp: 1 },
      { id: 'ip2', peerId: 'peer1', senderName: '我', direction: 'outgoing' as const, text: '已发送', timestamp: 2 },
    ],
    scope: 'server:user',
    adoScope: 'ado:project',
    today: '2026-07-17',
  };
  const first = buildTodayItems(input);
  assert.deepEqual(first.map((item) => item.kind), ['todo', 'pr', 'ipmsg', 'mention', 'event', 'pr', 'todo', 'workitem']);
  assert.equal(first.some((item) => item.kind === 'build'), false);
  assert.equal(first.some((item) => item.title === '未来'), false);
  assert.equal(first.some((item) => item.title === '已完成'), false);
  const processed = new Set([first[0].key, first[1].key]);
  const next = buildTodayItems({ ...input, processed });
  assert.deepEqual(todayCompletion(next), { done: 2, total: 8, rate: 2 / 8 });
});
