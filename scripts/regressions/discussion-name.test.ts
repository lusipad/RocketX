import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('右键创建讨论先允许编辑讨论名称，再把名称传给创建流程', async () => {
  const messageItem = await readFile(
    new URL('../../apps/web/src/components/MessageItem.tsx', import.meta.url),
    'utf8',
  );
  const chatStore = await readFile(
    new URL('../../apps/web/src/stores/chat.ts', import.meta.url),
    'utf8',
  );

  assert.match(messageItem, /setCreateDiscussionOpen\(true\)/);
  assert.match(messageItem, /title="创建讨论"/);
  assert.match(messageItem, /maxLength=\{40\}/);
  assert.match(messageItem, /createDiscussionFrom\(message, name\)/);
  assert.match(chatStore, /createDiscussionFrom: \(msg: RcMessage, name\?: string\)/);
  assert.match(chatStore, /requestedName\?\.trim\(\) \|\| stripQuotePrefix\(msg\.msg\)/);
});
