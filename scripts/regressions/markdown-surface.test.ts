import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown, renderMarkdownDoc } from '../../apps/web/src/lib/markdown';

(globalThis as Record<string, unknown>).React = React;

test('完整 Markdown 渲染入口输出稳定 root class 与 variant', () => {
  const chat = renderToStaticMarkup(
    renderMarkdown('# 标题\n\n正文和 `code`') as React.ReactElement,
  );
  const doc = renderToStaticMarkup(
    renderMarkdownDoc('# 文档标题\n\n正文') as React.ReactElement,
  );

  assert.match(chat, /^<div class="rocketx-markdown rocketx-markdown--chat" data-variant="chat">/);
  assert.match(chat, /<h1/);
  assert.match(chat, /<code/);
  assert.match(doc, /^<div class="rocketx-markdown rocketx-markdown--doc" data-variant="doc">/);
  assert.match(doc, /<h1/);
});

test('Markdown 基础排版绑定到 renderer root，而不是 Butler 外层类', () => {
  const styles = readFileSync('apps/web/src/styles.css', 'utf8');

  assert.match(styles, /\.rocketx-markdown\s*\{/);
  assert.match(styles, /\.rocketx-markdown--doc\s*\{/);
  assert.match(styles, /\.rocketx-markdown > :is\(h1, h2, h3, h4, h5, h6\)/);
  assert.match(styles, /\.rocketx-markdown > pre/);
  assert.match(styles, /\.rocketx-markdown blockquote/);
  assert.match(styles, /\.rocketx-markdown > div:has\(> table\)/);
  assert.doesNotMatch(styles, /\.butler-conversation-markdown > :is\(h1, h2, h3, h4, h5, h6\)/);
});
