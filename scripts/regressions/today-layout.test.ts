import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('今日页 AI 区只放晨报，规则提醒摘掉 AI 帽子单独成组', () => {
  const page = readFileSync('apps/web/src/pages/TodayPage.tsx', 'utf8');

  // AI 区改名「AI 晨报」，只渲染例行事务报告；没有例行事务时引导去 AI 页面创建
  assert.match(page, />AI 晨报<\/div>/);
  assert.match(page, /routines\.filter\(\(routine\) => routine\.enabled\)\.map/);
  assert.match(page, /还没有例行晨报/);
  assert.match(page, /setModule\('ai-assistant'\)/);

  // 启用开关和时间表收进折叠的「管理例行事务」，不占今日版面
  assert.match(page, /管理例行事务/);
  assert.match(page, /setRoutineEnabled\(routine\.id, event\.target\.checked\)/);

  // 规则事件卡（构建失败/@我超时/新分配）在独立「提醒」组里，可跳转可关闭
  assert.match(page, />提醒<\/h2>/);
  assert.match(page, /openEventCard\(card\)/);
  assert.match(page, /dismissCard\(card\.id\)/);
  // AI 区里不能再渲染 eventCards
  const aiSection = page.slice(page.indexOf('AI 晨报'), page.indexOf('今日处理进度'));
  assert.doesNotMatch(aiSection, /eventCards/);

  // 晨报卡以内容为主：今天的报告默认展开，未生成给一键生成
  assert.match(page, /shouldExpandRun\(latest, Date\.now\(\)\)/);
  assert.match(page, /今天还没生成/);
});
