import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('纸上先即席问答，第 3 轮与历史入口打开同一个完整对话层', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');

  assert.match(page, /const conversationOpen = useUI/);
  assert.match(page, /if \(conversationOpen\) \{[\s\S]*<ButlerConversation onBackToPaper=\{backToPaper\} \/>/);
  assert.match(page, /const nextRound = paperRounds \+ 1/);
  assert.match(page, /shouldExpandButlerConversation\(nextRound\)[\s\S]*openConversation\(\)/);
  assert.match(page, /aria-label="查看完整对话"[\s\S]*onClick=\{openConversation\}/);
  assert.match(page, /<section aria-label="今天">[\s\S]*<ButlerInlineExchange/);
  assert.doesNotMatch(page, /reset\(|newConversation\(/);

  assert.match(conversation, />管家\s*<\/div>|>管家\s*<\/h1>/);
  assert.match(conversation, /aria-label="回到纸"/);
  assert.match(conversation, /useButler\(\(state\) => state\.lines\)/);
  assert.match(conversation, /useButler\(\(state\) => state\.ask\)/);
});
