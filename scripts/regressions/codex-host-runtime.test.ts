import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('Codex sessions use the selected host workspace without an Agent Runner image', async () => {
  const [proc, localCodex, sharedAgent, tauri, ci, pkg] = await Promise.all([
    readFile(new URL('apps/desktop/src-tauri/src/proc.rs', root), 'utf8'),
    readFile(new URL('apps/web/src/stores/localCodex.ts', root), 'utf8'),
    readFile(new URL('apps/web/src/stores/sharedAgent.ts', root), 'utf8'),
    readFile(new URL('apps/desktop/src-tauri/tauri.conf.json', root), 'utf8'),
    readFile(new URL('.github/workflows/ci.yml', root), 'utf8'),
    readFile(new URL('package.json', root), 'utf8'),
  ]);

  assert.match(proc, /find_program\("codex\.cmd"\)/);
  assert.match(proc, /standard_codex_paths\(\)/);
  assert.match(proc, /codex_command_succeeds\(&\["app-server", "--help"\]\)/);
  assert.match(proc, /codex_command_succeeds\(&\["login", "status"\]\)/);
  assert.doesNotMatch(proc, /codex_runtime_login/);
  assert.match(proc, /args\(\["app-server", "--stdio"\]\)/);
  assert.match(proc, /current_dir\(&workspace\)/);
  assert.doesNotMatch(proc, /CODEX_RUNNER_IMAGE|hidden_command\("docker"\)/);
  assert.doesNotMatch(localCodex, /RUNNER_WORKSPACE|rocketx_(?:read|write)/);
  assert.doesNotMatch(sharedAgent, /RUNNER_WORKSPACE|rocketx_(?:read|write)/);
  assert.doesNotMatch(tauri, /agent-runner\/Dockerfile/);
  assert.doesNotMatch(ci, /agent:runner:test/);
  assert.doesNotMatch(pkg, /agent:runner:(?:build|test)/);
});

test('会话只保留一个 AI 托管入口，并支持按房间自动开启', async () => {
  const [chatArea, threadPanel, hosting, agentPanel] = await Promise.all([
    readFile(new URL('apps/web/src/components/ChatArea.tsx', root), 'utf8'),
    readFile(new URL('apps/web/src/components/ThreadPanel.tsx', root), 'utf8'),
    readFile(new URL('apps/web/src/lib/agentHosting.ts', root), 'utf8'),
    readFile(new URL('apps/web/src/components/AgentPanel.tsx', root), 'utf8'),
  ]);

  assert.match(chatArea, /aria-label="开启 AI 托管"/);
  assert.match(chatArea, /startRoomAgentHosting\(activeRid, rawName\)/);
  assert.match(chatArea, /aria-label=\{localAgentActive \? '关闭 AI 托管'/);
  assert.match(chatArea, /await endAgentSession\(agentSessionKey\)/);
  assert.doesNotMatch(chatArea, /localAgentActive && togglePanel\(\{ kind: 'agent'/);
  assert.doesNotMatch(threadPanel, /共享 Agent/);
  assert.match(hosting, /autoHostEnvironmentId/);
  assert.match(hosting, /fetchWorkItem\(workItemId\)/);
  assert.match(agentPanel, /进入本房间时自动开启托管/);
  assert.doesNotMatch(agentPanel, /state\.traces\[tmid\] \?\? \[\]/);
  assert.match(agentPanel, /useMemo\(\s*\(\) => allApprovals\.filter/);
  assert.match(agentPanel, /useMemo\(\s*\(\) => allMemberRequests\.filter/);
});
