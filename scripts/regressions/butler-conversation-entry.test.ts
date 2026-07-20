import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('桌面停靠输入与显式按钮都打开同一个管家对话面板', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');

  assert.match(page, /const conversationOpen = useUI/);
  assert.match(page, /if \(conversationOpen\) \{[\s\S]*<ButlerConversation onCollapse=\{closeConversation\} \/>/);
  assert.match(page, /function submitQuestion[\s\S]*openConversation\(\);[\s\S]*useButler\.getState\(\)\.ask\(text\)/);
  assert.match(page, /onClick=\{openConversation\}[\s\S]*展开对话/);
  assert.doesNotMatch(page, /reset\(|newConversation\(/);

  assert.match(conversation, />管家\s*<\/div>|>管家\s*<\/h1>/);
  assert.match(conversation, /aria-label="收起对话"/);
  assert.match(conversation, /useButler\(\(state\) => state\.lines\)/);
  assert.match(conversation, /useButler\(\(state\) => state\.ask\)/);
});
