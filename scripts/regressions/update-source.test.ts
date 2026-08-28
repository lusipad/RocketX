import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  compareVersions,
  isNewerNativeUpdate,
  loadUpdateSource,
  manifestUrlOf,
  parseUpdateManifest,
  saveUpdateSource,
  type UpdateSourceStorage,
} from '../../apps/web/src/lib/updateSource';

class MemoryStorage implements UpdateSourceStorage {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

test('版本比较：三段数字、v 前缀与缺段容错', () => {
  assert.equal(compareVersions('0.25.2', '0.25.2'), 0);
  assert.equal(compareVersions('0.26.0', '0.25.2'), 1);
  assert.equal(compareVersions('0.25.1', '0.25.2'), -1);
  assert.equal(compareVersions('v1.0.0', '0.25.2'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 0);
});

test('更新清单解析：识别有无更新并取出 Windows 安装包地址', () => {
  const manifest = JSON.stringify({
    version: '0.26.0',
    notes: '管家更聪明了',
    platforms: {
      'windows-x86_64': { url: 'https://updates.example.com/RocketX_0.26.0_x64-setup.nsis.zip' },
      'linux-x86_64': { url: 'https://updates.example.com/RocketX_0.26.0_amd64.AppImage' },
    },
  });
  const probe = parseUpdateManifest(manifest, '0.25.2');
  assert.equal(probe.hasUpdate, true);
  assert.equal(probe.version, '0.26.0');
  assert.equal(probe.notes, '管家更聪明了');
  assert.match(probe.downloadUrl ?? '', /x64-setup\.nsis\.zip$/);

  const same = parseUpdateManifest(JSON.stringify({ version: '0.25.2', platforms: {} }), '0.25.2');
  assert.equal(same.hasUpdate, false);
});

test('更新清单解析：坏 JSON 与缺 version 都要人话报错', () => {
  assert.throws(() => parseUpdateManifest('not json', '0.25.2'), /有效 JSON/);
  assert.throws(() => parseUpdateManifest('{"notes":"x"}', '0.25.2'), /缺少 version/);
});

test('http 源清单地址：目录自动拼 latest.json，直给清单地址原样用', () => {
  assert.equal(manifestUrlOf('https://u.example.com/rocketx/'), 'https://u.example.com/rocketx/latest.json');
  assert.equal(manifestUrlOf('https://u.example.com/rocketx/latest.json'), 'https://u.example.com/rocketx/latest.json');
});

test('更新源配置：默认 GitHub，存取往返，坏数据回退默认', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(loadUpdateSource(storage), { kind: 'github', location: '' });

  saveUpdateSource({ kind: 'dir', location: ' \\\\server\\share\\rocketx ' }, storage);
  assert.deepEqual(loadUpdateSource(storage), { kind: 'dir', location: '\\\\server\\share\\rocketx' });

  storage.setItem('rcx-update-source', '{"kind":"pip"}');
  assert.equal(loadUpdateSource(storage).kind, 'github');
});

test('原生 updater 即使返回同版本或旧版本也不得提示更新（issue #300）', () => {
  assert.equal(isNewerNativeUpdate({ version: '0.40.2', currentVersion: '0.40.2' }), false);
  assert.equal(isNewerNativeUpdate({ version: '0.40.1', currentVersion: '0.40.2' }), false);
  assert.equal(isNewerNativeUpdate({ version: '0.40.3', currentVersion: '0.40.2' }), true);
  assert.equal(isNewerNativeUpdate(null), false);
});

test('Debug 构建不自动弹出正式版更新提示', () => {
  const bridge = readFileSync('apps/web/src/components/UpdaterBridge.tsx', 'utf8');

  assert.match(bridge, /import\.meta\.env\.DEV \|\| !isTauri \|\| checked/);
});

test('共享目录更新：helper 接管安装、单流程并由 Rust 完成交接退出（issue #304）', () => {
  const updateSource = readFileSync('apps/web/src/lib/updateSource.ts', 'utf8');
  const bridge = readFileSync('apps/web/src/components/UpdaterBridge.tsx', 'utf8');
  const settings = readFileSync('apps/web/src/pages/SettingsPage.tsx', 'utf8');
  const nativeProcess = readFileSync('apps/desktop/src-tauri/src/proc.rs', 'utf8');

  assert.match(updateSource, /export type UpdateInstallerType = 'nsis' \| 'msi'/);
  assert.match(updateSource, /expectedVersion/);
  assert.match(updateSource, /installerType/);
  assert.match(updateSource, /sha256/);
  assert.match(updateSource, /take_update_result/);
  assert.match(updateSource, /dirInstallInFlight/);
  assert.doesNotMatch(updateSource, /plugin-process/);
  assert.match(nativeProcess, /app\.exit\(0\)/);

  assert.match(bridge, /更新到 v\$\{probe\.version\} 并重启/);
  assert.match(settings, /更新到 v\$\{probe\.version\} 并重启/);
  assert.doesNotMatch(`${bridge}\n${settings}`, /请按安装向导完成更新/);
});

test('Windows NSIS 安装显式固定 currentUser，升级不切换到管理员用户上下文', () => {
  const slim = readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8');
  const full = readFileSync('apps/desktop/src-tauri/tauri.full.conf.json', 'utf8');
  assert.match(slim, /"nsis"\s*:\s*\{\s*"installMode"\s*:\s*"currentUser"/s);
  assert.match(full, /"nsis"\s*:\s*\{\s*"installMode"\s*:\s*"currentUser"/s);
});

test('共享目录更新：无 Minisign 时仍携带探测得到的 SHA-256，并明确提示未签名（issue #304）', () => {
  const updateSource = readFileSync('apps/web/src/lib/updateSource.ts', 'utf8');
  const bridge = readFileSync('apps/web/src/components/UpdaterBridge.tsx', 'utf8');
  const settings = readFileSync('apps/web/src/pages/SettingsPage.tsx', 'utf8');

  assert.match(updateSource, /signature\?: string/);
  assert.match(updateSource, /sha256: string/);
  assert.doesNotMatch(updateSource, /更新包缺少签名或安装类型/);
  assert.match(bridge, /未签名共享目录/);
  assert.match(settings, /共享目录可省略 signature/);
});

test('原生更新按钮点击时重新检查，不长期持有启动检查返回的资源（issue #300）', () => {
  const bridge = readFileSync('apps/web/src/components/UpdaterBridge.tsx', 'utf8');
  const settings = readFileSync('apps/web/src/pages/SettingsPage.tsx', 'utf8');

  assert.match(bridge, /const freshUpdate = await checkGithubUpdate\(\)/);
  assert.match(bridge, /const freshUpdate = await checkHttpUpdate\(config\.location\)/);
  assert.doesNotMatch(settings, /signedUpdate/);
  assert.match(settings, /const found = config\.kind === 'github'[\s\S]*checkGithubUpdate\(\)[\s\S]*checkHttpUpdate\(config\.location\)/);
});

test('原生更新失败时复用下载提示展示错误，不留下永久 loading（issue #300）', () => {
  const bridge = readFileSync('apps/web/src/components/UpdaterBridge.tsx', 'utf8');
  const settings = readFileSync('apps/web/src/pages/SettingsPage.tsx', 'utf8');

  assert.equal((bridge.match(/toast\.update\(toastId, \{ kind: 'error'/g) ?? []).length, 3);
  assert.equal((settings.match(/toast\.update\(toastId, \{ kind: 'error'/g) ?? []).length, 2);
});
