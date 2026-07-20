import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rocketxThreadName, workspaceLabel } from '../../apps/web/src/agent/threadName';

test('RocketX 线程名带场景与明细，空白折叠、超长安全截断', () => {
  assert.equal(rocketxThreadName('AI 大脑'), 'RocketX AI 大脑');
  assert.equal(rocketxThreadName('托管', '#123 修复登录'), 'RocketX 托管 · #123 修复登录');
  assert.equal(rocketxThreadName('托管', '  项目\n群  '), 'RocketX 托管 · 项目 群');
  assert.equal(rocketxThreadName('托管', ''), 'RocketX 托管');
  const long = rocketxThreadName('托管', 'x'.repeat(200));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
  assert.equal(workspaceLabel('D:\\Repos\\rocketchatx'), 'rocketchatx');
  assert.equal(workspaceLabel('/home/user/project/'), 'project');
  assert.equal(workspaceLabel(undefined), undefined);
});

test('托管/执行间/AI 大脑线程在 Codex 会话库里都有可辨认的名字', () => {
  const client = readFileSync('apps/web/src/agent/protocol/client.ts', 'utf8');
  assert.match(client, /'thread\/name\/set': \{ params: ThreadSetNameParams; result: ThreadSetNameResponse \}/);

  // 三条创建原生线程的路径（含 resume，旧线程补名）都要命名
  const shared = readFileSync('apps/web/src/stores/sharedAgent.ts', 'utf8');
  assert.match(shared, /rocketxThreadName\('托管'/);
  assert.equal(shared.match(/nameCodexThread\(appServer, /gu)?.length, 2);
  const local = readFileSync('apps/web/src/stores/localCodex.ts', 'utf8');
  assert.equal(local.match(/rocketxThreadName\('执行间'/gu)?.length, 2);
  const butler = readFileSync('apps/web/src/stores/butlerCodex.ts', 'utf8');
  assert.match(butler, /rocketxThreadName\('AI 大脑'\)/);

  // 托管面板给出原生线程的 codex resume 入口
  const panel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');
  assert.match(panel, /codex resume \$\{session\.codexThreadId\}/);
});
