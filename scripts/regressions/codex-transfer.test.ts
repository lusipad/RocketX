import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  agentConversationLines,
  codexThreadDeepLink,
  transferTranscript,
} from '../../apps/web/src/agent/codexTransfer';

test('转移后的原生线程可用官方 deep link 在 Codex App 直接打开（issue #120）', () => {
  assert.equal(codexThreadDeepLink('019f7dcd-7b86-7c02-9ba6-7eadd0cf790d'), 'codex://threads/019f7dcd-7b86-7c02-9ba6-7eadd0cf790d');
  assert.throws(() => codexThreadDeepLink('../settings'), /threadId/);
});

test('对话渲染为转移线程首轮输入：开场白与 📌 标记行不转移，角色前缀正确', () => {
  const transcript = transferTranscript('管家对话', [
    { role: 'assistant', text: '我是你的管家。' },
    { role: 'user', text: '第一问' },
    { role: 'assistant', text: '📌 已记录记忆' },
    { role: 'assistant', text: '第一答' },
  ]);
  // 开场白（首个用户消息之前）与 📌 标记行不转移
  assert.doesNotMatch(transcript, /我是你的管家/);
  assert.doesNotMatch(transcript, /已记录记忆/);
  assert.match(transcript, /【用户】\n第一问/);
  assert.match(transcript, /【助手】\n第一答/);
  // 首轮输入自带接续说明与「只确认不开工」约束
  assert.match(transcript, /从 RocketX 转移过来的管家对话/);
  assert.match(transcript, /不要开始任何任务/);
});

test('没有可转移内容时明确报错', () => {
  assert.throws(
    () => transferTranscript('管家对话', [{ role: 'assistant', text: '欢迎' }]),
    /还没有可转移的对话内容/,
  );
});

test('托管会话消息转对话行：Codex 回复作 assistant，成员发言带说话人前缀', () => {
  assert.deepEqual(
    agentConversationLines([
      { text: '帮我看看这个函数', author: '张三', assistant: false },
      { text: '', author: '李四', assistant: false },
      { text: '这个函数的问题在于……', author: 'Codex', assistant: true },
    ]),
    [
      { role: 'user', text: '张三：帮我看看这个函数' },
      { role: 'assistant', text: '这个函数的问题在于……' },
    ],
  );
});

test('转移走 companion 同款机制：原生线程 + 命名 + 首轮输入，导入器路径退役', () => {
  // 核心机制：thread/start + thread/name/set(老 CLI 容错) + turn/start 首轮输入
  const lib = readFileSync('apps/web/src/agent/codexTransfer.ts', 'utf8');
  assert.match(lib, /export async function startNamedCodexThreadWithTranscript/);
  assert.match(lib, /'thread\/start'/);
  assert.match(lib, /'thread\/name\/set'/);
  assert.match(lib, /unknown \(variant\|method\)/);
  assert.match(lib, /'turn\/start'/);
  assert.match(lib, /effort: 'minimal'/);
  assert.match(lib, /return threadId/);
  assert.match(lib, /openCodexThread/);

  const codex = readFileSync('apps/web/src/stores/butlerCodex.ts', 'utf8');
  assert.match(codex, /export async function transferConversationToCodexApp/);
  assert.match(codex, /startNamedCodexThreadWithTranscript/);
  // 导入器弯路整体退役：不许再出现 externalAgentConfig/import 接线
  assert.doesNotMatch(codex, /externalAgentConfig/);

  const page = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  assert.match(page, /transferConversationToCodexApp/);
  assert.match(page, /转到 Codex/);

  // 群托管同样可转移：会话消息装载 + companion 机制 + 面板入口
  const shared = readFileSync('apps/web/src/stores/sharedAgent.ts', 'utf8');
  assert.match(shared, /transferToCodexApp/);
  assert.match(shared, /sessionConversationMessages/);
  assert.match(shared, /startNamedCodexThreadWithTranscript/);
  assert.doesNotMatch(shared, /externalAgentConfig/);
  const panel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');
  assert.match(panel, /转到 Codex App/);
  assert.match(panel, /openCodexThread/);

  const capability = readFileSync('apps/desktop/src-tauri/capabilities/default.json', 'utf8');
  assert.match(capability, /codex:\/\/threads\/\*/);
});
