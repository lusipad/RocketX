import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { codexPlatformSpec } from '../prepare-codex-resource.mjs';

test('Codex 资源准备覆盖桌面工作流的 Windows、macOS 与 Linux 目标', () => {
  assert.deepEqual(codexPlatformSpec('win32', 'x64'), {
    packageName: '@openai/codex-win32-x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    executable: 'codex.exe',
  });
  assert.deepEqual(codexPlatformSpec('darwin', 'arm64'), {
    packageName: '@openai/codex-darwin-arm64',
    targetTriple: 'aarch64-apple-darwin',
    executable: 'codex',
  });
  assert.deepEqual(codexPlatformSpec('darwin', 'x64'), {
    packageName: '@openai/codex-darwin-x64',
    targetTriple: 'x86_64-apple-darwin',
    executable: 'codex',
  });
  assert.deepEqual(codexPlatformSpec('linux', 'x64'), {
    packageName: '@openai/codex-linux-x64',
    targetTriple: 'x86_64-unknown-linux-musl',
    executable: 'codex',
  });
  assert.throws(() => codexPlatformSpec('freebsd', 'x64'), /不支持/);
});

test('默认桌面构建不准备或捆绑 Codex 平台资源', async () => {
  const config = JSON.parse(
    await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'),
  ) as {
    build: { beforeBuildCommand: string; beforeDevCommand: string };
    bundle: { resources: Record<string, string> };
  };
  assert.doesNotMatch(config.build.beforeBuildCommand, /prepare:codex/);
  assert.doesNotMatch(config.build.beforeDevCommand, /prepare:codex/);
  assert.equal(config.bundle.resources['target/codex-resources/codex/'], undefined);
});

test('full 安装包显式带入 Codex 与 OCR 并落到更新不会覆盖的位置', async () => {
  const [configText, hooks] = await Promise.all([
    readFile('apps/desktop/src-tauri/tauri.full.conf.json', 'utf8'),
    readFile('apps/desktop/src-tauri/windows/full-installer-hooks.nsh', 'utf8'),
  ]);
  const config = JSON.parse(configText) as {
    bundle: {
      createUpdaterArtifacts: boolean;
      resources: Record<string, string>;
      windows: { nsis: { installerHooks: string } };
    };
  };
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(
    config.bundle.resources['target/codex-resources/codex/'],
    'full-resources/codex/',
  );
  assert.equal(
    config.bundle.resources['target/ocr-resources/ocr/'],
    'full-resources/ocr/',
  );
  assert.equal(
    config.bundle.windows.nsis.installerHooks,
    './windows/full-installer-hooks.nsh',
  );
  assert.match(hooks, /\$LOCALAPPDATA\\RocketX\\resources\\codex/);
  assert.match(hooks, /\$LOCALAPPDATA\\RocketX\\resources\\ocr/);
  assert.match(hooks, /RMDir \/r "\$INSTDIR\\full-resources"/);
});
