import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';

const root = new URL('../../', import.meta.url);

test('Web 协议基线与桌面运行时兼容合同保持同一版本口径', async () => {
  const [protocol, contract] = await Promise.all([
    readFile(new URL('apps/web/src/agent/protocol/compatibility.ts', root), 'utf8'),
    readFile(new URL('apps/desktop/src-tauri/src/native/codex_contract.rs', root), 'utf8'),
  ]);
  const protocolBaseline = /CODEX_APP_SERVER_VERSION = '([^']+)'/u.exec(protocol)?.[1];
  const desktopBaseline = /CODEX_PROTOCOL_BASELINE: &str = "([^"]+)"/u.exec(contract)?.[1];
  const webCandidate = /CODEX_MINIMUM_CANDIDATE = '([^']+)'/u.exec(protocol)?.[1];
  const desktopCandidate = /CODEX_MINIMUM_CANDIDATE: &str = "([^"]+)"/u.exec(contract)?.[1];
  assert.equal(desktopBaseline, protocolBaseline);
  assert.equal(desktopCandidate, webCandidate);
});

test('Codex sessions use the selected host workspace without an Agent Runner image', async () => {
  const [proc, discovery, controller, workspace, sharedAgent, tauri, ci, pkg] = await Promise.all([
    readFile(new URL('apps/desktop/src-tauri/src/proc.rs', root), 'utf8'),
    readFile(new URL('apps/desktop/src-tauri/src/native/codex_discovery.rs', root), 'utf8'),
    readFile(new URL('apps/web/src/agent/AppServerController.ts', root), 'utf8'),
    readFile(new URL('apps/web/src/stores/codexWorkspace.ts', root), 'utf8'),
    readFile(new URL('apps/web/src/stores/sharedAgent.ts', root), 'utf8'),
    readFile(new URL('apps/desktop/src-tauri/tauri.conf.json', root), 'utf8'),
    readFile(new URL('.github/workflows/ci.yml', root), 'utf8'),
    readFile(new URL('package.json', root), 'utf8'),
  ]);

  assert.match(discovery, /fn bundled_codex_paths\(app:/);
  assert.match(discovery, /app\.path\(\)\.resource_dir\(\)/);
  assert.match(discovery, /\["codex\.cmd", "codex\.exe"\]/);
  assert.match(discovery, /fn standard_codex_paths\(\)/);
  assert.match(proc, /codex_runtime_scan_from_candidates_with/);
  assert.match(proc, /codex_command_succeeds\(resolved, &\["app-server", "--help"\]\)/);
  assert.match(proc, /codex_command_succeeds\(resolved, &\["login", "status"\]\)/);
  assert.doesNotMatch(proc, /codex_runtime_login/);
  assert.match(proc, /\.args\(&launch_args\)/);
  assert.match(proc, /current_dir\(&workspace_root\)/);
  assert.doesNotMatch(proc, /CODEX_RUNNER_IMAGE|hidden_command\("docker"\)/);
  assert.doesNotMatch(controller, /RUNNER_WORKSPACE|rocketx_(?:read|write)/);
  assert.doesNotMatch(workspace, /RUNNER_WORKSPACE|rocketx_(?:read|write)/);
  assert.doesNotMatch(sharedAgent, /RUNNER_WORKSPACE|rocketx_(?:read|write)/);
  assert.doesNotMatch(tauri, /agent-runner\/Dockerfile/);
  assert.doesNotMatch(ci, /agent:runner:test/);
  assert.doesNotMatch(pkg, /agent:runner:(?:build|test)/);
});

test('桌面端自动准备临时会话与管家会话目录，并把用户目录归为托管项目', async () => {
  const [proc, main, workspace, history, panel] = await Promise.all([
    readFile(new URL('apps/desktop/src-tauri/src/proc.rs', root), 'utf8'),
    readFile(new URL('apps/desktop/src-tauri/src/main.rs', root), 'utf8'),
    readFile(new URL('apps/web/src/stores/codexWorkspace.ts', root), 'utf8'),
    readFile(new URL('apps/web/src/components/ButlerConversationHistory.tsx', root), 'utf8'),
    readFile(new URL('apps/web/src/components/ButlerPanel.tsx', root), 'utf8'),
  ]);

  assert.match(proc, /pub fn codex_default_workspace/);
  assert.match(proc, /codex_workspace_directory\(&app, ""\)/);
  assert.match(proc, /pub fn codex_butler_workspace/);
  assert.match(proc, /codex-butler/);
  assert.match(main, /proc::codex_default_workspace/);
  assert.match(main, /proc::codex_butler_workspace/);
  assert.match(workspace, /ensureDefaultWorkspace/);
  assert.match(workspace, /readCodexDefaultWorkspace\(\)/);
  assert.match(workspace, /readCodexButlerWorkspace\(\)/);
  assert.match(workspace, /defaultWorkspaceRoot/);
  assert.match(workspace, /butlerWorkspaceRoot/);
  assert.match(history, /t\('butler\.workspace\.tempSession'\)/);
  assert.equal(zhCN['butler.workspace.tempSession'], '临时会话');
  assert.ok(enUS['butler.workspace.tempSession'].length > 0);
  assert.match(history, /t\('butler\.workspace\.butlerSession'\)/);
  assert.equal(zhCN['butler.workspace.butlerSession'], '管家会话');
  assert.ok(enUS['butler.workspace.butlerSession'].length > 0);
  assert.match(history, /t\('butler\.history\.addHostedProject'\)/);
  assert.match(zhCN['butler.history.addHostedProject'], /托管项目/);
  assert.ok(enUS['butler.history.addHostedProject'].length > 0);
  assert.match(history, /butlerWorkspaceRoot/);
  assert.match(panel, /ROOM_THREAD_STORAGE_KEY = 'rcx-room-codex-threads-v1'/);
  assert.match(panel, /prepareRoomWorkspace/);
  assert.match(panel, /latest\.butlerWorkspaceRoot \|\| latest\.defaultWorkspaceRoot/);
  assert.match(panel, /useCodexWorkspace/);
  assert.match(panel, /<PanelShell[\s\S]*resizable/);
  assert.doesNotMatch(panel, /useSharedAgent|agentRoomSessionKey|HostedConversationTranscript/);
});

test('app-server 启动参数跟随 CLI 版本，--stdio 不再写死（新版传了会以退出码 2 退出）', async () => {
  const proc = await readFile(new URL('apps/desktop/src-tauri/src/proc.rs', root), 'utf8');
  // 按 app-server --help 是否列出 --stdio 决定传不传
  assert.match(proc, /fn app_server_args_for_help\(help: &str\)/);
  assert.match(proc, /help\.contains\("--stdio"\)/);
  assert.match(proc, /let launch_args = match native_launch_args\s*\.map\(Ok\)\s*\.unwrap_or_else\(\|\| app_server_launch_args\(&resolved\)\)/);
  assert.match(proc, /fn probe_native_profile[\s\S]*?run_bounded_output[\s\S]*?app_server_args_for_help\(&help_text\)/);
  assert.match(proc, /app_server_launch_args\(&resolved\)[\s\S]*?mark_exit\(supervisor_now_ms\(\), false\)/);
  // 不能再无条件传 --stdio
  assert.doesNotMatch(proc, /args\(\["app-server", "--stdio"\]\)/);
});

test('私人房间 AI 与共享托管保留独立入口，并支持显式自动托管', async () => {
  const [chatArea, threadPanel, hosting, agentPanel] = await Promise.all([
    readFile(new URL('apps/web/src/components/ChatArea.tsx', root), 'utf8'),
    readFile(new URL('apps/web/src/components/ThreadPanel.tsx', root), 'utf8'),
    readFile(new URL('apps/web/src/lib/agentHosting.ts', root), 'utf8'),
    readFile(new URL('apps/web/src/components/AgentPanel.tsx', root), 'utf8'),
  ]);

  assert.match(chatArea, /id="room-butler-launcher"/);
  assert.match(chatArea, /features\.butler && !butlerPanelOpen/);
  assert.match(chatArea, /aria-label=\{t\('chat\.area\.openRoomButler'\)\}/);
  assert.equal(zhCN['chat.area.openRoomButler'], '打开房间 AI');
  assert.ok(enUS['chat.area.openRoomButler'].length > 0);
  assert.doesNotMatch(chatArea, /收起房间 AI/);
  assert.equal(Object.values(zhCN).some((value) => value.includes('收起房间 AI')), false);
  assert.match(chatArea, /aria-label=\{t\('chat\.area\.configureAiHosting'\)\}/);
  assert.equal(zhCN['chat.area.configureAiHosting'], '配置 AI 托管');
  assert.ok(enUS['chat.area.configureAiHosting'].length > 0);
  assert.match(chatArea, /title=\{t\('chat\.area\.selectAiProjectTooltip'\)\}/);
  assert.equal(zhCN['chat.area.selectAiProjectTooltip'], '选择项目或打开托管设置');
  assert.ok(enUS['chat.area.selectAiProjectTooltip'].length > 0);
  assert.match(chatArea, /setPanel\(\{ kind: 'agent', tmid: agentSessionKey \}\)/);
  assert.match(chatArea, /aria-label=\{t\('chat\.area\.openAiControlAria'\)\}/);
  assert.equal(zhCN['chat.area.openAiControlAria'], '打开 AI 托管控制面');
  assert.ok(enUS['chat.area.openAiControlAria'].length > 0);
  assert.match(chatArea, /title=\{t\('chat\.area\.openAiControlTooltip',\s*\{[\s\S]*?username: agentPresence\.username,[\s\S]*?\}\)\}/);
  assert.match(zhCN['chat.area.openAiControlTooltip'], /由 @\{username\} 托管/);
  assert.ok(enUS['chat.area.openAiControlTooltip'].includes('{username}'));
  assert.match(chatArea, /onClick=\{\(\) => togglePanel\(\{ kind: 'butler' \}\)\}/);
  assert.doesNotMatch(threadPanel, /共享 Agent/);
  assert.match(threadPanel, /t\('panels\.thread\.aiHosting'\)/);
  assert.doesNotMatch(zhCN['panels.thread.aiHosting'], /共享 Agent/);
  assert.match(hosting, /autoHostEnvironmentId/);
  assert.match(hosting, /fetchWorkItem\(workItemId\)/);
  assert.match(hosting, /await workspaceState\.ensureDefaultWorkspace\(\)/);
  assert.match(hosting, /isSystemCodexWorkspace\(workspaceRoot, defaultWorkspaceRoot, butlerWorkspaceRoot\)/);
  assert.match(agentPanel, /t\('agent\.panel\.autoHostLabel'\)/);
  assert.equal(zhCN['agent.panel.autoHostLabel'], '进入本房间时自动开启托管');
  assert.ok(enUS['agent.panel.autoHostLabel'].length > 0);
  assert.doesNotMatch(agentPanel, /state\.traces\[tmid\] \?\? \[\]/);
  assert.match(agentPanel, /useMemo\(\s*\(\) => allApprovals\.filter/);
  assert.match(agentPanel, /useMemo\(\s*\(\) => allMemberRequests\.filter/);
});
