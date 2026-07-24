import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from '../../apps/web/src/lib/markdown';
import {
  splitBlockMath,
  splitInlineMath,
  type MarkdownMathSegment,
} from '../../apps/web/src/lib/markdownMath';

(globalThis as Record<string, unknown>).React = React;

const math = (segments: MarkdownMathSegment[]) =>
  segments.filter((segment) => segment.kind === 'math');

test('Issue #218 的精确正文识别为两个块公式', () => {
  const body = [
    '[',
    'S_{\\text{eff}}=S_{\\max}',
    ']',
    '',
    '[',
    'F_{\\text{eff}}=P\\times S_{\\text{eff}}',
    ']',
  ].join('\n');

  assert.deepEqual(math(splitBlockMath(body)), [
    { kind: 'math', value: 'S_{\\text{eff}}=S_{\\max}', display: true },
    { kind: 'math', value: 'F_{\\text{eff}}=P\\times S_{\\text{eff}}', display: true },
  ]);
});

test('标准块公式分隔符识别为显示公式', () => {
  const segments = splitBlockMath('$$\nE=mc^2\n$$\n\\[\na^2+b^2=c^2\n\\]');

  assert.deepEqual(math(segments), [
    { kind: 'math', value: 'E=mc^2', display: true },
    { kind: 'math', value: 'a^2+b^2=c^2', display: true },
  ]);
});

test('标准行内公式分隔符识别为行内公式', () => {
  const segments = splitInlineMath('动能是 $E=mc^2$，也可以写成 \\(E=mc^2\\)。');

  assert.deepEqual(math(segments), [
    { kind: 'math', value: 'E=mc^2', display: false },
    { kind: 'math', value: 'E=mc^2', display: false },
  ]);
});

test('普通方括号和未闭合公式保持文本', () => {
  assert.deepEqual(splitBlockMath('[先看这个版本]'), [
    { kind: 'text', value: '[先看这个版本]' },
  ]);
  assert.deepEqual(splitInlineMath('这里有个半截公式 $E=mc^2'), [
    { kind: 'text', value: '这里有个半截公式 $E=mc^2' },
  ]);
});

test('货币文本不会被跨段误识别为公式', () => {
  assert.deepEqual(splitInlineMath('原价 $5，折后 $4。'), [
    { kind: 'text', value: '原价 $5，折后 $4。' },
  ]);
});

test('转义美元和行内代码中的公式保持文本', () => {
  const segments = splitInlineMath('价格是 \\$5，代码是 `$x$`，公式是 $y$。');

  assert.deepEqual(math(segments), [
    { kind: 'math', value: 'y', display: false },
  ]);
  assert.equal(
    segments.filter((segment) => segment.kind === 'text').map((segment) => segment.value).join(''),
    '价格是 \\$5，代码是 `$x$`，公式是 。',
  );
});

test('Markdown 链接和工作项引用保持现有渲染合同', () => {
  const markup = renderToStaticMarkup(
    renderMarkdown('[公式 $x$](https://example.com) 和工作项 #123') as React.ReactElement,
  );

  assert.match(markup, /href="https:\/\/example\.com"/);
  assert.match(markup, />公式 \$x\$<\/a>/);
  assert.match(markup, />#123<\/span>/);
  assert.doesNotMatch(markup, /data-rocketx-math=/);
});

test('Markdown 消费路径输出安全公式容器，代码围栏仍保持原样', () => {
  const formula = renderToStaticMarkup(
    renderMarkdown('$$\nE=mc^2\n$$ 与 $x$') as React.ReactElement,
  );
  const code = renderToStaticMarkup(
    renderMarkdown('```\n$$\nE=mc^2\n$$\n```') as React.ReactElement,
  );

  assert.equal((formula.match(/data-rocketx-math="display"/g) ?? []).length, 1);
  assert.equal((formula.match(/data-rocketx-math="inline"/g) ?? []).length, 1);
  assert.doesNotMatch(code, /data-rocketx-math=/);
  assert.match(code, /<pre[^>]*>\$\$\nE=mc\^2\n\$\$<\/pre>/);
});
