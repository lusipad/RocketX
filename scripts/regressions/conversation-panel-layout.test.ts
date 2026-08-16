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

test('私人房间 AI 自然进入对话态，共享托管继续由 AgentPanel 管理', async () => {
  const [chatArea, butlerPanel, agentPanel] = await Promise.all([
    readFile(new URL('../../apps/web/src/components/ChatArea.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/ButlerPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/components/AgentPanel.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(chatArea, /const butlerPanelOpen = rightPanel\?\.kind === 'butler';/);
  assert.match(chatArea, /registeredPanels\.find\(\(candidate\) => candidate\.id === 'butler'\)\?\.render/);
  assert.match(chatArea, /butlerPanelOpen && ButlerPanel/);
  assert.match(chatArea, /id="room-butler-launcher"[\s\S]*onClick=\{\(\) => togglePanel\(\{ kind: 'butler' \}\)\}/);
  assert.match(chatArea, /aria-label="配置 AI 托管"/);
  assert.match(chatArea, /aria-label="选择 AI 托管项目"/);
  assert.match(chatArea, /onClick=\{\(\) => setPanel\(\{ kind: 'agent', tmid: agentSessionKey \}\)\}/);

  assert.match(butlerPanel, /ROOM_THREAD_STORAGE_KEY = 'rcx-room-codex-threads-v1'/);
  assert.match(butlerPanel, /privateRoomDshKey\(scope, rid\)/);
  assert.match(butlerPanel, /usePrivateRoomDsh/);
  assert.match(butlerPanel, /useCodexWorkspace\.getState\(\)\.send/);
  assert.match(butlerPanel, /<PanelShell[\s\S]*resizable/);
  assert.match(butlerPanel, /aria-label="私人房间 AI 对话"/);
  assert.match(butlerPanel, /私人会话/);
  assert.match(butlerPanel, /仅你可见，不会向当前房间发送消息/);
  assert.match(butlerPanel, /ConversationCopyButton/);
  assert.match(butlerPanel, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(butlerPanel, /aria-label="设置 Codex 模型与权限"/);
  assert.match(butlerPanel, /aria-label="设置 DeepSeek 模型与 Agent"/);
  assert.doesNotMatch(butlerPanel, /useSharedAgent|agentRoomSessionKey|startRoomAgentHosting|send\(`?@ai/);

  assert.match(agentPanel, /useSharedAgent/);
  assert.match(agentPanel, /const tmid = sessionKey \?\?/);
  assert.match(agentPanel, /resizable=\{resizable\}/);
  assert.match(agentPanel, /openButlerConversation\(tmid\)/);
  assert.match(agentPanel, /useStickToBottom\(\[sessionTraces\]\)/);
});
