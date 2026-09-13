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
 * issue #392：讨论名会作为 `rooms.createDiscussion` 的 `t_name` 发给服务端，必须
 * 先过服务端 slug 校验。此前消息原文（带空格/标点/中文）被原样发出。
 */
test('创建讨论的入口都把名称交给 slug 清洗，而不是直接发原文', async () => {
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

  // 弹窗实时显示最终房间名，避免「输入的名字」和「实际创建的名字」不一致。
  assert.match(dialog, /const finalName = slugifyRoomName\(/);
  assert.match(dialog, /房间名将创建为 \$\{finalName\}|\{finalName === name\.trim\(\) \? `房间名 \$\{finalName\}`/);
  // store 是唯一发请求的地方：提示语也用清洗后的名字。
  assert.match(chatStore, /const name = slugifyRoomName\(/);
  assert.match(chatStore, /已创建讨论「\$\{name\}」/);
  // 工作项两条路径此前用 `#123 标题` 直接建讨论。
  assert.match(workItemDialog, /const discName = slugifyRoomName\(`#\$\{top\.id\} \$\{top\.title\}`/);
  assert.match(workItemDiscussionDialog, /slugifyRoomName\(discussionName\.trim\(\)/);
});
