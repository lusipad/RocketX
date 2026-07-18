import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackAssistantCommand, isAssistantWorkCommand } from '../../apps/web/src/lib/assistantCommand';

test('明确的工作查询走本地快速路径', () => {
  assert.equal(isAssistantWorkCommand('查询失败的构建'), true);
  assert.equal(isAssistantWorkCommand('创建工作项：修复登录失败'), true);
  assert.equal(isAssistantWorkCommand('查看PR'), true);
  assert.equal(isAssistantWorkCommand('帮我查询我的未完成待办'), true);
  assert.equal(isAssistantWorkCommand('我的待办'), true);
  assert.equal(isAssistantWorkCommand('失败的构建'), true);
  assert.equal(isAssistantWorkCommand('昨天老李给我的文件'), false);
});

test('疑问句等自然语言交给 AI 回答，不做正则拆解（issue #89）', () => {
  assert.equal(isAssistantWorkCommand('再帮我看看还有哪些需要我处理的PR'), false);
  assert.equal(isAssistantWorkCommand('帮我看看PR'), false);
  assert.equal(isAssistantWorkCommand('有没有失败的构建？'), false);
  assert.equal(isAssistantWorkCommand('我还有多少待办没做完'), false);
  assert.equal(isAssistantWorkCommand('怎么创建工作项'), false);
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

test('列表查询把类型名和口水词从筛选关键词里去掉，不再拿整句话过滤（issue #89）', () => {
  assert.deepEqual(fallbackAssistantCommand('查看PR'), {
    type: 'list_pull_requests',
    query: undefined,
  });
  assert.deepEqual(fallbackAssistantCommand('查看待我评审的PR'), {
    type: 'list_pull_requests',
    query: undefined,
  });
  assert.deepEqual(fallbackAssistantCommand('查询我的未完成待办'), {
    type: 'list_todos',
    query: undefined,
  });
  // 真正的筛选关键词要保留
  assert.deepEqual(fallbackAssistantCommand('查看PR 登录修复'), {
    type: 'list_pull_requests',
    query: '登录修复',
  });
  assert.deepEqual(fallbackAssistantCommand('查询本周发布工作项'), {
    type: 'list_work_items',
    query: '本周发布',
  });
});
