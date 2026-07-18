import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { claudeSessionJsonl } from '../../apps/web/src/agent/codexTransfer';

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

test('转移走官方 externalAgentConfig/import，App 才会显示（appServer 来源默认被过滤）', () => {
  const client = readFileSync('apps/web/src/agent/protocol/client.ts', 'utf8');
  assert.match(client, /'externalAgentConfig\/import'/);

  const codex = readFileSync('apps/web/src/stores/butlerCodex.ts', 'utf8');
  assert.match(codex, /export async function transferConversationToCodexApp/);
  assert.match(codex, /externalAgentConfig\/import\/completed/);
  // 通知可能先于请求响应到达，必须有提前到达缓冲
  assert.match(codex, /completedImports/);

  const page = readFileSync('apps/web/src/pages/AiAssistantPage.tsx', 'utf8');
  assert.match(page, /transferConversationToCodexApp/);
  assert.match(page, /转到 Codex/);
});
