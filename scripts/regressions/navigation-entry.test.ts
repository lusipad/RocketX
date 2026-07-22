import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MODULE_ORDER } from '../../apps/web/src/stores/ui';

test('Codex 是管家的执行间：保留可达性但不显示为侧栏入口', async () => {
  const [runtime, navRail, conversation, codexPage] = await Promise.all([
    readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/NavRail.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerConversation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/CodexPage.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(runtime, /\['butler-view', '管家', ButlerPage, Bell\]/);
  assert.doesNotMatch(runtime, /TodayPage|AiAssistantPage|'today'|'ai-assistant'/);
  assert.match(runtime, /\['codex', 'Codex', CodexPage, TerminalSquare\]/);
  assert.match(navRail, /const PRIMARY_MODULE_IDS = new Set\(\['messages', 'butler-view', 'todos', 'calendar', 'downloads'\]\);/);
  assert.doesNotMatch(navRail, /AI_MODULE_IDS|'today'|'ai-assistant'/);
  assert.match(navRail, /const HIDDEN_MODULE_IDS = new Set\(\['codex'\]\);/);
  assert.match(navRail, /const visibleModules = modules\.filter\(\(module\) => !HIDDEN_MODULE_IDS\.has\(module\.key\)\);/);
  assert.match(conversation, /setModule\('codex'\)/);
  assert.match(conversation, /title="执行间"/);
  assert.match(conversation, /aria-label="执行间"/);
  assert.match(codexPage, />执行间<\/div>/);
  assert.match(codexPage, /AI 的本地执行区：在指定本地目录中运行 Codex 会话/);
  assert.deepEqual(MODULE_ORDER, [
    'messages',
    'butler-view',
    'todos',
    'calendar',
    'downloads',
    'workbench',
    'contacts',
    'codex',
    'settings',
  ]);
});
