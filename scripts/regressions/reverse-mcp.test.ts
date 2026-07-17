import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('反向 MCP 只暴露三个只读聊天上下文工具', async () => {
  const source = await readFile('apps/desktop/src-tauri/src/mcp.rs', 'utf8');
  assert.match(source, /rocketx_list_conversations/);
  assert.match(source, /rocketx_get_thread_context/);
  assert.match(source, /rocketx_get_room_history/);
  assert.match(source, /"readOnlyHint": true/);
  assert.doesNotMatch(source, /chat\.sendMessage|chat\.delete|chat\.update/);
  assert.match(source, /MCP_PROTOCOL_VERSION: &str = "2025-06-18"/);
});

test('反向 MCP 与 Bot 凭据只进系统凭据库，不进入启动参数或前端存储', async () => {
  const [mcp, bot, settings] = await Promise.all([
    readFile('apps/desktop/src-tauri/src/mcp.rs', 'utf8'),
    readFile('apps/desktop/src-tauri/src/agent_bot.rs', 'utf8'),
    readFile('apps/web/src/components/ReverseMcpSettings.tsx', 'utf8'),
  ]);
  assert.match(mcp, /keyring::Entry/);
  assert.match(bot, /keyring::Entry/);
  assert.doesNotMatch(`${mcp}\n${bot}`, /localStorage|sessionStorage/);
  assert.doesNotMatch(settings, /authToken.*mcpServers|ROCKETX_AUTH_TOKEN/);
  assert.match(settings, /args: \['--mcp'\]/);
});

test('Bot 仅负责完整回复，状态卡与审批仍不依赖 Bot 标记', async () => {
  const [bot, session] = await Promise.all([
    readFile('apps/desktop/src-tauri/src/agent_bot.rs', 'utf8'),
    readFile('apps/web/src/stores/sharedAgent.ts', 'utf8'),
  ]);
  assert.match(bot, /chat\.sendMessage/);
  assert.match(session, /message\.u\._id !== card\.hostUserId/);
  assert.match(session, /assertHost\(session, actor\(\)\)/);
});
