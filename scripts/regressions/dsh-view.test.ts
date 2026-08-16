import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('Butler DeepSeek 视图改为官方 DSH Web iframe host，并移除自绘运行时', () => {
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const navigation = readFileSync('apps/web/src/components/NavRail.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/DshConversation.tsx', 'utf8');
  const questionCard = readFileSync('apps/web/src/components/DshQuestionCard.tsx', 'utf8');
  const agentPanel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');
  const styles = readFileSync('apps/web/src/styles.css', 'utf8');
  const tauri = readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8');

  assert.match(page, /import DshConversation from '\.\.\/components\/DshConversation';/);
  assert.doesNotMatch(page, /ButlerHostingOverview/);
  assert.match(page, /aiRuntimeProvider === 'deepseek'[\s\S]*<DshConversation \/>/);
  assert.doesNotMatch(page, /aiRuntimeProvider === 'deepseek'[\s\S]*<ManagedSurface><DshConversation \/><\/ManagedSurface>/);
  assert.match(page, /<ButlerConversation embedded \/>/);
  assert.doesNotMatch(page, /butler-task-provider-switcher|执行视图|role="tab"/);

  assert.doesNotMatch(navigation, /管家执行引擎|setButlerTaskProvider|\(\['codex', 'deepseek'\] as const\)\.map/);

  assert.match(conversation, /import \{ DshController \} from '\.\.\/agent\/dsh\/DshController';/);
  assert.match(conversation, /useCodexWorkspace\.getState\(\)/);
  assert.match(conversation, /ensureDefaultWorkspace\(\)/);
  assert.doesNotMatch(conversation, /WORKSPACE_STORAGE_KEY|localStorage|persistWorkspaceRoot|savedWorkspaceRoot/);
  assert.match(conversation, /new DshController\([\s\S]*connectionId: 'butler-web', mode: 'web'/);
  assert.match(conversation, /const nextUrl = await activeController\.start\(\)/);
  assert.match(conversation, /type:\s*'rocketx:dsh-open-new-session'/);
  assert.match(conversation, /workspacePath:\s*workspaceRoot/);
  assert.match(conversation, /type:\s*'rocketx:dsh-focus-session'/);
  assert.match(conversation, /DSH_FRAME_REQUEST_TIMEOUT_MS\s*=\s*12_000/);
  assert.match(conversation, /selectedHostedSessionKey && !selectedPersonalDshSessionId && !focusSessionId/);
  assert.match(conversation, /requestKey: `personal:\$\{selectedPersonalDshSessionId\}:\$\{selectedPersonalDshFocusNonce\}`/);
  assert.match(conversation, /const focusRequestKey = focusTarget\?\.requestKey \?\? null/);
  assert.match(conversation, /已打开你的私人房间会话/);
  assert.match(conversation, /不会新建另一条会话/);
  assert.match(conversation, /type:\s*'rocketx:dsh-ack'/);
  assert.match(conversation, /type:\s*'rocketx:dsh-error'/);
  assert.match(conversation, /frameWindow\.postMessage\(request, targetOrigin\)/);
  assert.match(conversation, /await activeController\.stop\(\)\.catch\(\(\) => undefined\);/);
  assert.match(conversation, /void activeController\?\.stop\(\)\.catch\(\(\) => undefined\);/);
  assert.match(conversation, /title="DSH 原生会话"/);
  assert.match(conversation, /<iframe[\s\S]*className="dsh-web-frame"/);
  assert.match(conversation, /sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"/);
  assert.match(conversation, /allow="clipboard-write"/);
  assert.match(conversation, /className="dsh-web-host"/);
  assert.doesNotMatch(conversation, /butler-conversation-pane/);
  assert.match(conversation, /DSH 原生会话仅支持 RocketX 桌面端/);
  assert.match(conversation, /DSH 原生会话启动失败/);
  assert.doesNotMatch(conversation, /DeepSeek 运行配置|DeepSeek API Key|respondApproval|respondQuestion|DshConfigurationCard|DshConversationHistory|DshConversationShared/);

  assert.match(questionCard, /className="dsh-question-card"/);
  assert.match(questionCard, /DeepSeek 需要更多信息/);

  assert.match(agentPanel, /import DshQuestionCard from '\.\/DshQuestionCard';/);
  assert.match(agentPanel, /prepareSharedDshStartConfiguration/);
  assert.match(agentPanel, /nextDshRuntimeSummary/);
  assert.match(agentPanel, /aria-label="DSH AI 托管模型"/);
  assert.match(agentPanel, /aria-label="DSH AI 托管 Agent"/);
  assert.match(agentPanel, /aria-label="DSH AI 托管权限"/);
  assert.doesNotMatch(agentPanel, /useDshWorkspace/);

  assert.match(styles, /\.dsh-web-host\s*\{/);
  assert.match(styles, /\.dsh-web-frame\s*\{/);
  assert.match(styles, /\.dsh-question-card\s*\{/);
  assert.doesNotMatch(styles, /\.butler-task-provider-(?:shell|switcher)/);
  assert.doesNotMatch(styles, /\.dsh-conversation-history\s*\{/);
  assert.doesNotMatch(styles, /\.dsh-configuration-card\s*\{/);
  assert.doesNotMatch(styles, /\.dsh-queue\s*\{/);

  assert.match(tauri, /frame-src 'self' data: blob: http:\/\/127\.0\.0\.1:\*;/);

  assert.equal(existsSync('apps/web/src/agent/dsh/config.ts'), false);
  assert.equal(existsSync('apps/web/src/stores/dshWorkspace.ts'), false);
  assert.equal(existsSync('apps/web/src/components/DshConversationHistory.tsx'), false);
  assert.equal(existsSync('apps/web/src/components/DshConversationShared.ts'), false);
});
