import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Avatar from '../../apps/web/src/components/Avatar';

(globalThis as Record<string, unknown>).React = React;

test('用户头像优先使用用户名路径', () => {
  const html = renderToStaticMarkup(
    React.createElement(Avatar, { name: '张三', username: 'zhangsan', roomId: 'room-1' }),
  );
  assert.match(html, /\/avatar\/zhangsan\?size=80/);
  assert.doesNotMatch(html, /\/avatar\/room\//);
});

test('群聊头像使用 Rocket.Chat 房间头像路径', () => {
  const html = renderToStaticMarkup(
    React.createElement(Avatar, { name: '项目群', roomId: 'room-1' }),
  );
  assert.match(html, /\/avatar\/room\/room-1\?size=80/);
});
