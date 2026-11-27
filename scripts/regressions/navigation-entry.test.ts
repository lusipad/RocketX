import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';
import { MODULE_ORDER } from '../../apps/web/src/stores/ui';

test('全局左栏保留，管家内部工作面改由 ButlerPage/History 承载，不再暴露独立 codex 模块', async () => {
  const [runtime, navRail, workbench, page, history, conversation] = await Promise.all([
    readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/NavRail.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/WorkbenchPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/ButlerPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerConversationHistory.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerConversation.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(runtime, /\['workbench', t\('settings\.kernel\.module\.workbench'\), WorkbenchModule, undefined\]/);
  assert.equal(zhCN['settings.kernel.module.workbench'], '工作台');
  assert.ok(enUS['settings.kernel.module.workbench'].length > 0);
  assert.doesNotMatch(runtime, /ProfileContributionsModule|\['contributions'/);
  assert.match(runtime, /\['butler-view', t\('settings\.kernel\.module\.butler'\), ButlerPage, Bell\]/);
  assert.equal(zhCN['settings.kernel.module.butler'], '管家');
  assert.ok(enUS['settings.kernel.module.butler'].length > 0);
  assert.doesNotMatch(runtime, /\['codex', 'Codex'/);
  assert.doesNotMatch(runtime, /\['codex',/);
  assert.doesNotMatch(runtime, /CodexPage/);

  assert.match(navRail, /const PRIMARY_MODULE_IDS = new Set\(\['messages', 'todos', 'calendar', 'downloads'\]\);/);
  assert.doesNotMatch(navRail, /contributions: \{ label:/);
  assert.doesNotMatch(navRail, /['"]contributions['"]\s*:/);
  assert.match(navRail, /const WORK_MODULE_IDS = new Set\(\['workbench', 'contacts'\]\);/);
  assert.match(navRail, /const BUTLER_MODULE_IDS = new Set\(\['butler-view'\]\);/);
  assert.match(navRail, /id: 'butler',[\s\S]*ariaLabel: t\('nav\.section\.butler'\)/);
  assert.equal(zhCN['nav.section.butler'], '管家');
  assert.ok(enUS['nav.section.butler'].length > 0);
  assert.doesNotMatch(navRail, /管家执行引擎|taskProvider|setButlerTaskProvider/);
  assert.equal(Object.values(zhCN).some((value) => value.includes('管家执行引擎')), false);
  assert.doesNotMatch(navRail, /['"]today['"]/);
  assert.doesNotMatch(navRail, /['"]ai-assistant['"]/);

  assert.match(workbench, /key: 'contributions' as const, labelKey: 'workbench\.tab\.contributions'/);
  assert.equal(zhCN['workbench.tab.contributions'], '我的代码');
  assert.ok(enUS['workbench.tab.contributions'].length > 0);
  assert.match(workbench, /tab === 'contributions'[\s\S]*<ProfileContributionsPage \/>/);

  assert.match(page, /className="butler-workspace"/);
  assert.match(page, /<ButlerConversation embedded workBrief=\{workBrief\} \/>/);
  assert.match(page, /<ButlerPluginsPage \/>/);
  assert.match(page, /<ButlerRoutines \/>/);

  assert.match(history, /aria-label=\{t\('butler\.history\.aiCollabAria'\)\}/);
  assert.equal(zhCN['butler.history.aiCollabAria'], 'AI 协作');
  assert.ok(enUS['butler.history.aiCollabAria'].length > 0);
  assert.match(history, /aria-label=\{t\('butler\.history\.newConversation'\)\}/);
  assert.equal(zhCN['butler.history.newConversation'], '新管家对话');
  assert.ok(enUS['butler.history.newConversation'].length > 0);
  assert.match(history, /aria-label=\{t\('butler\.history\.codexHistoryAria'\)\}/);
  assert.equal(zhCN['butler.history.codexHistoryAria'], 'Codex 对话历史');
  assert.ok(enUS['butler.history.codexHistoryAria'].length > 0);
  assert.doesNotMatch(history, /aria-label="任务"/);
  assert.doesNotMatch(history, /butler\.page\.tasksAria|butler\.conversation\.tasksMobileLabel/);
  assert.equal(Object.entries(zhCN).some(([key, value]) => key.startsWith('butler.history.') && value === '任务'), false);
  assert.match(history, /setWorkbenchTab\('prs'\)/);
  assert.match(history, /setModule\('workbench'\)/);
  assert.match(history, /setButlerView\('routines'\)/);
  assert.match(history, /setButlerView\('plugins'\)/);
  assert.match(history, /title: t\('butler\.chooseWorkspaceTitle'\)/);
  assert.equal(zhCN['butler.chooseWorkspaceTitle'], '选择工作区');
  assert.ok(enUS['butler.chooseWorkspaceTitle'].length > 0);

  assert.match(conversation, /'butler\.conversation\.openInCodex'/);
  assert.equal(zhCN['butler.conversation.openInCodex'], '在 Codex 中打开');
  assert.ok(enUS['butler.conversation.openInCodex'].length > 0);
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
