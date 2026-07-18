import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src';
import { messagesToMarkdown } from '../../apps/web/src/lib/messageOutput';
import { mergedForwardAttachments } from '../../apps/web/src/lib/forward';

const messages: RcMessage[] = [
  {
    _id: 'later',
    rid: 'room',
    msg: '第二条',
    ts: '2026-07-16T01:01:00.000Z',
    u: { _id: 'u2', username: 'lisi', name: '李四' },
    attachments: [
      {
        title: '截图.png',
        image_url: '/file-upload/thumb',
        title_link: '/file-upload/original',
      },
    ],
  },
  {
    _id: 'earlier',
    rid: 'room',
    msg: '第一条 **富文本**',
    ts: '2026-07-16T01:00:00.000Z',
    u: { _id: 'u1', username: 'zhangsan', name: '张三' },
  },
];

test('多条消息输出按时间排序、保留富内容且不泄露发送人', () => {
  const markdown = messagesToMarkdown(messages);
  assert.ok(markdown.indexOf('第一条') < markdown.indexOf('第二条'));
  assert.match(markdown, /\*\*富文本\*\*/);
  assert.match(markdown, /!\[截图\.png\]\(\/file-upload\/thumb\)/);
  assert.doesNotMatch(markdown, /张三|zhangsan|李四|lisi/);
});

test('复制和导出托管消息时不包含内部租约标记', () => {
  const markdown = messagesToMarkdown([{
    ...messages[0],
    msg: '🤖 **AI 托管已开启**\n<!--rocketx-agent:%7B%22hostDeviceId%22%3A%22device%22%7D-->',
  }]);
  assert.match(markdown, /AI 托管已开启/);
  assert.doesNotMatch(markdown, /rocketx-agent|hostDeviceId|%22/);
});

test('合并转发保留每条内容但不附带用户名', () => {
  const attachments = mergedForwardAttachments(
    messages.map((message) => ({
      text: message.msg,
      ts: message.ts,
      attachments: message.attachments,
    })),
  );
  assert.equal(attachments[0]?.text, '第一条 **富文本**');
  assert.equal(attachments[0]?.author_name, undefined);
  assert.equal(attachments[1]?.text, '第二条');
  assert.equal(attachments[1]?.author_name, undefined);
});
