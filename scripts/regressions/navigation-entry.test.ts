import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MODULE_ORDER } from '../../apps/web/src/stores/ui';

test('AI 助手和 Codex 是独立一级入口', async () => {
  const runtime = await readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8');
  assert.match(runtime, /\['ai-assistant', 'AI 助手', AiAssistantPage, Sparkles\]/);
  assert.match(runtime, /\['codex', 'Codex', CodexPage, TerminalSquare\]/);
  assert.ok(MODULE_ORDER.indexOf('codex') > MODULE_ORDER.indexOf('today'));
  assert.ok(MODULE_ORDER.indexOf('codex') < MODULE_ORDER.indexOf('ai-assistant'));
});
