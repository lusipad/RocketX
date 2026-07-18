import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AVATAR_ONLY_CONVERSATION_WIDTH,
  COMPACT_CONVERSATION_WIDTH,
  effectiveConversationWidth,
} from '../../apps/web/src/lib/conversationPanelLayout';

test('右侧面板触发的标记会把会话列表临时收窄', () => {
  assert.equal(
    effectiveConversationWidth(320, true, null, 480),
    COMPACT_CONVERSATION_WIDTH,
  );
});

test('拖动中的会话列表宽度优先于临时收窄', () => {
  assert.equal(effectiveConversationWidth(320, true, 360, 480), 360);
});

test('清除临时收窄标记后恢复用户宽度', () => {
  assert.equal(effectiveConversationWidth(320, false, null, 480), 320);
});

test('管家面板把会话列表收成头像宽度', () => {
  assert.equal(
    effectiveConversationWidth(320, true, null, 480, true),
    AVATAR_ONLY_CONVERSATION_WIDTH,
  );
});

test('只有管家面板启用会话头像模式，标题和文本在该模式隐藏', async () => {
  const [mainPage, conversationList] = await Promise.all([
    readFile(new URL('../../apps/web/src/pages/MainPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ConversationList.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(mainPage, /const butlerPanelOpen = rightPanel\?\.kind === 'butler';/);
  assert.match(mainPage, /<ConversationList width=\{conversationWidth\} avatarOnly=\{butlerPanelOpen\} \/>/);
  assert.match(conversationList, /\{!avatarOnly && \(/);
  assert.match(conversationList, /showAvatar=\{avatarOnly \|\| showAvatar\}/);
});

test('管家面板启用可拖动宽度，其他面板仍使用固定外壳', async () => {
  const [panelShell, butlerPanel] = await Promise.all([
    readFile(new URL('../../apps/web/src/components/PanelShell.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerPanel.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(panelShell, /resizable\?: boolean/);
  assert.match(panelShell, /aria-label="调整 AI 面板宽度"/);
  // 标题带「新对话」按钮后成为节点，但仍走可拖宽的 PanelShell
  assert.match(butlerPanel, /<PanelShell\s+title=\{[\s\S]*?AI[\s\S]*?\}\s+resizable\s*>/);
});
