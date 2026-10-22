import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('右键创建讨论先允许编辑讨论名称，再把名称传给创建流程', async () => {
  const messageItem = await readFile(
    new URL('../../apps/web/src/components/MessageItem.tsx', import.meta.url),
    'utf8',
  );
  const dialog = await readFile(
    new URL('../../apps/web/src/components/CreateDiscussionDialog.tsx', import.meta.url),
    'utf8',
  );
  const chatStore = await readFile(
    new URL('../../apps/web/src/stores/chat.ts', import.meta.url),
    'utf8',
  );

  assert.match(messageItem, /setCreateDiscussionOpen\(true\)/);
  assert.match(messageItem, /createDiscussionFrom\(message, name\)/);
  // 弹窗后来抽成独立组件，同时服务「从消息创建」与「在房间里创建」
  assert.match(dialog, /title="创建讨论"/);
  assert.match(dialog, /maxLength=\{40\}/);
  assert.match(chatStore, /createDiscussionFrom: \(msg: RcMessage, name\?: string\)/);
  assert.match(chatStore, /requestedName\?\.trim\(\) \|\| stripQuotePrefix\(msg\.msg\)/);
});

/**
 * issue #397：讨论名称支持中文，不走 ASCII slug 转换（Rocket.Chat 服务端讨论名是展示名 fname，跳过房间名校验）。
 */
test('创建讨论的入口支持中文讨论名称，且统一规范化首尾空白与长度截断', async () => {
  const dialog = await readFile(
    new URL('../../apps/web/src/components/CreateDiscussionDialog.tsx', import.meta.url),
    'utf8',
  );
  const chatStore = await readFile(
    new URL('../../apps/web/src/stores/chat.ts', import.meta.url),
    'utf8',
  );
  const workItemDialog = await readFile(
    new URL('../../apps/web/src/components/CreateWorkItemDialog.tsx', import.meta.url),
    'utf8',
  );
  const workItemDiscussionDialog = await readFile(
    new URL('../../apps/web/src/components/CreateWorkItemDiscussionDialog.tsx', import.meta.url),
    'utf8',
  );

  // 弹窗使用 normalizeDiscussionName 保留中文与空格输入
  assert.match(dialog, /const finalName = normalizeDiscussionName\(/);
  // store 是唯一发请求的地方：提示语与参数都使用规范化讨论名
  assert.match(chatStore, /const name = normalizeDiscussionName\(/);
  assert.match(chatStore, /已创建讨论「\$\{name\}」/);
  // 工作项两条路径支持中文标题建讨论，不再被清洗成纯哈希
  assert.match(workItemDialog, /const discName = normalizeDiscussionName\(`#\$\{top\.id\} \$\{top\.title\}`/);
  assert.match(workItemDiscussionDialog, /normalizeDiscussionName\(discussionName\.trim\(\)/);
});
