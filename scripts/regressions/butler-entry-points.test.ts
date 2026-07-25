import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

test('单条消息右键有「交给管家」，忙碌时给提示而不是静默无反应', () => {
  const item = source('apps/web/src/components/MessageItem.tsx');
  assert.match(item, /label: '交给管家'/);
  assert.match(item, /askButlerAboutMessages\(/);
  // ask 在 running 时静默 return，入口必须自己挡并提示
  assert.match(item, /result === 'busy'/);
  // MessageItem 每条消息一个实例：不得订阅 butler store 的 running
  assert.doesNotMatch(item, /useButler\(/);
});

test('多选工具条的两个管家入口带禁用态并退出多选', () => {
  const list = source('apps/web/src/components/MessageList.tsx');
  assert.match(list, /提取承诺/);
  assert.match(list, /总结这段/);
  assert.match(list, /selectedMessages\.length === 0 \|\| butlerRunning/);
  assert.match(list, /exitSelectMode\(\)/);
});

test('PR 行拆出独立按钮：整行不再是链接，避免按钮点击冒泡开外链', () => {
  const lists = source('apps/web/src/components/AdoLists.tsx');
  assert.match(lists, /function PrRow\(\{ pr, onAsk \}/);
  assert.match(lists, /askButlerAboutPullRequests\(/);
  // 外层容器必须是 div；若又变回 <a ... group flex 整行链接>，按钮会失效
  assert.match(lists, /<div className="group flex items-center border-b/);
});

test('空状态给场景例句与能力边界，且例句只填输入框不直接发送', () => {
  for (const path of [
    'apps/web/src/components/ButlerConversation.tsx',
    'apps/web/src/components/ButlerPanel.tsx',
  ]) {
    const text = source(path);
    assert.match(text, /BUTLER_SCENE_PROMPTS/, path);
    assert.match(text, /BUTLER_BOUNDARY_NOTE/, path);
    assert.match(text, /onClick=\{\(\) => setInput\(item\.prompt\)\}/, path);
  }
});

test('WELCOME_TEXT 未被改动：它同时被剥离逻辑、动作条与多个回归硬编码依赖', () => {
  const store = source('apps/web/src/stores/butler.ts');
  assert.match(store, /const WELCOME_TEXT = '我是你的管家/);
  // 精确相等剥离欢迎语的逻辑必须还在，否则欢迎语会被喂进模型 transcript
  assert.match(store, /lines\[0\]\.text === WELCOME_TEXT/);
});

test('管家面板滚动依赖包含 steps，等待期可见化才会贴底', () => {
  const panel = source('apps/web/src/components/ButlerPanel.tsx');
  assert.match(panel, /\}, \[lines, steps, activity, error/);
});
