import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('纸上先即席问答，第 3 轮与历史入口打开同一个完整对话层', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const ui = readFileSync('apps/web/src/stores/ui.ts', 'utf8');
  const todaySection = /<section aria-label="今天">[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';

  assert.match(page, /const conversationOpen = useUI/);
  assert.match(page, /const paperConversation = useUI/);
  assert.match(page, /await hydrateButler\(\);[\s\S]*const sessionId = useButler\.getState\(\)\.activeSessionId/);
  assert.match(page, /const previousRound = \([\s\S]*previousPaperConversation\.rounds[\s\S]*\);/);
  assert.match(page, /const nextRound = advanceRound \? previousRound \+ 1 : Math\.max\(previousRound, 1\)/);
  assert.match(page, /setPaperConversation\(\{[\s\S]*questionId:/);
  assert.match(page, /shouldExpandButlerConversation\(nextRound\)[\s\S]*openConversationStore\(\)/);
  assert.match(page, /aria-label=\{conversationOpen \? '收起完整对话' : '查看完整对话'\}/);
  assert.match(page, /onClick=\{toggleConversation\}/);
  assert.match(page, /aria-label=\{manageOpen \? '收起管家管理' : '打开管家管理'\}/);
  assert.match(page, /<section aria-label="临时问答">[\s\S]*<ButlerInlineExchange/);
  assert.doesNotMatch(todaySection, /<ButlerInlineExchange/);
  assert.doesNotMatch(page, /if \(conversationOpen\) \{[\s\S]*return <ButlerConversation/);
  assert.doesNotMatch(page, /reset\(|newConversation\(/);
  assert.match(page, /conversationOpen \? \([\s\S]*\) : manageOpen \? \(/);
  const backToPaper = /const backToPaper = \(\): void => \{([\s\S]*?)\n  \};/.exec(page)?.[1] ?? '';
  assert.match(backToPaper, /closeConversation\(\)/);
  assert.doesNotMatch(backToPaper, /setPaperConversation|setInlineRange|stopButler/);

  assert.match(ui, /butlerPaperConversation: \{/);
  assert.match(ui, /date: string;/);
  assert.match(ui, /error: string \| null;/);
  assert.match(ui, /setButlerPaperConversation:/);
  assert.match(page, /paperConversation\?\.date === selectedDate/);
  assert.match(page, /paperConversation\.sessionId === activeSessionId/);
  assert.match(page, /error: useButler\.getState\(\)\.error/);
  assert.match(page, /askFromPaper\(inlineQuestion\.text, false\)/);

  assert.match(conversation, /<h2[^>]*>完整对话<\/h2>/);
  assert.match(conversation, /const mine = line\.role === 'user'/);
  assert.match(conversation, /data-speaker=\{line\.role\}/);
  assert.match(conversation, /aria-label=\{mine \? '你说' : '管家说'\}/);
  assert.match(conversation, /mine \? 'justify-end' : 'justify-start'/);
  assert.match(conversation, /mine \? 'rounded-tr-sm bg-bubble-mine' : 'rounded-tl-sm bg-bubble-other\/60'/);
  assert.match(conversation, /\{mine \? '你' : '管家'\}/);
  assert.match(conversation, /aria-label="回到纸"/);
  assert.match(conversation, /useButler\(\(state\) => state\.lines\)/);
  assert.match(conversation, /useButler\(\(state\) => state\.ask\)/);
  assert.doesNotMatch(conversation, /<Bot\s/);
});
