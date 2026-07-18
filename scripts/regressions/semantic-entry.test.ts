import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('没有 embedding 模型时隐藏语义搜索入口，改给「问 AI」（issue #95）', () => {
  // 可用性检测：语义搜索能力路由到带 embedding 模型的 Provider 才算可用
  const runtime = readFileSync('apps/web/src/kernel/ai/semantic-runtime.ts', 'utf8');
  assert.match(runtime, /export function semanticSearchAvailable\(\): boolean/);
  assert.match(runtime, /describeEmbedding\('semantic-search'\)/);

  const switcher = readFileSync('apps/web/src/components/QuickSwitcher.tsx', 'utf8');
  // 语义按钮受可用性开关控制，不再无条件渲染
  assert.match(switcher, /\{semanticAvailable && \(/);
  assert.match(switcher, /semanticSearchAvailable\(\)/);
  // 只有对话大模型的用户走「问 AI」：查询交给 AI 大脑调用工具回答
  assert.match(switcher, /问 AI/);
  assert.match(switcher, /useButler\.getState\(\)\.ask\(query\)/);
  assert.match(switcher, /setModule\('ai-assistant'\)/);
});
