import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeLanServerId } from '../../apps/web/src/lib/lanServerScope';

test('服务器自报的 uniqueID 作为 LAN 身份输入（issue #369）', () => {
  assert.equal(
    normalizeLanServerId('2cfa8f73-0198-4d12-99d0-9cbdd50f21dc'),
    '2cfa8f73-0198-4d12-99d0-9cbdd50f21dc',
  );
  assert.equal(normalizeLanServerId('  padded-id  '), 'padded-id');
});

test('拿不到可用的 uniqueID 时退回原生端的 URL 归一化（issue #369）', () => {
  // settings.public 读失败、老服务器没有这个设置、值被改成非字符串——
  // 这些情况都必须安静退回旧算法，而不是让整次 LAN 启动失败。
  for (const value of [undefined, null, '', '   ', 42, {}, ['id'], true]) {
    assert.equal(normalizeLanServerId(value), null, `value: ${JSON.stringify(value) ?? 'undefined'}`);
  }
  assert.equal(normalizeLanServerId('x'.repeat(257)), null, '超长值不进哈希');
  assert.equal(normalizeLanServerId(`bad${String.fromCharCode(0x7f)}id`), null, 'DEL 同样拒掉');
  assert.equal(normalizeLanServerId(`bad${String.fromCharCode(10)}id`), null, '换行同样拒掉');
});

test('LAN 启动把 serverId 传给原生端，且不改动 serverUrl（issue #369）', () => {
  const runtime = readFileSync('apps/web/src/lan/runtime.ts', 'utf8');

  assert.match(runtime, /normalizeLanServerId\(await getPublicSetting\('uniqueID'\)\)/);
  assert.match(runtime, /invoke<LanServiceInfo>\('lan_service_start', \{[\s\S]*?serverId,/);
  // serverUrl 同时是设备身份钥匙串的作用域（account_key），改了会让所有现存
  // 设备身份与信任固定失效，因此必须保持原样。
  assert.match(runtime, /serverUrl: serverUrl \|\| getServerBase\(\) \|\| location\.origin,/);
});

test('原生端指纹改由服务器身份决定，兜底保留（issue #369）', () => {
  const identity = readFileSync('apps/desktop/src-tauri/src/native/lan_identity.rs', 'utf8');
  const discovery = readFileSync('apps/desktop/src-tauri/src/native/lan_discovery.rs', 'utf8');
  const lan = readFileSync('apps/desktop/src-tauri/src/lan.rs', 'utf8');

  assert.match(identity, /fn server_fingerprint_for\(\s*server_url: &str,\s*server_id: Option<&str>,/);
  // 服务器身份与 URL 兜底要落在不同哈希域，避免两种算法意外相等。
  assert.match(identity, /const SERVER_ID_DOMAIN: &str = "rcx-lan-server-id/);
  // 读不到 uniqueID 时必须还能回到旧算法。
  assert.match(identity, /None => server_fingerprint\(server_url\)/);
  // 运行时身份用新入口取指纹。
  assert.match(discovery, /server_fingerprint: lan_identity::server_fingerprint_for\(server_url, server_id\)\?/);
  // 命令层把 serverId 透传下去。
  assert.match(lan, /server_id: Option<String>,/);
  assert.match(lan, /server_id\.as_deref\(\)/);
  // account_key 的作用域仍然只由接入 URL 决定。
  assert.match(identity, /pub\(crate\) fn account_key\(server_url: &str, user_id: &str\)/);
  assert.doesNotMatch(identity, /fn account_key\([^)]*server_id/);
});
