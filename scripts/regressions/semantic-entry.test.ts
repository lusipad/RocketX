import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('embedding 语义搜索已整体移除，搜索入口改为创建 Codex 任务（issue #95）', () => {
  assert.equal(existsSync('apps/web/src/kernel/ai/semantic-search.ts'), false);
  assert.equal(existsSync('apps/web/src/kernel/ai/semantic-runtime.ts'), false);

  for (const path of [
    'apps/web/src/kernel/ai/config.ts',
    'apps/web/src/kernel/ai/provider.ts',
    'apps/web/src/kernel/ai/bus.ts',
    'apps/web/src/kernel/ai/openai-compatible.ts',
    'apps/web/src/kernel/ai/features/structured-output.ts',
    'apps/web/src/kernel/ai/features/message-extraction.ts',
  ]) {
    assert.equal(existsSync(path), false, path);
  }
  assert.equal(existsSync('apps/web/src/agent/structuredOutput.ts'), true);
  assert.equal(existsSync('apps/web/src/agent/messageActionExtraction.ts'), true);
  assert.doesNotMatch(readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8'), /Provider|能力路由|embed/iu);

  const switcher = readFileSync('apps/web/src/components/QuickSwitcher.tsx', 'utf8');
  assert.doesNotMatch(switcher, /semanticMode|SemanticSearchIndex/);
  assert.match(switcher, /handoffToCodexTask\(query, `搜索 · \$\{query\}`\)/);
  assert.match(switcher, /创建 Codex 任务，并由 Skills 或 Apps 查找真实信息/);
  assert.doesNotMatch(switcher, /useButler\.getState\(\)\.ask\(query\)/);
  assert.doesNotMatch(switcher, /setModule\('ai-assistant'\)/);
});
