import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteAttachmentText } from '../../apps/web/src/lib/messageQuote';

test('引用附件优先显示原消息正文', () => {
  assert.equal(
    quoteAttachmentText({
      message_link: 'https://chat.example/channel/general?msg=message',
      text: '原消息正文',
      attachments: [{ title: '不应覆盖正文.pdf' }],
    }),
    '原消息正文',
  );
});

test('原消息正文为空时显示嵌套卡片内容', () => {
  assert.equal(
    quoteAttachmentText({
      message_link: 'https://chat.example/channel/general?msg=message',
      text: '',
      attachments: [
        {
          title: '构建失败',
          text: 'main · #128',
          fields: [{ title: '状态', value: '失败' }],
        },
      ],
    }),
    '构建失败\nmain · #128\n状态：失败',
  );
});

test('嵌套文件标题也能作为引用内容显示', () => {
  assert.equal(
    quoteAttachmentText({
      message_link: 'https://chat.example/channel/general?msg=message',
      attachments: [{ title: '项目计划书.pdf', title_link_download: true }],
    }),
    '项目计划书.pdf',
  );
});
