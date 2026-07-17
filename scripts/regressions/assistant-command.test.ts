import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackAssistantCommand, isAssistantWorkCommand } from '../../apps/web/src/lib/assistantCommand';

test('明确的工作查询走本地快速路径', () => {
  assert.equal(isAssistantWorkCommand('查询失败的构建'), true);
  assert.equal(isAssistantWorkCommand('创建工作项：修复登录失败'), true);
  assert.equal(isAssistantWorkCommand('昨天老李给我的文件'), false);
});

test('不配置外部 Provider 时显式命令仍能安全回退', () => {
  assert.deepEqual(fallbackAssistantCommand('查询失败的构建'), {
    type: 'list_builds',
    failedOnly: true,
  });
  assert.deepEqual(fallbackAssistantCommand('创建工作项：修复登录失败'), {
    type: 'create_work_item',
    title: '修复登录失败',
  });
  assert.deepEqual(fallbackAssistantCommand('搜索发布失败'), {
    type: 'search',
    query: '发布失败',
  });
});
