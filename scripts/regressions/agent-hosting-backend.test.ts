import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';

test('AI 托管继承全局独占运行时，不再保存房间级后端偏好', () => {
  const panel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');
  const hosting = readFileSync('apps/web/src/lib/agentHosting.ts', 'utf8');
  const chat = readFileSync('apps/web/src/components/ChatArea.tsx', 'utf8');

  assert.match(panel, /state\.aiRuntimeProvider/);
  assert.match(panel, /backend: selectedBackend/);
  assert.match(panel, /agentBackend\(session\)/);
  assert.doesNotMatch(panel, /setSelectedBackend|roomHostingBackend|setRoomHostingBackend|setDefaultHostingBackend/);
  assert.doesNotMatch(panel, /托管后端/);
  assert.doesNotMatch(zhCN['agent.panel.backendLabel'], /托管后端/);
  assert.match(panel, /nextCodexRuntimeSummary/);
  assert.match(panel, /activeCodexRuntimeSummary/);
  assert.match(panel, /<span className="text-ink-3">\{t\('agent\.panel\.backendLabel'\)\}<\/span>/);
  assert.match(zhCN['agent.panel.backendLabel'], /^后端$/);
  assert.ok(enUS['agent.panel.backendLabel'].trim());
  assert.match(panel, /backendLabel\(agentBackend\(session\)\)/);
  assert.match(chat, /aria-label=\{t\('chat\.area\.configureAiHosting'\)\}/);
  assert.match(zhCN['chat.area.configureAiHosting'], /配置 AI 托管/);
  assert.ok(enUS['chat.area.configureAiHosting'].trim());

  assert.match(hosting, /const provider = useUI\.getState\(\)\.aiRuntimeProvider/);
  assert.match(hosting, /if \(provider === 'none'\) throw new Error\(t\('agent\.hosting\.aiDisabled'\)\)/);
  assert.match(zhCN['agent.hosting.aiDisabled'], /当前未启用 AI/);
  assert.ok(enUS['agent.hosting.aiDisabled'].trim());
  assert.match(hosting, /const backend = defaultHostingBackend\(\)/);
  assert.doesNotMatch(hosting, /DEFAULT_BACKEND_STORAGE_KEY|ROOM_BACKEND_STORAGE_KEY|roomHostingBackend|setRoomHostingBackend/);
});

test('Codex 专属动作只在 Codex 运行时出现，通用入口使用 AI 管家文案', () => {
  const runtime = readFileSync('apps/web/src/kernel/runtime.tsx', 'utf8');
  const messages = readFileSync('apps/web/src/components/MessageItem.tsx', 'utf8');
  const pullRequests = readFileSync('apps/web/src/components/AdoLists.tsx', 'utf8');
  const quickSwitcher = readFileSync('apps/web/src/components/QuickSwitcher.tsx', 'utf8');

  assert.match(runtime, /aiRuntimeProvider === 'pi'/);
  assert.match(runtime, /description: t\('settings\.kernel\.command\.summaryDesc'\)/);
  assert.match(zhCN['settings.kernel.command.summaryDesc'], /用 AI 管家总结当前会话未读消息/);
  assert.ok(enUS['settings.kernel.command.summaryDesc'].trim());
  assert.match(runtime, /description: t\('settings\.kernel\.command\.butlerDesc'\)/);
  assert.match(zhCN['settings.kernel.command.butlerDesc'], /打开 AI 管家，可直接跟上问题/);
  assert.ok(enUS['settings.kernel.command.butlerDesc'].trim());
  assert.match(messages, /features\.ai && getAiRuntimeProvider\(\) === 'pi'/);
  assert.match(messages, /t\('chat\.message\.aiExtractTodo'\)/);
  assert.match(zhCN['chat.message.aiExtractTodo'], /AI 提取为待办/);
  assert.ok(enUS['chat.message.aiExtractTodo'].trim());
  assert.match(pullRequests, /\{t\('workbench\.pr\.aiReviewButton'\)\}/);
  assert.match(zhCN['workbench.pr.aiReviewButton'], /AI 审查/);
  assert.ok(enUS['workbench.pr.aiReviewButton'].trim());
  assert.match(quickSwitcher, /handoffToButlerTask/);
});
