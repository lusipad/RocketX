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

test('桌面构建先准备 Codex 平台资源并交给 Tauri 捆绑', async () => {
  const config = JSON.parse(
    await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'),
  ) as {
    build: { beforeBuildCommand: string; beforeDevCommand: string };
    bundle: { resources: Record<string, string> };
  };
  assert.match(config.build.beforeBuildCommand, /^pnpm -w prepare:codex && /);
  assert.match(config.build.beforeDevCommand, /^pnpm -w prepare:codex && /);
  assert.equal(
    config.bundle.resources['target/codex-resources/codex/'],
    'codex/',
  );
});
