import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const pluginRoot = new URL('../../plugins/intranet-link/', import.meta.url);
const manifestText = readFile(new URL('rcx.app.json', pluginRoot), 'utf8');
const entryText = readFile(new URL('index.html', pluginRoot), 'utf8');
const sidecarText = readFile(new URL('native/src/runtime.rs', pluginRoot), 'utf8');
const sidecarMainText = readFile(new URL('native/src/main.rs', pluginRoot), 'utf8');
const runtimeText = readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8');
const nativeHostText = readFile(new URL('../../apps/desktop/src-tauri/src/native_service.rs', import.meta.url), 'utf8');
const desktopMainText = readFile(new URL('../../apps/desktop/src-tauri/src/main.rs', import.meta.url), 'utf8');
const bundledAppsText = readFile(new URL('../../apps/web/src/kernel/bundled.ts', import.meta.url), 'utf8');

function capabilityContract(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/capabilityBus\.register\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)]
      .map((match) => [match[1], match[2]]),
  );
}

test('飞鸽插件以 iframe 加签名 native service 运行并声明最小权限', async () => {
  const manifest = JSON.parse(await manifestText) as {
    runtime: string;
    entry: string;
    enabledByDefault: boolean;
    permissions: string[];
    service?: { runtime?: string; command?: string; platforms?: string[]; protocol?: string };
  };
  assert.equal(manifest.runtime, 'iframe');
  assert.equal(manifest.entry, 'index.html');
  assert.equal(manifest.enabledByDefault, false);
  assert.deepEqual(manifest.permissions, ['native:service', 'storage:local', 'files:read', 'ui:notify']);
  assert.deepEqual(manifest.service, {
    runtime: 'native',
    command: 'rcx-plugin-intranet-link',
    platforms: ['windows'],
    protocol: 'jsonrpc-stdio',
  });
  await stat(new URL(manifest.entry, pluginRoot));

  const html = await entryText;
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
  for (const script of [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]) {
    assert.doesNotThrow(() => new Function(script[1]));
  }
  const methods = [...html.matchAll(/\bcall\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  const methodPermissions = capabilityContract(await runtimeText);
  for (const method of methods) {
    const permission = methodPermissions.get(method);
    assert.ok(permission, `插件调用了未知 capability: ${method}`);
    assert.ok(manifest.permissions.includes(permission), `插件调用 ${method} 但未声明 ${permission}`);
  }
});

test('本地文件路径只能来自宿主文件选择器再传给签名 sidecar', async () => {
  const html = await entryText;
  const runtime = await runtimeText;
  assert.match(html, /call\('files\.pick',\{\}\)/);
  assert.match(html, /nativeCall\('offerFile',\{peerId:selectedPeer\.id,path:selected\.path\}\)/);
  assert.match(runtime, /capabilityBus\.register\('files\.pick', 'files:read'/);
  assert.match(runtime, /@tauri-apps\/plugin-dialog/);
  assert.match(runtime, /capabilityBus\.register\('native\.call', 'native:service'/);
  assert.match(runtime, /app\.source\.kind !== 'bundled'/);
});

test('启停生命周期只经过通用 native service 宿主', async () => {
  const runtime = await runtimeText;
  const desktop = await desktopMainText;
  assert.match(runtime, /startNativeService\(app\)/);
  assert.match(runtime, /native_service_stop/);
  assert.match(runtime, /bridgeHost\.emit\(payload\.appId, 'native\.event'/);
  assert.match(desktop, /native_service::native_service_start/);
  assert.match(desktop, /native_service::native_service_call/);
  assert.match(desktop, /native_service::shutdown\(app\)/);
  assert.doesNotMatch(runtime, /ipmsg|feiq|shiyeline|2425|9011/i);
  assert.doesNotMatch(desktop, /ipmsg|feiq|shiyeline|2425|9011/i);
  assert.match(await bundledAppsText, /plugins\/intranet-link\/rcx\.app\.json\?raw/);
});

test('通用宿主拒绝 PATH 查找与目录逃逸并限制 JSON 帧', async () => {
  const host = await nativeHostText;
  const tauriConfig = JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8')) as {
    bundle?: { resources?: Record<string, string> };
  };
  assert.match(host, /value\.starts_with\("rcx-plugin-"\)/);
  assert.match(host, /contained_file\(&root/);
  assert.match(host, /!file\.starts_with\(&root\)/);
  assert.match(host, /MAX_FRAME_BYTES: usize = 1024 \* 1024/);
  assert.match(host, /CALL_TIMEOUT/);
  assert.match(host, /stdin\.take\(\)/);
  assert.match(host, /child\.kill\(\)/);
  assert.deepEqual(tauriConfig.bundle?.resources, { 'resources/plugins/': 'plugins/' });
  assert.match(
    (tauriConfig as { build?: { beforeBuildCommand?: string } }).build?.beforeBuildCommand ?? '',
    /^pnpm -w prepare:sidecars && /,
  );
});

test('协议、编码、2425 发现和文件传输全部留在插件 sidecar', async () => {
  const sidecar = await sidecarText;
  assert.match(sidecar, /IPMSG_PORT: u16 = 2425/);
  assert.match(sidecar, /version\.starts_with\("1_lbt"\)/);
  assert.match(sidecar, /version\.starts_with\("1@shiyeline"\)/);
  assert.match(sidecar, /GBK/);
  assert.match(sidecar, /TcpListener/);
  assert.match(sidecar, /MAX_DISCOVERY_TARGETS: usize = 1024/);
  assert.doesNotMatch(sidecar, /9011|INTRANET_PORT/);
  assert.match(await sidecarMainText, /"jsonrpc": "2\.0"/);
});

test('插件自己持久化设置和消息，并对原版内网通禁用文件入口', async () => {
  const html = await entryText;
  assert.match(html, /storage\.set/);
  assert.match(html, /key:'settings'/);
  assert.match(html, /key:'messages'/);
  assert.match(html, /peer\.dialect!=='intranet'/);
  assert.match(html, /原版内网通只支持 2425 文本/);
  assert.match(html, /nativeCall\('start'/);
  assert.match(html, /nativeCall\('validateDiscoveryRanges'/);
});
