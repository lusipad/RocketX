import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('AI 托管使用账号级独立模型配置，但不在管家会话常驻配置横幅', () => {
  const sharedAgent = readFileSync('apps/web/src/stores/sharedAgent.ts', 'utf8');
  const workspace = readFileSync('apps/web/src/stores/codexWorkspace.ts', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const settings = readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');

  assert.match(sharedAgent, /const workspace = useCodexWorkspace\.getState\(\)/);
  assert.match(sharedAgent, /workspace\.hostingModel/);
  assert.match(sharedAgent, /workspace\.hostingEffort/);
  assert.match(sharedAgent, /runtimePermissionPreset: workspace\.permissionPreset/);
  assert.match(sharedAgent, /permissionPreset: session\?\.runtimePermissionPreset \?\? workspace\.permissionPreset/);
  assert.match(workspace, /hostingModel/);
  assert.match(workspace, /hostingEffort/);
  assert.match(workspace, /setHostingModel/);
  assert.match(workspace, /setHostingEffort/);
  assert.doesNotMatch(conversation, /aria-label="AI 托管设置"/);
  assert.doesNotMatch(conversation, /ariaLabel="AI 托管模型"/);
  assert.doesNotMatch(conversation, /ariaLabel="AI 托管推理强度"/);
  assert.doesNotMatch(sharedAgent, /agentHostingSettings|getAgentHostingCodexSettings/);
  assert.doesNotMatch(settings, /AI 托管 Codex 模型|AI 托管 Codex 推理强度|AI 托管 Codex 权限/);
});

test('聊天托管面板展示独立托管配置，并提供管家统一管理入口', () => {
  const panel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');

  assert.match(panel, /AI 托管独立配置/);
  assert.match(panel, /hostingModel/);
  assert.match(panel, /hostingEffort/);
  assert.match(panel, /permissionPreset/);
  assert.match(panel, /在 AI 管家中调整/);
  assert.match(panel, /openButlerConversation/);
  assert.match(panel, /workspaceRoot/);
  assert.match(panel, /availableProjects/);
  assert.match(panel, /useAgentEnvironments/);
  assert.match(panel, /environmentIsBusy/);
  assert.match(panel, /aria-label="AI 托管项目"/);
  assert.match(panel, /roomHostingWorkspaceRoot/);
  assert.match(panel, /setRoomHostingWorkspace/);
  assert.doesNotMatch(panel, /defaultWorkspaceRoot|butlerWorkspaceRoot|isSystemCodexWorkspace/);
  assert.doesNotMatch(panel, /临时工作区（系统默认）/);
  assert.doesNotMatch(panel, /临时选择 AI 托管项目|其他目录/);
  const chat = readFileSync('apps/web/src/components/ChatArea.tsx', 'utf8');
  assert.match(chat, /aria-label="开启 AI 托管"/);
  assert.match(chat, /aria-label="选择 AI 托管项目"/);
  assert.match(
    chat,
    /setHosting\(true\);[\s\S]*setPanel\(\{ kind: 'agent', tmid: agentSessionKey \}\);[\s\S]*await startRoomAgentHosting/,
  );
  assert.match(chat, /startRoomAgentHosting\(activeRid, rawName, \{ workspaceRoot \}\)/);
  assert.match(chat, /在 AI 管家中管理项目/);
  assert.match(chat, /openButlerConversation/);
  assert.match(chat, /setRoomHostingWorkspace\(activeRid, workspaceRoot\)/);
  assert.doesNotMatch(chat, /butlerWorkspaceRoot|isSystemCodexWorkspace/);
});
