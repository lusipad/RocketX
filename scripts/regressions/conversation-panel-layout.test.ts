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

test('房间管家作为覆盖层，不收窄分组与会话列表', async () => {
  const [mainPage, layout] = await Promise.all([
    readFile(new URL('../../apps/web/src/pages/MainPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/lib/conversationPanelLayout.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(
    mainPage,
    /const layoutPanelOpen = rightPanel !== null && rightPanel\.kind !== 'butler';/,
  );
  assert.match(mainPage, /<ConversationList width=\{conversationWidth\} \/>/);
  assert.doesNotMatch(mainPage, /butlerPanelOpen|avatarOnly=\{/);
  assert.doesNotMatch(layout, /AVATAR_ONLY_CONVERSATION_WIDTH|avatarOnly/);
});

test('房间管家使用右下浮动入口和覆盖层，其他右侧面板仍使用固定外壳', async () => {
  const [chatArea, butlerPanel] = await Promise.all([
    readFile(new URL('../../apps/web/src/components/ChatArea.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerPanel.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(chatArea, /const butlerPanelOpen = rightPanel\?\.kind === 'butler';/);
  assert.match(chatArea, /aria-controls="room-butler-panel"/);
  assert.match(
    chatArea,
    /aria-label=\{butlerPanelOpen \? '收起房间管家' : '打开房间管家'\}/,
  );
  assert.match(chatArea, /aria-label="关闭房间管家浮层"/);
  assert.match(chatArea, /butlerPanelOpen && ButlerPanel/);
  assert.doesNotMatch(chatArea, /label="AI"[\s\S]*kind: 'butler'/);

  assert.match(butlerPanel, /id="room-butler-panel"/);
  assert.match(butlerPanel, /role="dialog"/);
  assert.match(butlerPanel, /只看 \{roomContext\?\.roomName \?\? '这个房间'\}/);
  assert.match(butlerPanel, /aria-label="关闭房间管家"/);
  assert.doesNotMatch(butlerPanel, /PanelShell|resizable/);
});
