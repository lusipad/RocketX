import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Avatar from '../../apps/web/src/components/Avatar';

const source = readFileSync('apps/web/src/components/ChatArea.tsx', 'utf8');

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test('私聊头部头像订阅并显示对方在线状态', () => {
  assert.match(source, /const peerStatus = useChat\(/);
  assert.match(
    source,
    /<Avatar[\s\S]*?username=\{avatarUsername\}[\s\S]*?status=\{peerStatus\}[\s\S]*?\/>/,
  );
});

test('多人私聊不会把某个成员当成头部状态对象', () => {
  assert.match(
    source,
    /const avatarUsername = sub\?\.t === ['"]d['"] && !isMultiDM \? sub\.name : undefined/,
  );
  assert.match(source, /avatarUsername \? s\.userStatus\[avatarUsername\] : undefined/);
});

test('离线状态渲染灰色状态点和离线提示', () => {
  const html = renderToStaticMarkup(
    React.createElement(Avatar, {
      name: '李四',
      username: 'lisi',
      size: 36,
      status: 'offline',
    }),
  );

  assert.match(html, /background:#8a9099/);
  assert.match(html, /title="离线"/);
});

test('在线状态渲染绿色状态点和在线提示', () => {
  const html = renderToStaticMarkup(
    React.createElement(Avatar, {
      name: 'Rocket.Cat',
      username: 'rocket.cat',
      size: 36,
      status: 'online',
    }),
  );

  assert.match(html, /background:#00b96b/);
  assert.match(html, /title="在线"/);
});
