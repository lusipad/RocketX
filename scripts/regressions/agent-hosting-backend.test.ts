import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('AI 托管支持 Codex/DeepSeek 后端偏好，并对 DeepSeek 隐藏 Codex 细节', () => {
  const panel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');
  const hosting = readFileSync('apps/web/src/lib/agentHosting.ts', 'utf8');
  const chat = readFileSync('apps/web/src/components/ChatArea.tsx', 'utf8');

  assert.match(panel, /import \{ agentBackend, type AgentBackend, type AgentSession \} from '\.\.\/agent\/session';/);
  assert.match(panel, /const \[selectedBackend, setSelectedBackend\] = useState<AgentBackend>\('codex'\)/);
  assert.match(panel, /roomHostingBackend\(rid\) \?\? defaultHostingBackend\(\)/);
  assert.match(panel, /agentBackend\(session\)/);
  assert.match(panel, /setDefaultHostingBackend\(backend\)/);
  assert.match(panel, /setRoomHostingBackend\(rid, backend\)/);
  assert.match(panel, /backend: selectedBackend/);
  assert.doesNotMatch(panel, /agentBackend: selectedBackend/);
  assert.match(panel, /DeepSeek 使用 DSH 原生模型、Agent 和权限配置/);
  assert.match(panel, /dshRuntimeSummary/);
  assert.match(panel, /openButlerConversation\('deepseek'\)/);
  assert.match(panel, /<span className="text-ink-3">后端<\/span>/);
  assert.match(panel, /backendLabel\(currentBackend\)/);
  assert.match(chat, /aria-label="配置 AI 托管"/);
  assert.match(chat, /onClick=\{\(\) => setPanel\(\{ kind: 'agent', tmid: agentSessionKey \}\)\}/);
  assert.doesNotMatch(chat, /onClick=\{\(\) => void startHosting\(\)\}/);

  assert.match(hosting, /import type \{ AgentBackend \} from '\.\.\/agent\/session';/);
  assert.match(hosting, /const DEFAULT_BACKEND_STORAGE_KEY = 'rcx-agent-default-backend-v1';/);
  assert.match(hosting, /const ROOM_BACKEND_STORAGE_KEY = 'rcx-agent-room-backend-v1';/);
  assert.match(hosting, /export function defaultHostingBackend\(\): AgentBackend/);
  assert.match(hosting, /export function roomHostingBackend\(rid: string\): AgentBackend \| undefined/);
  assert.match(hosting, /options: \{ preferredEnvironmentId\?: string; workspaceRoot\?: string; backend\?: AgentBackend \} = \{\}/);
  assert.match(hosting, /const backend = options\.backend \?\? roomHostingBackend\(rid\) \?\? defaultHostingBackend\(\)/);
  assert.match(hosting, /setDefaultHostingBackend\(backend\)/);
  assert.match(hosting, /setRoomHostingBackend\(rid, backend\)/);
  assert.match(hosting, /backend,/);
  assert.doesNotMatch(hosting, /agentBackend:/);
});

test('固定后端能力在界面上明确标注 Codex，不冒充通用 AI 能力', () => {
  const summary = readFileSync('apps/web/src/components/SummaryPanel.tsx', 'utf8');
  const runtime = readFileSync('apps/web/src/kernel/runtime.tsx', 'utf8');
  const chat = readFileSync('apps/web/src/components/ChatArea.tsx', 'utf8');
  const messages = readFileSync('apps/web/src/components/MessageItem.tsx', 'utf8');
  const selectedMessages = readFileSync('apps/web/src/components/MessageList.tsx', 'utf8');
  const pullRequests = readFileSync('apps/web/src/components/AdoLists.tsx', 'utf8');

  assert.match(summary, />Codex 会话总结</);
  assert.match(summary, /正在读取历史并调用 Codex/);
  assert.match(runtime, /description: '用 Codex 总结当前会话未读消息'/);
  assert.match(runtime, /description: '打开 Codex，可直接跟上问题'/);
  assert.match(chat, /打开房间 Codex/);
  assert.match(messages, /Codex 提取为待办/);
  assert.match(messages, /Codex 提取为工作项/);
  assert.match(selectedMessages, /让 Codex 从这些消息里提取承诺/);
  assert.match(selectedMessages, /让 Codex 总结这段对话/);
  assert.match(pullRequests, />\s*Codex 审查\s*</);
});
