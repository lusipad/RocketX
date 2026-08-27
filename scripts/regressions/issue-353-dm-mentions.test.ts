import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canMentionInRoom,
  mentionQueryAtCursor,
  shouldSearchMentionDirectory,
} from '../../apps/web/src/lib/mentions';

// 历史：issue #251 曾禁用 DM 提及（当时认为一对一参与者已确定）；
// issue #353 重新放开候选（限对方成员），但不触发目录搜索；
// 之后应需求再放开 DM 目录搜索：私聊也能 @ 不在会话里的人，
// 只插入提及文本（DM 拉不了人，不邀请、无提醒），UI 用「不在会话中」区分。
test('所有房型（含 d）都允许提及', () => {
  assert.equal(canMentionInRoom('d'), true);
  assert.equal(canMentionInRoom('c'), true);
  assert.equal(canMentionInRoom('p'), true);
  assert.equal(canMentionInRoom(undefined), true);
});

test('一对一私聊输入 @ 会进入候选路径，也触发全局目录搜索', () => {
  const value = '发给 @someone';
  assert.equal(mentionQueryAtCursor(value, value.length, 'd'), 'someone');
  assert.equal(shouldSearchMentionDirectory('someone', 'd'), true);

  assert.equal(mentionQueryAtCursor(value, value.length, 'c'), 'someone');
  assert.equal(shouldSearchMentionDirectory('someone', 'c'), true);

  // 空关键词（刚打完 @）任何房型都不搜目录
  assert.equal(shouldSearchMentionDirectory('', 'd'), false);
  assert.equal(shouldSearchMentionDirectory(null, 'c'), false);
});

test('私聊里的会话外候选只插入文本、不记待邀请，徽标与会群聊区分', () => {
  const source = readFileSync('apps/web/src/components/Composer.tsx', 'utf8');
  // DM 不记 pendingInvites（邀请 t='d' 会另建新会话）
  assert.match(source, /candidate\.isRemote && roomType !== 'd'/);
  // DM 候选徽标与群聊不同
  assert.match(source, /roomType === 'd' \? '不在会话中' : '非群成员'/);
});
