import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('AI 托管继承全局独占运行时，不再保存房间级后端偏好', () => {
  const panel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');
  const hosting = readFileSync('apps/web/src/lib/agentHosting.ts', 'utf8');
  const chat = readFileSync('apps/web/src/components/ChatArea.tsx', 'utf8');

  assert.match(panel, /state\.aiRuntimeProvider/);
  assert.match(panel, /backend: selectedBackend/);
  assert.match(panel, /agentBackend\(session\)/);
  assert.doesNotMatch(panel, /setSelectedBackend|roomHostingBackend|setRoomHostingBackend|setDefaultHostingBackend/);
  assert.doesNotMatch(panel, /托管后端/);
  assert.match(panel, /nextDshRuntimeSummary/);
  assert.match(panel, /activeDshRuntimeSummary/);
  assert.match(panel, /<span className="text-ink-3">后端<\/span>/);
  assert.match(panel, /backendLabel\(agentBackend\(session\)\)/);
  assert.match(chat, /aria-label="配置 AI 托管"/);

  assert.match(hosting, /const provider = useUI\.getState\(\)\.aiRuntimeProvider/);
  assert.match(hosting, /if \(provider === 'none'\) throw new Error\('当前未启用 AI'\)/);
  assert.match(hosting, /const backend = defaultHostingBackend\(\)/);
  assert.doesNotMatch(hosting, /DEFAULT_BACKEND_STORAGE_KEY|ROOM_BACKEND_STORAGE_KEY|roomHostingBackend|setRoomHostingBackend/);
});

test('Codex 专属动作只在 Codex 运行时出现，通用入口使用 AI 管家文案', () => {
  const runtime = readFileSync('apps/web/src/kernel/runtime.tsx', 'utf8');
  const messages = readFileSync('apps/web/src/components/MessageItem.tsx', 'utf8');
  const pullRequests = readFileSync('apps/web/src/components/AdoLists.tsx', 'utf8');
  const quickSwitcher = readFileSync('apps/web/src/components/QuickSwitcher.tsx', 'utf8');

  assert.match(runtime, /aiRuntimeProvider === 'codex'/);
  assert.match(runtime, /description: '用 AI 管家总结当前会话未读消息'/);
  assert.match(runtime, /description: '打开 AI 管家，可直接跟上问题'/);
  assert.match(messages, /features\.ai && getAiRuntimeProvider\(\) === 'codex'/);
  assert.match(messages, /Codex 提取为待办/);
  assert.match(pullRequests, />\s*AI 审查\s*</);
  assert.match(quickSwitcher, /handoffToButlerTask/);
});
