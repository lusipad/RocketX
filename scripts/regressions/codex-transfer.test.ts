import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  agentConversationLines,
  codexNewThreadDeepLink,
  transferTranscript,
} from '../../apps/web/src/agent/codexTransfer';

test('官方新对话 deep link 完整携带上下文和本地工作区（issue #105）', () => {
  const url = new URL(codexNewThreadDeepLink('第一行\n第二行', 'D:\\Repos\\rocketchatx'));
  assert.equal(url.protocol, 'codex:');
  assert.equal(url.host, 'threads');
  assert.equal(url.pathname, '/new');
  assert.equal(url.searchParams.get('prompt'), '第一行\n第二行');
  assert.equal(url.searchParams.get('path'), 'D:\\Repos\\rocketchatx');
  assert.throws(() => codexNewThreadDeepLink('', ''), /缺少上下文和工作区/);
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
  // 首轮输入自带接续说明，最后请求尚未完成时直接继续执行
  assert.match(transcript, /从 RocketX 转移过来的管家对话/);
  assert.match(transcript, /尚未完成的明确任务，直接继续执行/);
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

test('转移走 Codex App 官方新对话 deep link，不再创建列表可见但不可续的孤儿线程', () => {
  const lib = readFileSync('apps/web/src/agent/codexTransfer.ts', 'utf8');
  assert.match(lib, /codex:\/\/threads\/new/);
  assert.match(lib, /export async function openCodexNewThread/);
  assert.match(lib, /opened-with-copy/);
  assert.doesNotMatch(lib, /thread\/start|thread\/name\/set|turn\/start/);

  const codex = readFileSync('apps/web/src/stores/butlerCodex.ts', 'utf8');
  assert.match(codex, /export async function transferConversationToCodexApp/);
  assert.match(codex, /openCodexNewThread/);
  // 导入器弯路整体退役：不许再出现 externalAgentConfig/import 接线
  assert.doesNotMatch(codex, /externalAgentConfig/);

  const page = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  assert.match(page, /transferConversationToCodexApp/);
  assert.match(page, /转到 Codex/);

  // 群托管同样交给 Codex App：会话消息装载 + 官方 deep link + 面板入口
  const shared = readFileSync('apps/web/src/stores/sharedAgent.ts', 'utf8');
  assert.match(shared, /transferToCodexApp/);
  assert.match(shared, /sessionConversationMessages/);
  assert.match(shared, /openCodexNewThread/);
  assert.doesNotMatch(shared, /externalAgentConfig/);
  const panel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');
  assert.match(panel, /转到 Codex App/);
  assert.match(panel, /完整记录已填入，请确认后发送/);

  const capability = readFileSync('apps/desktop/src-tauri/capabilities/default.json', 'utf8');
  assert.match(capability, /codex:\/\/threads\/\*/);
});
