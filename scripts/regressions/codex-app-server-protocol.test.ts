import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_APP_SERVER_VERSION,
  SERVER_REQUEST_POLICIES,
  assertCodexHandshake,
  codexVersionFromUserAgent,
  serverRequestPolicy,
} from '../../apps/web/src/agent/protocol';

test('Codex app-server 从 userAgent 提取版本并核对同一进程握手', () => {
  const userAgent = `Codex Desktop/${CODEX_APP_SERVER_VERSION} (Windows; x86_64) dumb (rocketx; 0.21.0)`;
  assert.equal(codexVersionFromUserAgent(userAgent), CODEX_APP_SERVER_VERSION);
  assert.equal(assertCodexHandshake(userAgent, CODEX_APP_SERVER_VERSION), CODEX_APP_SERVER_VERSION);
  assert.equal(assertCodexHandshake('Codex Desktop/0.144.5 (Windows)', '0.144.5'), '0.144.5');
  assert.equal(
    assertCodexHandshake('Codex Desktop/0.145.0-alpha.18 (Windows)', '0.145.0-alpha.18'),
    '0.145.0-alpha.18',
  );
  assert.throws(() => assertCodexHandshake('Codex Desktop/0.144.5 (Windows)', '0.144.4'), /握手版本不一致/);
  assert.throws(() => assertCodexHandshake('unknown client', CODEX_APP_SERVER_VERSION), /无法识别/);
});

test('当前 11 类 server-initiated request 均有显式策略，未知类型安全拒绝', () => {
  assert.equal(Object.keys(SERVER_REQUEST_POLICIES).length, 11);
  assert.equal(serverRequestPolicy('item/commandExecution/requestApproval'), 'host-approval');
  assert.equal(serverRequestPolicy('currentTime/read'), 'local-safe');
  assert.equal(serverRequestPolicy('account/chatgptAuthTokens/refresh'), 'safe-reject');
  assert.equal(serverRequestPolicy('future/dangerous/request'), 'unknown');
});
