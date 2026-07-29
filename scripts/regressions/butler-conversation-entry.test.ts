import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('纸上先即席问答，第 3 轮与左侧导航打开同一个完整对话层', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const ui = readFileSync('apps/web/src/stores/ui.ts', 'utf8');
  const nav = readFileSync('apps/web/src/components/ButlerWorkspaceNav.tsx', 'utf8');
  const todaySection = /<section aria-label="今天">[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';

  assert.match(page, /const paperConversation = useUI/);
  assert.match(page, /await hydrateButler\(\);[\s\S]*const sessionId = useButler\.getState\(\)\.activeSessionId/);
  assert.match(page, /const previousRound = \([\s\S]*previousPaperConversation\.rounds[\s\S]*\);/);
  assert.match(page, /const nextRound = advanceRound \? previousRound \+ 1 : Math\.max\(previousRound, 1\)/);
  assert.match(page, /setPaperConversation\(\{[\s\S]*questionId:/);
  assert.match(page, /shouldExpandButlerConversation\(nextRound\)[\s\S]*openConversationStore\(\)/);
  assert.match(nav, /\{ id: 'conversation', label: '对话'/);
  assert.doesNotMatch(page, /toggleConversation|toggleManage|查看完整对话|打开管家管理/);
  assert.match(page, /<section aria-label="临时问答">[\s\S]*<ButlerInlineExchange/);
  assert.doesNotMatch(todaySection, /<ButlerInlineExchange/);
  assert.doesNotMatch(page, /reset\(|newConversation\(/);
  assert.match(page, /activeView === 'conversation' \? \([\s\S]*\) : activeView === 'routines' \? \(/);
  assert.match(page, /\{activeView === 'now' \? \([\s\S]*aria-label="前一天"[\s\S]*\) : null\}/);

  assert.match(ui, /butlerPaperConversation: \{/);
  assert.match(ui, /date: string;/);
  assert.match(ui, /error: string \| null;/);
  assert.match(ui, /setButlerPaperConversation:/);
  assert.match(page, /paperConversation\?\.date === selectedDate/);
  assert.match(page, /paperConversation\.sessionId === activeSessionId/);
  assert.match(page, /error: useButler\.getState\(\)\.error/);
  assert.match(page, /askFromPaper\(inlineQuestion\.text, false\)/);

  assert.match(
    conversation,
    /<span>\{selectedHosted \? 'AI 托管记录' : '完整对话'\}<\/span>[\s\S]*<h2>\{selectedHosted\?\.title \|\| activeSummary\?\.title \|\| '新对话'\}<\/h2>/,
  );
  assert.match(conversation, /\{selectedHosted \? \([\s\S]*回到「\{selectedHosted\.roomName\}」/);
  assert.match(conversation, /const mine = line\.role === 'user'/);
  assert.match(conversation, /data-speaker=\{line\.role\}/);
  assert.match(conversation, /aria-label=\{mine \? '你说' : '管家说'\}/);
  assert.match(conversation, /mine \? 'justify-end' : 'justify-start'/);
  assert.match(conversation, /mine \? 'rounded-tr-sm bg-bubble-mine' : 'rounded-tl-sm bg-bubble-other\/60'/);
  assert.match(conversation, /\{mine \? '你' : '管家'\}/);
  assert.doesNotMatch(conversation, /aria-label="回到纸"/);
  assert.match(conversation, /useButler\(\(state\) => state\.lines\)/);
  assert.match(conversation, /useButler\(\(state\) => state\.ask\)/);
  assert.doesNotMatch(conversation, /<Bot\s/);
});
