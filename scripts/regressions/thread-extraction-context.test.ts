import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Codex 提取待办时，话题消息会读取根消息和回复作为上下文', async () => {
  const source = await readFile(
    new URL('../../apps/web/src/components/MessageItem.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /const rootId = message\.tmid \?\? \(message\.tcount \? message\._id : undefined\);/);
  assert.match(source, /rest\.getThreadMessages\(rootId\)/);
  assert.match(source, /保留根消息与当前消息/);
  assert.match(source, /context,/);
});
