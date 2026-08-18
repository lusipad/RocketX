import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canMentionInRoom,
  mentionQueryAtCursor,
  shouldSearchMentionDirectory,
} from '../../apps/web/src/lib/mentions';

// 历史：issue #251 曾禁用 DM 提及（当时认为一对一参与者已确定）；
// issue #353 重新放开 —— DM 出候选（限对方成员），但不触发目录搜索。
test('所有房型（含 d）都允许提及', () => {
  assert.equal(canMentionInRoom('d'), true);
  assert.equal(canMentionInRoom('c'), true);
  assert.equal(canMentionInRoom('p'), true);
  assert.equal(canMentionInRoom(undefined), true);
});

test('一对一私聊输入 @ 会进入候选路径，但不会触发全局目录搜索', () => {
  const value = '发给 @someone';
  assert.equal(mentionQueryAtCursor(value, value.length, 'd'), 'someone');
  assert.equal(shouldSearchMentionDirectory('someone', 'd'), false);

  assert.equal(mentionQueryAtCursor(value, value.length, 'c'), 'someone');
  assert.equal(shouldSearchMentionDirectory('someone', 'c'), true);
});
