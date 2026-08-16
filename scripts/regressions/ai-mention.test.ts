import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchSharedAiMention,
  resolveSharedAiMentionTarget,
} from '../../apps/web/src/lib/aiMention';
import { insertMentionAtCursor } from '../../apps/web/src/lib/mentions';

const activeRoomSession = {
  status: 'ready' as const,
};

test('共享 AI 候选只匹配 @、@a 和 @ai', () => {
  assert.equal(matchSharedAiMention(''), true);
  assert.equal(matchSharedAiMention('a'), true);
  assert.equal(matchSharedAiMention('AI'), true);
  assert.equal(matchSharedAiMention('here'), false);
  assert.equal(matchSharedAiMention('aix'), false);
  assert.equal(matchSharedAiMention(null), false);
});

test('只为当前作用域中未结束的共享托管会话提供 @ai 候选', () => {
  const roomKey = 'room:room-1';
  assert.deepEqual(
    resolveSharedAiMentionTarget('room-1', undefined, { [roomKey]: activeRoomSession }, {}),
    { sessionKey: roomKey, status: 'active' },
  );
  assert.deepEqual(
    resolveSharedAiMentionTarget(
      'room-1',
      undefined,
      { [roomKey]: { status: 'interrupted' } },
      {},
    ),
    { sessionKey: roomKey, status: 'interrupted' },
  );
  assert.equal(
    resolveSharedAiMentionTarget('room-1', undefined, { [roomKey]: { status: 'ended' } }, {}),
    null,
  );
  assert.equal(resolveSharedAiMentionTarget('room-1', undefined, {}, {}), null);
});

test('话题会话优先于房间会话，已结束的话题不会错误回退到房间托管', () => {
  const roomKey = 'room:room-1';
  assert.deepEqual(
    resolveSharedAiMentionTarget(
      'room-1',
      'thread-1',
      { [roomKey]: activeRoomSession, 'thread-1': { status: 'running' } },
      {},
    ),
    { sessionKey: 'thread-1', status: 'active' },
  );
  assert.equal(
    resolveSharedAiMentionTarget(
      'room-1',
      'thread-1',
      { [roomKey]: activeRoomSession, 'thread-1': { status: 'ended' } },
      {},
    ),
    null,
  );
});

test('远端托管卡片只有在租约有效且未结束时才提供 @ai 候选', () => {
  const now = 1_000;
  const roomKey = 'room:room-1';
  assert.deepEqual(
    resolveSharedAiMentionTarget(
      'room-1',
      undefined,
      {},
      { [roomKey]: { status: 'active', leaseExpiresAt: now + 1 } },
      now,
    ),
    { sessionKey: roomKey, status: 'active' },
  );
  assert.equal(
    resolveSharedAiMentionTarget(
      'room-1',
      undefined,
      {},
      { [roomKey]: { status: 'active', leaseExpiresAt: now } },
      now,
    ),
    null,
  );
  assert.equal(
    resolveSharedAiMentionTarget(
      'room-1',
      undefined,
      {},
      { [roomKey]: { status: 'ended', leaseExpiresAt: now + 1 } },
      now,
    ),
    null,
  );
});

test('选择候选只替换光标所在提及并保留前后正文', () => {
  assert.deepEqual(insertMentionAtCursor('请 @a 继续', 4, 'ai'), {
    value: '请 @ai  继续',
    cursor: 6,
  });
  assert.deepEqual(insertMentionAtCursor('@ai', 3, 'ai'), {
    value: '@ai ',
    cursor: 4,
  });
});
