import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('纸底部只读已启用例行事务数量，管理组件本身保留', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const routines = readFileSync('apps/web/src/components/ButlerRoutines.tsx', 'utf8');

  assert.match(page, /useRoutines\(\(state\) => state\.routines\)/);
  assert.match(page, /routines\.filter\(\(routine\) => routine\.enabled\)\.length/);
  assert.match(page, /在盯 \{watchedCount\} 件事，结果都会写到这张纸上/);
  assert.match(page, /<ButlerRoutines \/>/);
  assert.match(page, /aria-label=\{manageOpen \? '收起管家管理' : '打开管家管理'\}/);
  assert.match(page, /conversationOpen \? \([\s\S]*\) : manageOpen \? \(/);
  assert.match(routines, /<section aria-label="在盯的事">/);
  assert.match(routines, /管理例行事务/);
  assert.doesNotMatch(routines, /<details[^>]*\sopen(?:=|\s|>)/);

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
