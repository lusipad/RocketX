import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentReplyNotificationTracker } from '../../apps/web/src/agent/replyNotification';

test('本机发出 @ai 后只抑制同房间的一条 AI 回复通知', () => {
  const tracker = createAgentReplyNotificationTracker();
  assert.equal(tracker.expect('room-a', '@ai 分析登录失败', 1_000), true);
  assert.equal(tracker.consume('room-b', '🤖 Codex\n分析结果', 2_000), false);
  assert.equal(tracker.consume('room-a', '普通成员回复', 2_000), false);
  assert.equal(tracker.consume('room-a', '🤖 Codex\n分析结果', 2_000), true);
  assert.equal(tracker.consume('room-a', '🤖 Codex\n后续主动消息', 3_000), false);
});

test('并发 @ai 请求分别消费对应数量的回复', () => {
  const tracker = createAgentReplyNotificationTracker();
  tracker.expect('room', '@ai 第一个问题', 1_000);
  tracker.expect('room', '@codex 第二个问题', 1_100);
  assert.equal(tracker.consume('room', '🤖 Codex（已脱敏 1 处）\n结果一', 2_000), true);
  assert.equal(tracker.consume('room', '🤖 Codex 执行失败：超时', 2_100), true);
  assert.equal(tracker.consume('room', '🤖 Codex\n第三条', 2_200), false);
});

test('发送失败可撤销等待，过期请求不会长期吞掉通知', () => {
  const tracker = createAgentReplyNotificationTracker();
  assert.equal(tracker.expect('room', '普通聊天', 1_000), false);
  tracker.expect('room', '@ai 不会成功发送', 1_000);
  tracker.cancel('room');
  assert.equal(tracker.consume('room', '🤖 Codex\n无关回复', 2_000), false);

  tracker.expect('room', '@ai 很久以前的问题', 1_000);
  assert.equal(tracker.consume('room', '🤖 Codex\n迟到回复', 10 * 60 * 1_000 + 1_001), false);
});
