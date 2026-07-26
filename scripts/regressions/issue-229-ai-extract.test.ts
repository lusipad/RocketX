import assert from 'node:assert/strict';
import test from 'node:test';
import { humanError } from '../../apps/web/src/stores/toast';

/**
 * issue #229：「AI 提取为待办」「AI 提取为工作项」点了没反应，几秒后弹一句
 * 「没有权限执行此操作」。用户以为是 Rocket.Chat 的权限问题，其实是内置的
 * AI provider 从来没有密钥、请求拿回 401，而 401 被当成 RC 的权限错误翻译了。
 */
test('第三方服务的 401 不再冒充 Rocket.Chat 的权限错误', () => {
  const aiFailure = new Error('AI 请求失败（HTTP 401）: invalid api key');
  assert.notEqual(humanError(aiFailure), '没有权限执行此操作');
  assert.match(humanError(aiFailure), /AI 请求失败/);
});

test('Rocket.Chat 报的 401 仍然翻成人话——认 status 不认文本', () => {
  const rcFailure = Object.assign(new Error('unauthorized'), { status: 401 });
  assert.equal(humanError(rcFailure), '没有权限执行此操作');

  // 有些接口只给文本不给 status
  assert.equal(humanError(new Error('User is not authorized')), '没有权限执行此操作');

  // 只有 status、消息是英文原文的也要认
  const bare = Object.assign(new Error('Forbidden resource'), { status: 401 });
  assert.equal(humanError(bare), '没有权限执行此操作');
});

test('传入字符串或 null 不会因为读 status 而炸', () => {
  assert.equal(humanError('磁盘写满了'), '磁盘写满了');
  assert.equal(humanError(null, '操作失败'), '操作失败');
});
