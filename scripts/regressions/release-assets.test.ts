import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const verifier = path.join(repoRoot, 'scripts/verify-release-assets.mjs');

async function currentVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  return manifest.version;
}

async function createWindowsReleaseFixture(options: {
  extraAssets?: Record<string, Uint8Array>;
  extraPlatforms?: Record<string, { url: string; signature: string }>;
} = {}): Promise<{ directory: string; version: string }> {
  const version = await currentVersion();
  const directory = await mkdtemp(path.join(tmpdir(), 'rocketx-windows-release-'));
  const installer = `RocketX_${version}_x64-setup.exe`;
  const msi = `RocketX_${version}_x64_en-US.msi`;
  const platforms = {
    'windows-x86_64': {
      url: `https://updates.example.com/${installer}`,
      signature: 'windows-signature',
    },
    'windows-x86_64-msi': {
      url: `https://updates.example.com/${msi}`,
      signature: 'windows-msi-signature',
    },
    ...options.extraPlatforms,
  };
  const updater = JSON.stringify({
    version,
    notes: 'Windows-only release fixture. '.repeat(64),
    pub_date: '2026-07-23T00:00:00Z',
    platforms,
  });

  await Promise.all([
    writeFile(path.join(directory, installer), Buffer.alloc(1_024, 1)),
    writeFile(path.join(directory, `${installer}.sig`), 'windows-signature'),
    writeFile(path.join(directory, msi), Buffer.alloc(1_024, 2)),
    writeFile(path.join(directory, `${msi}.sig`), 'windows-msi-signature'),
    writeFile(path.join(directory, 'latest.json'), updater),
    writeFile(path.join(directory, `rocketx-plugins-${version}.zip`), Buffer.alloc(1_024, 3)),
    ...Object.entries(options.extraAssets ?? {}).map(([name, content]) =>
      writeFile(path.join(directory, name), content),
    ),
  ]);

  return { directory, version };
}

function runVerifier(directory: string, version: string) {
  return spawnSync(process.execPath, [verifier, '--tag', `v${version}`, '--directory', directory], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('Windows-only 发布资产不依赖 macOS 或 Linux 安装包', async () => {
  const fixture = await createWindowsReleaseFixture();
  try {
    const result = runVerifier(fixture.directory, fixture.version);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Verified Windows release assets/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('Windows-only 发布拒绝残留的跨平台资产', async () => {
  const fixture = await createWindowsReleaseFixture({
    extraAssets: {
      [`RocketX_0.0.0_amd64.AppImage`]: Buffer.alloc(1_024, 4),
    },
  });
  try {
    const result = runVerifier(fixture.directory, fixture.version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /deferred-platform/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('Windows-only 发布拒绝非 Windows updater 条目', async () => {
  const fixture = await createWindowsReleaseFixture({
    extraPlatforms: {
      'linux-x86_64': {
        url: 'https://updates.example.com/RocketX_0.0.0_amd64.AppImage',
        signature: 'linux-signature',
      },
    },
  });
  try {
    const result = runVerifier(fixture.directory, fixture.version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /non-Windows platform/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('Windows-only 发布缺少 MSI 签名时失败', async () => {
  const fixture = await createWindowsReleaseFixture();
  try {
    await rm(path.join(fixture.directory, `RocketX_${fixture.version}_x64_en-US.msi.sig`));
    const result = runVerifier(fixture.directory, fixture.version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /\.msi\\\.sig/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
