import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
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

test('房间任务面板仍作为覆盖层，不收窄分组与会话列表', async () => {
  const [mainPage, layout] = await Promise.all([
    readFile(new URL('../../apps/web/src/pages/MainPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/lib/conversationPanelLayout.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(
    mainPage,
    /const layoutPanelOpen = rightPanel !== null && rightPanel\.kind !== 'butler';/,
  );
  assert.match(mainPage, /<ConversationList width=\{conversationWidth\} \/>/);
  assert.doesNotMatch(mainPage, /avatarOnly=\{/);
  assert.doesNotMatch(layout, /AVATAR_ONLY_CONVERSATION_WIDTH|avatarOnly/);
});

test('房间侧栏只负责创建 Codex 任务，不再 import useButler 或运行第二套会话', async () => {
  const [chatArea, butlerPanel] = await Promise.all([
    readFile(new URL('../../apps/web/src/components/ChatArea.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerPanel.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(chatArea, /const butlerPanelOpen = rightPanel\?\.kind === 'butler';/);
  assert.match(chatArea, /registeredPanels\.find\(\(candidate\) => candidate\.id === 'butler'\)\?\.render/);
  assert.match(chatArea, /butlerPanelOpen && ButlerPanel/);

  assert.match(butlerPanel, /import \{ handoffToCodexTask \} from '\.\.\/lib\/codexTaskHandoff';/);
  assert.match(butlerPanel, /<h2 className="text-sm font-semibold text-ink">在 Codex 中处理<\/h2>/);
  assert.match(butlerPanel, /aria-label="创建 Codex 任务"/);
  assert.match(butlerPanel, /useUI\.getState\(\)\.openButlerConversation\(\)/);
  assert.doesNotMatch(butlerPanel, /useButler/);
  assert.doesNotMatch(butlerPanel, /PanelShell|useImLayout|调整房间管家宽度/);
});
