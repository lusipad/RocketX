import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RcMessage, RcRoom, RcSubscription } from '../../packages/rc-client/src';
import {
  buildConversations,
  localQuoteAttachment,
} from '../../apps/web/src/stores/chat';
import {
  shouldInsertNewline,
  shouldSendMessage,
} from '../../apps/web/src/lib/sendKeys';
import { findQuoteImage } from '../../apps/web/src/lib/messageQuote';

test('默认发送方式只让无修饰的 Enter 发送，Alt+Enter 保留为换行', () => {
  for (const path of ['apps/web/src/components/Composer.tsx', 'apps/web/src/components/ThreadPanel.tsx']) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /prefsLoaded \? sendOnEnter : 'normal'/, `${path} 加载偏好前也必须使用默认 Enter 发送`);
  }
  assert.equal(
    shouldSendMessage('normal', {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }),
    true,
  );
  assert.equal(
    shouldSendMessage('normal', {
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }),
    false,
  );
  assert.equal(
    shouldInsertNewline('normal', {
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }),
    true,
  );
  assert.equal(
    shouldSendMessage('alternative', {
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }),
    true,
  );
});

test('本地引用附件保留原消息首张图片', () => {
  const quoted: RcMessage = {
    _id: 'message',
    rid: 'room',
    msg: '请看截图',
    ts: '2026-07-16T00:00:00.000Z',
    u: { _id: 'user', username: 'zhangsan', name: '张三' },
    attachments: [
      {
        title: '问题.png',
        image_url: '/file-upload/thumb',
        title_link: '/file-upload/original',
        image_dimensions: { width: 800, height: 600 },
      },
    ],
  };

  assert.deepEqual(localQuoteAttachment(quoted), {
    message_link: 'local-quote',
    author_name: '张三',
    text: '请看截图',
    ts: quoted.ts,
    image_url: '/file-upload/thumb',
    image_dimensions: { width: 800, height: 600 },
    title: '问题.png',
    title_link: '/file-upload/original',
  });
});

test('服务端展开引用后可以从嵌套附件找到原图片', () => {
  assert.deepEqual(
    findQuoteImage({
      message_link: 'http://localhost/channel/general?msg=message',
      text: '请看截图',
      attachments: [
        {
          title: '问题.png',
          image_url: '/file-upload/thumb',
          title_link: '/file-upload/original',
        },
      ],
    }),
    {
      title: '问题.png',
      image_url: '/file-upload/thumb',
      title_link: '/file-upload/original',
    },
  );
});

test('隐藏会话默认不混入消息列表，只在显式请求时返回并标记', () => {
  const subscriptions = {
    visible: {
      _id: 'visible-sub',
      rid: 'visible',
      name: 'visible',
      t: 'c',
      unread: 0,
      alert: false,
      open: true,
    },
    hidden: {
      _id: 'hidden-sub',
      rid: 'hidden',
      name: 'hidden',
      t: 'c',
      unread: 0,
      alert: false,
      open: false,
    },
  } as unknown as Record<string, RcSubscription>;
  const rooms = {} as Record<string, RcRoom>;

  assert.deepEqual(buildConversations(subscriptions, rooms).map((item) => item.rid), ['visible']);
  assert.deepEqual(
    buildConversations(subscriptions, rooms, true).map((item) => [item.rid, item.hidden]),
    [
      ['visible', false],
      ['hidden', true],
    ],
  );
});
