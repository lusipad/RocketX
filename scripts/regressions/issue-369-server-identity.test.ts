import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeLanServerId, resolveLanServerId } from '../../apps/web/src/lib/lanServerScope';
import type { PublicSettingResult } from '../../apps/web/src/lib/client';

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

  assert.match(runtime, /resolveLanServerId\(\(\) => readPublicSettingResult\('uniqueID'\)/);
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

/** 按顺序吐出给定结果的 uniqueID 读取器；记录调用次数与退避时长。 */
function scripted(results: PublicSettingResult[]) {
  const sleeps: number[] = [];
  let calls = 0;
  return {
    read: async () => results[Math.min(calls++, results.length - 1)],
    sleep: async (ms: number) => void sleeps.push(ms),
    calls: () => calls,
    sleeps,
  };
}

test('uniqueID 读取失败（限流/网络）时退避重试，而不是立刻退回 URL 指纹（issue #369）', async () => {
  // 一端读到 uniqueID、另一端因为一次 429 退回 URL，两端就永远发现不了对方；
  // 所以「这次没读到」必须重试，只有「服务端确实没有」才允许退回。
  const reader = scripted([{ status: 'failed' }, { status: 'failed' }, { status: 'found', value: ' srv-1 ' }]);
  const result = await resolveLanServerId(reader.read, { delaysMs: [10, 20, 30], sleep: reader.sleep });
  assert.deepEqual(result, { serverId: 'srv-1', outcome: 'server_id' });
  assert.equal(reader.calls(), 3);
  assert.deepEqual(reader.sleeps, [10, 20]);
});

test('服务端确实没有 uniqueID 时直接退回 URL 指纹，不做无意义的重试', async () => {
  const reader = scripted([{ status: 'missing' }]);
  const result = await resolveLanServerId(reader.read, { delaysMs: [10, 20], sleep: reader.sleep });
  assert.deepEqual(result, { serverId: null, outcome: 'missing' });
  assert.equal(reader.calls(), 1);
  assert.deepEqual(reader.sleeps, []);
});

test('uniqueID 的值不可用时按「服务端没有」处理', async () => {
  const reader = scripted([{ status: 'found', value: false }]);
  const result = await resolveLanServerId(reader.read, { delaysMs: [10], sleep: reader.sleep });
  assert.deepEqual(result, { serverId: null, outcome: 'missing' });
});

test('重试用尽仍读不到时才退回 URL 指纹，并如实报告 unavailable', async () => {
  const reader = scripted([{ status: 'failed' }]);
  const result = await resolveLanServerId(reader.read, { delaysMs: [10, 20], sleep: reader.sleep });
  assert.deepEqual(result, { serverId: null, outcome: 'unavailable' });
  assert.equal(reader.calls(), 3, '首次 + 每个退避档位各一次');
});

test('等待期间退出登录会取消，不再用过期的会话启动 LAN', async () => {
  const reader = scripted([{ status: 'failed' }, { status: 'found', value: 'srv' }]);
  let cancelled = false;
  const result = await resolveLanServerId(reader.read, {
    delaysMs: [10],
    sleep: async () => {
      cancelled = true;
    },
    isCancelled: () => cancelled,
  });
  assert.deepEqual(result, { serverId: null, outcome: 'cancelled' });
  assert.equal(reader.calls(), 1);
});
