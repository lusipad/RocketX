import test from 'node:test';
import assert from 'node:assert/strict';
import type { RcMessage } from '../../packages/rc-client/src/index';
import {
  digitCharAt,
  digitCharOf,
  pollAttachment,
  pollFromMessage,
  pollIsClosed,
  pollText,
  pollTally,
  POLL_MAX_OPTIONS,
  type PollPayload,
} from '../../apps/web/src/lib/poll';

const poll: PollPayload = { question: '团建去哪', options: ['食堂', '面馆', '轻食'], multi: false };

function msgWith(overrides: Partial<RcMessage>): RcMessage {
  return {
    _id: 'm1',
    rid: 'r1',
    msg: pollText(poll),
    ts: 1,
    u: { _id: 'u1', username: 'admin' },
    ...overrides,
  } as RcMessage;
}

test('普通消息不误判为投票，投票消息能被识别回来', () => {
  const plain = msgWith({});
  assert.equal(pollFromMessage(plain), null);
  const pollMsg = msgWith({ attachments: [pollAttachment(poll)] });
  const parsed = pollFromMessage(pollMsg);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.poll,
    { question: '团建去哪', options: ['食堂', '面馆', '轻食'], multi: false, closed: false },
  );
});

test('残缺附件不崩溃也不误判', () => {
  const broken = msgWith({
    attachments: [{ type: 'rcx-poll', poll: { question: '没有选项' } } as never],
  });
  assert.equal(pollFromMessage(broken), null);
  const wrongType = msgWith({ attachments: [{ type: 'file' } as never] });
  assert.equal(pollFromMessage(wrongType), null);
});

test('计票：数字表情回应转票数，本人投票可识别', () => {
  const pollMsg = msgWith({
    attachments: [pollAttachment(poll)],
    reactions: {
      ':one:': { usernames: ['admin', 'zhangsan'] },
      ':two:': { usernames: ['lisi'] },
    },
  });
  const tally = pollTally(poll, pollMsg, 'admin');
  assert.deepEqual(tally.counts, [2, 1, 0]);
  assert.equal(tally.total, 3);
  assert.deepEqual(tally.myVotes, [0]);
  assert.deepEqual(tally.voters[0], ['admin', 'zhangsan']);
});

test('正文文本包含题目与编号选项，供官方客户端阅读', () => {
  const text = pollText(poll);
  assert.match(text, /📊 投票：团建去哪/);
  assert.match(text, /1\. 食堂/);
  assert.match(text, /2\. 面馆/);
  assert.match(text, /3\. 轻食/);
  const closed = pollText({ ...poll, closed: true });
  assert.match(closed, /投票已结束/);
});

test('数字键帽映射与上限', () => {
  assert.equal(digitCharOf(':one:'), '1️⃣');
  assert.equal(digitCharOf(':three:'), '3️⃣');
  assert.equal(digitCharOf(':smile:'), null);
  assert.equal(digitCharAt(0), '1️⃣');
  assert.equal(digitCharAt(8), '9️⃣');
  assert.equal(digitCharAt(9), null);
  assert.ok(POLL_MAX_OPTIONS === 9);
});

test('结束判定：锁表情或附件标记任一命中', () => {
  const pollMsg = msgWith({ attachments: [pollAttachment(poll)] });
  assert.equal(pollIsClosed(poll, pollMsg), false);
  const locked = msgWith({
    attachments: [pollAttachment(poll)],
    reactions: { ':lock:': { usernames: ['admin'] } },
  });
  assert.equal(pollIsClosed(poll, locked), true);
  const marked = msgWith({ attachments: [pollAttachment({ ...poll, closed: true })] });
  const markedPoll = pollFromMessage(marked);
  assert.ok(markedPoll);
  assert.equal(pollIsClosed(markedPoll.poll, marked), true);
});
