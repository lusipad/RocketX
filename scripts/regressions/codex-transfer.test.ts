import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { agentConversationLines, claudeSessionJsonl } from '../../apps/web/src/agent/codexTransfer';

test('对话导出为导入器认可的 JSONL：uuid 链式串联，用户/助手消息形态正确', () => {
  const jsonl = claudeSessionJsonl(
    [
      { role: 'assistant', text: '我是你的 AI。' },
      { role: 'user', text: '第一问' },
      { role: 'assistant', text: '📌 已记录记忆' },
      { role: 'assistant', text: '第一答' },
    ],
    { sessionId: 'session-1', cwd: '/work', now: 1_000_000 },
  );
  const rows = jsonl.trim().split('\n').map((row) => JSON.parse(row) as Record<string, any>);
  // 开场白（首个用户消息之前）与 📌 标记行不导出
  assert.deepEqual(rows.map((row) => row.type), ['user', 'assistant']);
  assert.equal(rows[0].message.content, '第一问');
  assert.deepEqual(rows[1].message.content, [{ type: 'text', text: '第一答' }]);
  // uuid 链：第二行的 parentUuid 指向第一行
  assert.equal(rows[0].parentUuid, null);
  assert.equal(rows[1].parentUuid, rows[0].uuid);
  for (const row of rows) {
    assert.equal(row.sessionId, 'session-1');
    assert.equal(row.cwd, '/work');
    assert.equal(row.isSidechain, false);
    assert.match(row.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('没有可转移内容时明确报错', () => {
  assert.throws(
    () => claudeSessionJsonl([{ role: 'assistant', text: '欢迎' }], { sessionId: 's', cwd: '/', now: 0 }),
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

test('转移走官方 externalAgentConfig/import（与 codex-plugin-cc 同款机制）', () => {
  const client = readFileSync('apps/web/src/agent/protocol/client.ts', 'utf8');
  assert.match(client, /'externalAgentConfig\/import'/);

  // 共享导入模块：等待完成通知，且带提前到达缓冲（通知可能先于请求响应）
  const importLib = readFileSync('apps/web/src/agent/codexImport.ts', 'utf8');
  assert.match(importLib, /export async function importSessionFileToCodex/);
  assert.match(importLib, /completedImports/);

  const codex = readFileSync('apps/web/src/stores/butlerCodex.ts', 'utf8');
  assert.match(codex, /export async function transferConversationToCodexApp/);
  assert.match(codex, /externalAgentConfig\/import\/completed/);
  assert.match(codex, /dispatchCodexImportCompleted/);

  const page = readFileSync('apps/web/src/pages/AiAssistantPage.tsx', 'utf8');
  assert.match(page, /transferConversationToCodexApp/);
  assert.match(page, /转到 Codex/);
});
