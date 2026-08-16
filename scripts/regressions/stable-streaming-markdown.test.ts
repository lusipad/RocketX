import assert from 'node:assert/strict';
import test from 'node:test';
import { splitStableStreamingMarkdown } from '../../apps/web/src/lib/markdown';

test('稳定流式 Markdown 只推进尾块，已封口段落保持固定起点', () => {
  const first = splitStableStreamingMarkdown('## 结论\n\n正在输出');
  const next = splitStableStreamingMarkdown('## 结论\n\n正在输出更多内容');

  assert.deepEqual(first, [
    { start: 0, text: '## 结论\n\n', mode: 'rich', sealed: true },
    { start: 7, text: '正在输出', mode: 'rich', sealed: false },
  ]);
  assert.deepEqual(next[0], first[0]);
  assert.equal(next[1]?.start, first[1]?.start);
  assert.equal(next[1]?.text, '正在输出更多内容');
});

test('未闭合代码围栏保持纯文本，闭合后只完成当前块', () => {
  const open = splitStableStreamingMarkdown('前言\n\n```ts\nconst value = 1;\n');
  assert.equal(open.length, 2);
  assert.deepEqual(open[0], { start: 0, text: '前言\n\n', mode: 'rich', sealed: true });
  assert.equal(open[1]?.mode, 'plain');
  assert.equal(open[1]?.sealed, false);

  const closed = splitStableStreamingMarkdown('前言\n\n```ts\nconst value = 1;\n```\n');
  assert.deepEqual(closed[0], open[0]);
  assert.equal(closed[1]?.start, open[1]?.start);
  assert.equal(closed[1]?.mode, 'rich');
  assert.equal(closed[1]?.sealed, true);
});

test('代码围栏和数学块内部的空行不会提前拆块', () => {
  const code = splitStableStreamingMarkdown('```\nline 1\n\nline 2');
  assert.equal(code.length, 1);
  assert.equal(code[0]?.mode, 'plain');

  const math = splitStableStreamingMarkdown('$$\na + b\n\nc + d');
  assert.equal(math.length, 1);
  assert.equal(math[0]?.mode, 'plain');

  const closedMath = splitStableStreamingMarkdown('$$\na + b\n\nc + d\n$$\n');
  assert.equal(closedMath.length, 1);
  assert.equal(closedMath[0]?.mode, 'rich');
  assert.equal(closedMath[0]?.sealed, true);
});

test('代码或数学块开始时先封口前一段，不把稳定正文退回纯文本', () => {
  const code = splitStableStreamingMarkdown('前一段\n```ts\nconst value = 1;');
  assert.deepEqual(code.map(({ start, mode, sealed }) => ({ start, mode, sealed })), [
    { start: 0, mode: 'rich', sealed: true },
    { start: 4, mode: 'plain', sealed: false },
  ]);

  const math = splitStableStreamingMarkdown('前一段\n$$\na + b');
  assert.deepEqual(math.map(({ start, mode, sealed }) => ({ start, mode, sealed })), [
    { start: 0, mode: 'rich', sealed: true },
    { start: 4, mode: 'plain', sealed: false },
  ]);
});
