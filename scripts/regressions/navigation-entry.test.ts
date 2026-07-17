import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MODULE_ORDER } from '../../apps/web/src/stores/ui';

test('Codex 是管家的执行间：保留可达性但不显示为侧栏入口', async () => {
  const [runtime, navRail, assistantPage, codexPage] = await Promise.all([
    readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/NavRail.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/AiAssistantPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/CodexPage.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(runtime, /\['ai-assistant', '管家', AiAssistantPage, Bot\]/);
  assert.match(runtime, /\['codex', 'Codex', CodexPage, TerminalSquare\]/);
  assert.match(navRail, /const AI_MODULE_IDS = new Set\(\['ai-assistant'\]\);/);
  assert.match(navRail, /const HIDDEN_MODULE_IDS = new Set\(\['codex'\]\);/);
  assert.match(navRail, /const visibleModules = modules\.filter\(\(module\) => !HIDDEN_MODULE_IDS\.has\(module\.key\)\);/);
  assert.match(assistantPage, /setModule\('codex'\)/);
  assert.match(assistantPage, /title="执行间" aria-label="执行间"/);
  assert.match(codexPage, />执行间<\/div>/);
  assert.match(codexPage, /管家的本地执行工房：在指定本地目录中运行 Codex 会话/);
  assert.ok(MODULE_ORDER.indexOf('ai-assistant') > MODULE_ORDER.indexOf('contacts'));
  assert.ok(MODULE_ORDER.indexOf('codex') > MODULE_ORDER.indexOf('ai-assistant'));
});
