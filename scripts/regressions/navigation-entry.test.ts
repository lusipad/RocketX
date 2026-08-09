import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MODULE_ORDER } from '../../apps/web/src/stores/ui';

test('全局左栏保留，管家内部工作面改由 ButlerPage/History 承载，不再暴露独立 codex 模块', async () => {
  const [runtime, navRail, page, history, conversation] = await Promise.all([
    readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/NavRail.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/ButlerPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerConversationHistory.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerConversation.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(runtime, /\['workbench', '工作台', WorkbenchModule, undefined\]/);
  assert.match(runtime, /\['butler-view', '管家', ButlerPage, Bell\]/);
  assert.doesNotMatch(runtime, /\['codex', 'Codex'/);
  assert.doesNotMatch(runtime, /CodexPage/);

  assert.match(navRail, /const PRIMARY_MODULE_IDS = new Set\(\['messages', 'todos', 'calendar', 'downloads'\]\);/);
  assert.match(navRail, /const WORK_MODULE_IDS = new Set\(\['workbench', 'contacts'\]\);/);
  assert.match(navRail, /const BUTLER_MODULE_IDS = new Set\(\['butler-view'\]\);/);
  assert.match(navRail, /id: 'butler',[\s\S]*ariaLabel: '管家'/);
  assert.doesNotMatch(navRail, /['"]codex['"]/);
  assert.doesNotMatch(navRail, /['"]today['"]/);
  assert.doesNotMatch(navRail, /['"]ai-assistant['"]/);

  assert.match(page, /className="butler-workspace"/);
  assert.match(page, /<ButlerConversation embedded \/>/);
  assert.match(page, /<ButlerPluginsPage \/>/);
  assert.match(page, /<ButlerRoutines \/>/);

  assert.match(history, /aria-label="Codex 工作区"/);
  assert.match(history, /aria-label="新对话"/);
  assert.match(history, /aria-label="Codex 对话历史"/);
  assert.doesNotMatch(history, /aria-label="任务"/);
  assert.match(history, /setWorkbenchTab\('prs'\)/);
  assert.match(history, /setModule\('workbench'\)/);
  assert.match(history, /setButlerView\('routines'\)/);
  assert.match(history, /setButlerView\('plugins'\)/);
  assert.match(history, /选择工作区/);

  assert.match(conversation, /在 Codex 中打开/);
  assert.doesNotMatch(conversation, /setModule\('codex'\)/);

  assert.deepEqual(MODULE_ORDER, [
    'messages',
    'workbench',
    'butler-view',
    'todos',
    'calendar',
    'downloads',
    'contacts',
    'settings',
  ]);
});
