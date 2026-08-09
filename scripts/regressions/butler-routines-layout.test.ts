import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('已安排工作面提供真实的新建、启停和立即运行入口，Codex 管理只是次要按钮', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const routines = readFileSync('apps/web/src/components/ButlerRoutines.tsx', 'utf8');

  assert.match(page, /activeView === 'routines' \? \(/);
  assert.match(page, /<ButlerRoutines \/>/);
  assert.match(routines, /<section aria-label="已安排"/);
  assert.match(routines, /aria-label="新建安排"/);
  assert.match(routines, /role="switch"/);
  assert.match(routines, /aria-label=\{`\$\{routine\.enabled \? '停用' : '启用'\}\$\{routine\.name\}`\}/);
  assert.match(routines, /aria-label=\{`立即运行\$\{routine\.name\}`\}/);
  assert.match(routines, /onClick=\{\(\) => setEnabled\(routine\.id, !routine\.enabled\)\}/);
  assert.match(routines, /onClick=\{\(\) => void runNow\(routine\.id, \{ triggerReason: 'manual' \}\)\}/);
  assert.match(routines, /aria-live="polite"/);
  assert.match(routines, /最近结果/);
  assert.match(routines, /createButtonRef/);
  assert.match(routines, /在 Codex App 管理/);
  assert.match(routines, /aria-label="搜索已安排任务"/);
  assert.match(routines, /aria-label="已安排任务状态"/);
  assert.match(routines, /全部标为已读/);
  assert.match(routines, /butler-scheduled-list/);
  assert.doesNotMatch(routines, /toggleManage|动态|AI 晨报|AI 页面|ai-assistant/);
});
