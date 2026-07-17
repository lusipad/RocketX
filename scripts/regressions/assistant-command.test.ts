import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fallbackAssistantCommand, parseAssistantCommand } from '../../apps/web/src/lib/assistantCommand';

test('AI 助手只接受白名单内的只读查询和工作项草案', () => {
  assert.deepEqual(parseAssistantCommand({ type: 'search', query: '发布失败' }), {
    type: 'search',
    query: '发布失败',
  });
  assert.deepEqual(
    parseAssistantCommand({
      type: 'create_work_item',
      title: '修复登录失败',
      description: '复现后补充日志',
      workItemType: 'Bug',
    }),
    {
      type: 'create_work_item',
      title: '修复登录失败',
      description: '复现后补充日志',
      workItemType: 'Bug',
    },
  );
  assert.throws(() => parseAssistantCommand({ type: 'delete_work_item', id: 42 }), /不支持指令/);
});

test('失败构建查询只能解析为布尔筛选', () => {
  assert.deepEqual(parseAssistantCommand({ type: 'list_builds', failedOnly: true }), {
    type: 'list_builds',
    query: undefined,
    failedOnly: true,
  });
  assert.deepEqual(parseAssistantCommand({ type: 'list_builds', failedOnly: 'true' }), {
    type: 'list_builds',
    query: undefined,
    failedOnly: false,
  });
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

test('桌面端模糊意图默认交给 Codex exec，而不是 DeepSeek', async () => {
  const [web, desktop] = await Promise.all([
    readFile(new URL('../../apps/web/src/lib/assistantCommand.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/desktop/src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ]);
  assert.match(web, /invoke<unknown>\('codex_assistant_command'/);
  assert.doesNotMatch(web, /getAiBus|collectStructuredObject/);
  assert.match(desktop, /--output-schema/);
  assert.match(desktop, /ASSISTANT_COMMAND_SCHEMA/);
});
