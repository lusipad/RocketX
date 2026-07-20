import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/types';
import { messageImagePath } from '../../apps/web/src/lib/imageClipboard';
import { quoteMessagePrefix } from '../../apps/web/src/lib/messageText';

const message = (patch: Partial<RcMessage>): RcMessage => ({
  _id: 'message-1',
  rid: 'room-1',
  msg: '',
  ts: '2026-07-18T00:00:00.000Z',
  u: { _id: 'user-1', username: 'zhangsan' },
  ...patch,
});

test('图片消息取原图路径复制，非图片消息返回 null', () => {
  assert.equal(
    messageImagePath(message({
      attachments: [{ image_url: '/file-upload/x/thumb.png', title_link: '/file-upload/x/image.png' }],
    })),
    '/file-upload/x/image.png',
  );
  assert.equal(
    messageImagePath(message({ attachments: [{ image_url: '/file-upload/x/image.png' }] })),
    '/file-upload/x/image.png',
  );
  assert.equal(messageImagePath(message({ msg: '纯文本' })), null);
  assert.equal(
    messageImagePath(message({ attachments: [{ title_link: '/file-upload/x/doc.pdf' }] })),
    null,
  );
});

test('复制图片消息写入位图剪贴板，非图片或不支持时回退文本（issue #92）', () => {
  const item = readFileSync('apps/web/src/components/MessageItem.tsx', 'utf8');
  assert.match(item, /copyMessageImage\(message, \(path\) => rest\.fetchFile\(path\)\)/);
  assert.match(item, /messagesToMarkdown\(\[message\]\)/);
  const lib = readFileSync('apps/web/src/lib/imageClipboard.ts', 'utf8');
  assert.match(lib, /new ClipboardItem\(\{ 'image\/png': fetchFile\(path\)\.then\(toPngBlob\) \}\)/);
});

test('用图片/文件回复时引用跟随第一个上传发出，话题上传不消费引用（issue #91）', () => {
  const chat = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  // uploadFiles 与 uploadNativeFiles 两条上传路径都要消费引用
  assert.equal(chat.match(/const quote = !tmid \? get\(\)\.replyTo : null;/gu)?.length, 2);
  assert.equal(
    chat.match(/quoteLinkPrefix\(quote, get\(\)\.subscriptions, await ensureSiteUrl\(\)\)/gu)?.length,
    2,
  );
  assert.equal(chat.match(/index === 0 && quoteMsg \? \{ msg: quoteMsg \}/gu)?.length, 2);
  // 挂着引用时不走局域网直传（那条链路带不了引用）
  assert.match(chat, /if \(!tmid && !quoteMsg\) \{/);
  // 发送确认弹窗要让用户知道这是一条回复
  const dialog = readFileSync('apps/web/src/components/UploadConfirm.tsx', 'utf8');
  assert.match(dialog, /将作为回复发送/);
});

test('引用链接与正文用空格连接，和真实服务冒烟路径保持一致（issue #126）', () => {
  assert.equal(
    quoteMessagePrefix('https://chat.example/channel/general?msg=message-1'),
    '[ ](https://chat.example/channel/general?msg=message-1) ',
  );
});
