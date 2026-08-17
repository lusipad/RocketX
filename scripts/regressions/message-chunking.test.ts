import assert from 'node:assert/strict';
import test from 'node:test';

function assertWithinLimit(chunks: string[], limit: number): void {
  assert.equal(chunks.length > 0, true);
  assert.equal(chunks.every((chunk) => chunk.length <= limit), true);
}

function stripContinuationPrefix(chunks: string[], prefix: string): string {
  return chunks.map((chunk, index) => (index === 0 || !chunk.startsWith(prefix) ? chunk : chunk.slice(prefix.length))).join('');
}

test('Message_MaxAllowedSize 无效时回退到 5000', async () => {
  const { normalizeMessageMaxAllowedSize } = await import('../../apps/web/src/lib/messageChunks');
  assert.equal(normalizeMessageMaxAllowedSize(undefined), 5000);
  assert.equal(normalizeMessageMaxAllowedSize('0'), 5000);
  assert.equal(normalizeMessageMaxAllowedSize(-12), 5000);
  assert.equal(normalizeMessageMaxAllowedSize(12.9), 12);
});

test('优先按段落与空白拆分且每段不超限', async () => {
  const { splitMessageForRocketChat } = await import('../../apps/web/src/lib/messageChunks');
  const chunks = splitMessageForRocketChat('alpha alpha\n\nbeta beta\ngamma delta', 18);
  assert.deepEqual(chunks, [
    'alpha alpha\n\n',
    'beta beta\n',
    'gamma delta',
  ]);
  assertWithinLimit(chunks, 18);
});

test('fenced code 跨段时会闭合并在下一段续开，且不拆坏 surrogate pair', async () => {
  const { splitMessageForRocketChat } = await import('../../apps/web/src/lib/messageChunks');
  const chunks = splitMessageForRocketChat('```ts\nconst face = "😀😀😀";\nconst done = true;\n```', 28);
  assert.equal(chunks.length > 1, true);
  assertWithinLimit(chunks, 28);
  assert.equal(chunks[0]?.startsWith('```ts\n'), true);
  assert.equal(chunks.some((chunk) => chunk.includes('const done = true;')), true);
  assert.equal(
    chunks.slice(0, -1).every((chunk) => chunk.endsWith('```')),
    true,
  );
  for (const chunk of chunks) {
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF]$/u);
    assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]/u);
  }
});

test('不会拆坏 CRLF、组合字符或 ZWJ grapheme，极小 limit 也不会死循环', async () => {
  const { splitMessageForRocketChat } = await import('../../apps/web/src/lib/messageChunks');
  const crlfChunks = splitMessageForRocketChat('alpha\r\n\r\nbeta\r\ngamma', 12);
  assert.deepEqual(crlfChunks, ['alpha\r\n\r\n', 'beta\r\ngamma']);
  assertWithinLimit(crlfChunks, 12);

  const combiningChunks = splitMessageForRocketChat('e\u0301e\u0301e\u0301', 3);
  assert.deepEqual(combiningChunks, ['e\u0301', 'e\u0301', 'e\u0301']);
  assertWithinLimit(combiningChunks, 3);

  const familyChunks = splitMessageForRocketChat('👨‍👩‍👧‍👦👨‍👩‍👧‍👦', 12);
  assert.deepEqual(familyChunks, ['👨‍👩‍👧‍👦', '👨‍👩‍👧‍👦']);
  assertWithinLimit(familyChunks, 12);
  for (const chunk of familyChunks) {
    assert.doesNotMatch(chunk, /[\u200d]$/u);
    assert.doesNotMatch(chunk, /^[\u200d]/u);
  }

  const tinyChunks = splitMessageForRocketChat('abcdef', 1);
  assert.deepEqual(tinyChunks, ['a', 'b', 'c', 'd', 'e', 'f']);
  assertWithinLimit(tinyChunks, 1);

  assert.throws(() => splitMessageForRocketChat('😀', 1), /单个字符超过消息上限/);
});

test('行中间出现的 inline fence 不会被误判成 fenced block 起点', async () => {
  const { splitMessageForRocketChat } = await import('../../apps/web/src/lib/messageChunks');
  const text = '1234567890```tsXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const chunks = splitMessageForRocketChat(text, 12);
  assertWithinLimit(chunks, 12);
  assert.equal(chunks.join(''), text);
});

test('sendable chunks 会保留非空段原样，并过滤纯空白段', async () => {
  const { toSendableMessageChunks } = await import('../../apps/web/src/lib/messageChunks');
  assert.deepEqual(
    toSendableMessageChunks('a' + ' '.repeat(20) + 'b', 10),
    ['a         ', ' b'],
  );
  assert.deepEqual(
    toSendableMessageChunks('        \n\n  next', 10),
    ['  next'],
  );
  assert.deepEqual(
    toSendableMessageChunks('```ts\nconst ok = true;\n```', 12).every((chunk) => chunk.length > 0),
    true,
  );
});

test('列表续行跨 chunk 时会补回原始两空格缩进', async () => {
  const { splitMessageForRocketChat } = await import('../../apps/web/src/lib/messageChunks');
  const text = '- item one\n  continuation text that is intentionally indented';
  const chunks = splitMessageForRocketChat(text, 24);
  assertWithinLimit(chunks, 24);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.slice(1).every((chunk) => chunk.startsWith('  ')), true);
  assert.equal(stripContinuationPrefix(chunks, '  '), text);
});

test('四空格代码行跨 chunk 时会补回原始缩进', async () => {
  const { splitMessageForRocketChat } = await import('../../apps/web/src/lib/messageChunks');
  const text = '    const deeplyIndentedCode = someVeryLongExpression + anotherCall()';
  const chunks = splitMessageForRocketChat(text, 24);
  assertWithinLimit(chunks, 24);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.slice(1).every((chunk) => chunk.startsWith('    ')), true);
  assert.equal(stripContinuationPrefix(chunks, '    '), text);
});

test('fenced block 内带缩进长行跨 chunk 时会同时保留 fence 与缩进', async () => {
  const { splitMessageForRocketChat } = await import('../../apps/web/src/lib/messageChunks');
  const text = '```txt\n    indented content that is intentionally long inside fence\n```';
  const chunks = splitMessageForRocketChat(text, 28);
  assertWithinLimit(chunks, 28);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks[0]?.startsWith('```txt\n'), true);
  assert.equal(chunks.slice(1).some((chunk) => chunk.startsWith('```txt\n    ')), true);
});
