import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MODULE_ORDER } from '../../apps/web/src/stores/ui';

test('管家今日纸与确定性工作台保持独立入口，执行间仍只保留快捷通路', async () => {
  const [runtime, navRail, workbenchPage, conversation, codexPage] = await Promise.all([
    readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/NavRail.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/WorkbenchPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerConversation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/CodexPage.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(runtime, /\['butler-view', '管家', ButlerPage, Bell\]/);
  assert.match(runtime, /\['workbench', '工作台', WorkbenchModule, undefined\]/);
  assert.match(runtime, /connected \? <WorkbenchPage \/> : <SettingsPage initialSection="workbench" \/>/);
  assert.doesNotMatch(runtime, /TodayPage|AiAssistantPage|'today'|'ai-assistant'/);
  assert.match(runtime, /\['codex', 'Codex', CodexPage, TerminalSquare\]/);
  assert.match(navRail, /workbench: \{ label: '工作台', icon: LayoutGrid \}/);
  assert.match(navRail, /const PRIMARY_MODULE_IDS = new Set\(\['messages', 'todos', 'calendar', 'downloads'\]\);/);
  assert.match(navRail, /const WORK_MODULE_IDS = new Set\(\['workbench', 'contacts'\]\);/);
  assert.match(navRail, /const BUTLER_MODULE_IDS = new Set\(\['butler-view'\]\);/);
  assert.match(navRail, /id: 'butler',[\s\S]*?ariaLabel: '管家',[\s\S]*?BUTLER_MODULE_IDS\.has\(module\.key\)/);
  assert.match(workbenchPage, />工作台<\/div>/);
  assert.match(workbenchPage, /key: 'overview', label: '概览'/);
  assert.doesNotMatch(navRail, /AI_MODULE_IDS|'today'|'ai-assistant'/);
  assert.match(navRail, /const HIDDEN_MODULE_IDS = new Set\(\['codex'\]\);/);
  assert.match(navRail, /const visibleModules = modules\.filter\(\(module\) => !HIDDEN_MODULE_IDS\.has\(module\.key\)\);/);
  assert.doesNotMatch(conversation, /setModule\('codex'\)/);
  assert.doesNotMatch(conversation, /aria-label="执行间"/);
  assert.match(conversation, /在 Codex App 打开/);
  assert.match(codexPage, />执行间<\/div>/);
  assert.match(codexPage, /AI 的本地执行区：在指定本地目录中运行 Codex 会话/);
  assert.deepEqual(MODULE_ORDER, [
    'messages',
    'workbench',
    'butler-view',
    'todos',
    'calendar',
    'downloads',
    'contacts',
    'codex',
    'settings',
  ]);
});
