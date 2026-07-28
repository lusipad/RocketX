import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('自动整理可在纸底发现和配置，运行结果与提醒回到纸面', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const routines = readFileSync('apps/web/src/components/ButlerRoutines.tsx', 'utf8');

  assert.match(page, /useRoutines\(\(state\) => state\.routines\)/);
  assert.match(page, /useRoutines\(\(state\) => state\.eventCards\)/);
  assert.match(page, /routines\.filter\(\(routine\) => routine\.enabled\)\.length/);
  assert.match(page, /自动整理未开启/);
  assert.match(page, /aria-label="消息与提醒"/);
  assert.match(page, /routineReports/);
  assert.match(page, /eventCards\.map/);
  assert.match(page, /openRoom\(card\.rid\)/);
  assert.match(page, /onDismissEvent\(card\.id\)/);
  assert.match(page, /renderMarkdown\(report\.run\.text\)/);
  assert.match(page, /automationPreview\(report\.run\.text\)/);
  assert.match(page, /aria-label=\{`\$\{report\.routine\.name\}摘要`\}/);
  assert.match(page, /<ButlerRoutines \/>/);
  assert.doesNotMatch(page, /收起管家管理|打开管家管理|toggleManage/);
  assert.match(page, /activeView === 'conversation' \? \([\s\S]*\) : activeView === 'routines' \? \(/);
  assert.match(routines, /<section aria-label="正在照看">/);
  assert.match(routines, /BUTLER_ABILITY_TEMPLATES/);
  assert.match(routines, /loadRoutineTemplate/);
  assert.match(routines, /selectedDigestRooms/);
  assert.match(routines, /至少选择一个房间/);
  assert.match(routines, /openRoom\(card\.rid\)/);
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
