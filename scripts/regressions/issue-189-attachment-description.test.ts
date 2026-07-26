import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RcMessage, RcMessageAttachment } from '../../packages/rc-client/src/types';
import { AttachmentCard } from '../../apps/web/src/components/MessageItem';

(globalThis as Record<string, unknown>).React = React;

const attachment: RcMessageAttachment = {
  image_url: '/file-upload/image.png',
  description: '现场照片 https://example.com/details',
};

function message(msg: string): RcMessage {
  return {
    _id: 'message-1',
    rid: 'room-1',
    msg,
    ts: '2026-07-26T00:00:00.000Z',
    u: { _id: 'user-1', username: 'zhangsan' },
    attachments: [attachment],
  };
}

function render(msg: string): string {
  return renderToStaticMarkup(
    React.createElement(AttachmentCard, {
      att: attachment,
      message: message(msg),
      source: { rid: 'room-1', roomName: '项目群', messageId: 'message-1' },
    }),
  );
}

test('收到只有附件说明的图片消息时显示正文和可点击链接（issue #189）', () => {
  const html = render('');

  assert.match(html, /现场照片/);
  assert.match(html, /href="https:\/\/example\.com\/details"/);
});

test('消息正文与附件说明并存时只显示消息正文', () => {
  assert.doesNotMatch(render('现场照片'), /现场照片/);
});
