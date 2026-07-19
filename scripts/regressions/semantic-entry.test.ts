import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { AI_CAPABILITIES } from '../../apps/web/src/kernel/ai/config';

test('embedding 语义搜索已整体移除，「语义搜索」由问管家承担（issue #95）', () => {
  // 向量索引与运行时不复存在，能力清单里没有语义搜索
  assert.equal(existsSync('apps/web/src/kernel/ai/semantic-search.ts'), false);
  assert.equal(existsSync('apps/web/src/kernel/ai/semantic-runtime.ts'), false);
  assert.equal(AI_CAPABILITIES.some(({ id }) => (id as string) === 'semantic-search'), false);

  // Provider 配置与总线不再有 embedding 概念
  for (const path of [
    'apps/web/src/kernel/ai/config.ts',
    'apps/web/src/kernel/ai/provider.ts',
    'apps/web/src/kernel/ai/bus.ts',
    'apps/web/src/kernel/ai/openai-compatible.ts',
    'apps/web/src/components/AiSettings.tsx',
  ]) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /embed/iu, path);
  }

  // 搜索框不再有向量语义模式，「问管家」打开桌面对话并交给同一管家大脑
  const switcher = readFileSync('apps/web/src/components/QuickSwitcher.tsx', 'utf8');
  assert.doesNotMatch(switcher, /semanticMode|SemanticSearchIndex/);
  assert.match(switcher, /问管家/);
  assert.match(switcher, /useButler\.getState\(\)\.ask\(query\)/);
  assert.match(switcher, /openButlerConversation\(\)/);
  assert.doesNotMatch(switcher, /setModule\('ai-assistant'\)/);
});
