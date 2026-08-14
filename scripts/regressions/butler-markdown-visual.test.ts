import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from '../../apps/web/src/lib/markdown';

(globalThis as Record<string, unknown>).React = React;

test('管家富 Markdown 保留完整块级语义', () => {
  const html = renderToStaticMarkup(renderMarkdown([
    '# 结论',
    '',
    '正文包含 **重点**、`inline()` 和 [链接](https://example.com)。',
    '',
    '> 这是引用说明。',
    '',
    '- [x] 已完成',
    '- 普通列表',
    '',
    '| 项目 | 状态 |',
    '| --- | --- |',
    '| RocketX | 正常 |',
    '',
    '```ts',
    'const ready = true;',
    '```',
  ].join('\n')) as React.ReactElement);

  assert.match(html, /<h1/);
  assert.match(html, /<blockquote/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*checked=""/);
  assert.match(html, /<table/);
  assert.match(html, /markdown-table-wrap/);
  assert.match(html, /markdown-list-item/);
  assert.match(html, /<pre class="markdown-code-block/);
  assert.match(html, /<code/);
  assert.match(html, /target="_blank" rel="noreferrer"/);
  assert.match(html, /^<div class="rocketx-markdown rocketx-markdown--chat" data-variant="chat">/);
});
