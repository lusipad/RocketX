import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_APP_SERVER_VERSION,
  SERVER_REQUEST_POLICIES,
  assertCompatibleCodex,
  codexVersionFromUserAgent,
  serverRequestPolicy,
} from '../../apps/web/src/agent/protocol';

test('Codex app-server 版本从初始化 userAgent 提取并严格锁定', () => {
  const userAgent = `Codex Desktop/${CODEX_APP_SERVER_VERSION} (Windows; x86_64) dumb (rocketx; 1.0.0)`;
  assert.equal(codexVersionFromUserAgent(userAgent), CODEX_APP_SERVER_VERSION);
  assert.doesNotThrow(() => assertCompatibleCodex(userAgent));
  assert.throws(() => assertCompatibleCodex('Codex Desktop/0.144.2 (Windows)'), /协议不兼容/);
  assert.throws(() => assertCompatibleCodex('unknown client'), /实际 未知/);
});

test('当前 11 类 server-initiated request 均有显式策略，未知类型安全拒绝', () => {
  assert.equal(Object.keys(SERVER_REQUEST_POLICIES).length, 11);
  assert.equal(serverRequestPolicy('item/commandExecution/requestApproval'), 'host-approval');
  assert.equal(serverRequestPolicy('currentTime/read'), 'local-safe');
  assert.equal(serverRequestPolicy('account/chatgptAuthTokens/refresh'), 'safe-reject');
  assert.equal(serverRequestPolicy('future/dangerous/request'), 'unknown');
});
