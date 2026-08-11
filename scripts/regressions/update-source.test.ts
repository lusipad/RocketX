import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  compareVersions,
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

test('共享目录更新：helper 接管安装、单流程并在交接后真正退出', () => {
  const updateSource = readFileSync('apps/web/src/lib/updateSource.ts', 'utf8');
  const bridge = readFileSync('apps/web/src/components/UpdaterBridge.tsx', 'utf8');
  const settings = readFileSync('apps/web/src/pages/SettingsPage.tsx', 'utf8');

  assert.match(updateSource, /export type UpdateInstallerType = 'nsis' \| 'msi'/);
  assert.match(updateSource, /expectedVersion/);
  assert.match(updateSource, /installerType/);
  assert.match(updateSource, /take_update_result/);
  assert.match(updateSource, /dirInstallInFlight/);
  assert.match(updateSource, /await exit\(0\)/);

  assert.match(bridge, /更新到 v\$\{probe\.version\} 并重启/);
  assert.match(settings, /更新到 v\$\{probe\.version\} 并重启/);
  assert.doesNotMatch(`${bridge}\n${settings}`, /请按安装向导完成更新/);
});
