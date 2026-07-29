import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canMentionInRoom,
  mentionQueryAtCursor,
  shouldSearchMentionDirectory,
} from '../../apps/web/src/lib/mentions';

test('room type d 被视为不可提及房间，其他房型保留提及能力', () => {
  assert.equal(canMentionInRoom('d'), false);
  assert.equal(canMentionInRoom('c'), true);
  assert.equal(canMentionInRoom('p'), true);
  assert.equal(canMentionInRoom(undefined), true);
});

test('一对一私聊输入 @ 时不会进入候选或全局搜索路径，但 @ 仍是普通字符', () => {
  const value = '发给 @someone';
  assert.equal(canMentionInRoom('d'), false);
  assert.equal(mentionQueryAtCursor(value, value.length, 'd'), null);
  assert.equal(shouldSearchMentionDirectory('someone', 'd'), false);

  assert.equal(canMentionInRoom('c'), true);
  assert.equal(mentionQueryAtCursor(value, value.length, 'c'), 'someone');
  assert.equal(shouldSearchMentionDirectory('someone', 'c'), true);
});
