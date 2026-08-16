import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runtimeFeatures } from '../../apps/web/src/lib/runtimeMode';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

test('无 AI 只禁用执行后端，不应拿掉管家与托管信息架构', () => {
  const features = runtimeFeatures('standard', 'none');
  const chatArea = read('apps/web/src/components/ChatArea.tsx');

  assert.equal(features.ai, false);
  assert.equal(features.butler, true, '无 AI 时仍应保留管家入口，用来查看普通对话与 AI 托管');
  assert.equal(features.sharedAgent, true, '无 AI 时仍应保留托管信息架构，只禁用执行动作');
  assert.match(chatArea, /!features\.sharedAgent \|\| !features\.ai/, '无 AI 时不应尝试自动启动托管执行器');
});

test('管家页保留普通对话与 AI 托管，并明确私人房间 AI 不属于共享托管', () => {
  const history = read('apps/web/src/components/ButlerConversationHistory.tsx');
  const page = read('apps/web/src/pages/ButlerPage.tsx');

  assert.match(history, /useSharedAgent/, '管家页左栏应读取 sharedAgent 托管会话');
  assert.match(history, /AI 托管/, '管家页应保留托管信息架构');
  assert.match(history, /aria-label="AI 托管会话"/, '托管会话应作为同一导航中的一段');
  assert.match(history, /私人房间 AI 会话同样仅你可见/, '导航应明确个人对话与共享托管的边界');
  assert.doesNotMatch(page, /ButlerHostingOverview/, '管家主区不应再渲染重复托管 transcript');
});

test('房间侧栏打开 AI 管家时应把当前托管 session 作为焦点传过去', () => {
  const uiStore = read('apps/web/src/stores/ui.ts');
  const agentPanel = read('apps/web/src/components/AgentPanel.tsx');

  assert.match(
    uiStore,
    /openButlerConversation:\s*\(focusSessionKey\??:\s*string\)\s*=>\s*void/,
    'UI 状态应支持把指定托管 session 设为 AI 管家焦点',
  );
  assert.match(
    agentPanel,
    /openButlerConversation\(tmid\)/,
    '房间侧栏应把当前房间的托管 session key 传给 AI 管家',
  );
});

test('房间 AI 使用私人 provider 会话，AI 托管才复用 sharedAgent 的房间 session', () => {
  const panel = read('apps/web/src/components/ButlerPanel.tsx');
  const privateDsh = read('apps/web/src/stores/privateRoomDsh.ts');
  const agentPanel = read('apps/web/src/components/AgentPanel.tsx');

  assert.match(panel, /ROOM_THREAD_STORAGE_KEY = 'rcx-room-codex-threads-v1'/, 'Codex 私人会话应按账号和房间恢复');
  assert.match(panel, /useCodexWorkspace\.getState\(\)\.send/, 'Codex 私人消息应直接进入个人 thread');
  assert.match(panel, /usePrivateRoomDsh/, 'DeepSeek 应使用独立的私人房间状态');
  assert.match(panel, /仅你可见，不会向当前房间发送消息/, '界面应明确私人可见性');
  assert.doesNotMatch(panel, /useSharedAgent|agentRoomSessionKey|startRoomAgentHosting|HostedConversationTranscript/);
  assert.doesNotMatch(panel, /send\(`?@ai/);
  assert.match(privateDsh, /PRIVATE_ROOM_DSH_STORAGE_KEY = 'rcx-private-room-dsh-sessions-v1'/);
  assert.match(privateDsh, /privateRoomDshKey\(options\.scope, options\.rid\)/);
  assert.doesNotMatch(privateDsh, /useSharedAgent|agentRoomSessionKey|startRoomAgentHosting/);
  assert.match(agentPanel, /useSharedAgent/, '托管控制面应直接读取 sharedAgent');
  assert.match(agentPanel, /const tmid = sessionKey \?\?/, '共享托管仍应使用显式房间 session key');
});
