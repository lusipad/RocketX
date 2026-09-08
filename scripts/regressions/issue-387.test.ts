import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteAttachmentText } from '../../apps/web/src/lib/messageQuote';

const prefix = '[ ](https://chat.example/channel/general?msg=original) ';

test('连续回复的引用卡片不显示内部引用链接', () => {
  for (const depth of [1, 2, 3, 5]) {
    assert.equal(
      quoteAttachmentText({ text: prefix.repeat(depth) + '上一条回复正文' }),
      '上一条回复正文',
    );
  }
});

test('仅含引用前缀时继续显示嵌套附件正文', () => {
  assert.equal(
    quoteAttachmentText({
      text: prefix,
      attachments: [{ text: prefix + '更早的回复正文' }],
    }),
    '更早的回复正文',
  );
  assert.equal(quoteAttachmentText({ text: prefix }), undefined);
});

test('引用正文保留用户发送的普通链接', () => {
  const body = '参考 [文档](https://example.com) https://example.com/page';
  assert.equal(quoteAttachmentText({ text: prefix + body }), body);
  assert.equal(quoteAttachmentText({ text: 'https://example.com' }), 'https://example.com');
});
