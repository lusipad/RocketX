import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('例行事务整体迁入管家桌面并默认折叠', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const routines = readFileSync('apps/web/src/components/ButlerRoutines.tsx', 'utf8');

  assert.match(page, /<ButlerRoutines \/>/);
  assert.ok(page.indexOf('<ButlerRoutines />') > page.indexOf('工作日志'));
  assert.match(routines, /<details className="group rounded-xl/);
  assert.doesNotMatch(routines, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(routines, /<span>例行事务<\/span>/);

  assert.match(routines, /routines\.filter\(\(routine\) => routine\.enabled\)\.map/);
  assert.match(routines, /setRoutineEnabled\(routine\.id, event\.target\.checked\)/);
  assert.match(routines, /runningIds\.includes\(routine\.id\)/);
  assert.match(routines, /onRunNow=\{runRoutineNow\}/);
  assert.match(routines, /const latest = routine\.runs\[0\]/);
  assert.match(routines, /shouldExpandRun\(latest, Date\.now\(\)\)/);
  assert.match(routines, /await onRunNow\(routine\.id\);[\s\S]*setExpanded\(true\)/);
  assert.match(routines, /renderMarkdown\(latest\.text\)/);

  assert.match(routines, /eventCards\.map/);
  assert.match(routines, /openEventCard\(card\)/);
  assert.match(routines, /dismissCard\(card\.id\)/);
  assert.match(routines, /openButlerConversation\(\)/);
  assert.doesNotMatch(routines, /AI 晨报|AI 页面|ai-assistant/);
});

test('旧聚合表面与专属实现删除，但 @我 数据提供职责仍在启动路径', () => {
  for (const path of [
    'apps/web/src/pages/TodayPage.tsx',
    'apps/web/src/pages/AiAssistantPage.tsx',
    'apps/web/src/lib/today.ts',
    'apps/web/src/kernel/ai/features/daily-review.ts',
  ]) {
    assert.equal(existsSync(path), false, path);
  }
  const main = readFileSync('apps/web/src/pages/MainPage.tsx', 'utf8');
  assert.match(main, /useToday\.getState\(\)\.refreshMentions\(\)/);
  const mentionStore = readFileSync('apps/web/src/stores/today.ts', 'utf8');
  assert.match(mentionStore, /setButlerMentionProvider/);
});
