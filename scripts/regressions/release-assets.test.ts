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

async function createCrossPlatformReleaseFixture(options: {
  extraPlatforms?: Record<string, { url: string; signature: string }>;
} = {}): Promise<{ directory: string; version: string }> {
  const version = await currentVersion();
  const directory = await mkdtemp(path.join(tmpdir(), 'rocketx-cross-platform-release-'));
  const installer = `RocketX_${version}_x64-setup.exe`;
  const msi = `RocketX_${version}_x64_en-US.msi`;
  const fullInstaller = `RocketX_${version}_full-setup.exe`;
  const dmg = `RocketX_${version}_universal.dmg`;
  const macUpdater = 'RocketX_universal.app.tar.gz';
  const appImage = `RocketX_${version}_amd64.AppImage`;
  const deb = `RocketX_${version}_amd64.deb`;
  const rpm = `RocketX-${version}-1.x86_64.rpm`;
  const platforms = {
    'windows-x86_64': {
      url: `https://updates.example.com/${installer}`,
      signature: 'windows-signature',
    },
    'linux-x86_64': {
      url: `https://updates.example.com/${appImage}`,
      signature: 'linux-signature',
    },
    'darwin-aarch64': {
      url: `https://updates.example.com/${macUpdater}`,
      signature: 'mac-signature',
    },
    'darwin-x86_64': {
      url: `https://updates.example.com/${macUpdater}`,
      signature: 'mac-signature',
    },
    ...options.extraPlatforms,
  };
  const updater = JSON.stringify({
    version,
    notes: 'Cross-platform release fixture. '.repeat(64),
    pub_date: '2026-07-23T00:00:00Z',
    platforms,
  });

  await Promise.all([
    writeFile(path.join(directory, installer), Buffer.alloc(1_024, 1)),
    writeFile(path.join(directory, msi), Buffer.alloc(1_024, 2)),
    writeFile(path.join(directory, fullInstaller), Buffer.alloc(1_024, 4)),
    writeFile(path.join(directory, `${installer}.sig`), 'windows-signature'),
    writeFile(path.join(directory, `${msi}.sig`), 'windows-msi-signature'),
    writeFile(path.join(directory, dmg), Buffer.alloc(1_024, 5)),
    writeFile(path.join(directory, macUpdater), Buffer.alloc(1_024, 6)),
    writeFile(path.join(directory, `${macUpdater}.sig`), 'mac-signature'),
    writeFile(path.join(directory, appImage), Buffer.alloc(1_024, 7)),
    writeFile(path.join(directory, `${appImage}.sig`), 'linux-signature'),
    writeFile(path.join(directory, deb), Buffer.alloc(1_024, 8)),
    writeFile(path.join(directory, `${deb}.sig`), 'linux-deb-signature'),
    writeFile(path.join(directory, rpm), Buffer.alloc(1_024, 9)),
    writeFile(path.join(directory, `${rpm}.sig`), 'linux-rpm-signature'),
    writeFile(path.join(directory, 'latest.json'), updater),
    writeFile(path.join(directory, `rocketx-plugins-${version}.zip`), Buffer.alloc(1_024, 3)),
  ]);

  return { directory, version };
}

function runVerifier(directory: string, version: string) {
  return spawnSync(process.execPath, [verifier, '--tag', `v${version}`, '--directory', directory], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('正式发布同时要求 Windows、macOS 和 Linux 安装包', async () => {
  const fixture = await createCrossPlatformReleaseFixture();
  try {
    const result = runVerifier(fixture.directory, fixture.version);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Verified cross-platform release assets/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('正式发布缺少 macOS 安装包时失败', async () => {
  const fixture = await createCrossPlatformReleaseFixture();
  try {
    await rm(path.join(fixture.directory, `RocketX_${fixture.version}_universal.dmg`));
    const result = runVerifier(fixture.directory, fixture.version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /macOS universal DMG/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('正式发布缺少 Linux 安装包时失败', async () => {
  const fixture = await createCrossPlatformReleaseFixture();
  try {
    await rm(path.join(fixture.directory, `RocketX_${fixture.version}_amd64.AppImage`));
    const result = runVerifier(fixture.directory, fixture.version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Linux AppImage/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('正式发布缺少任一平台 updater 签名时失败', async () => {
  const fixture = await createCrossPlatformReleaseFixture();
  try {
    await rm(path.join(fixture.directory, `RocketX_${fixture.version}_amd64.AppImage.sig`));
    const result = runVerifier(fixture.directory, fixture.version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /\.AppImage\\\.sig/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('正式发布缺少 Windows full 安装包时失败', async () => {
  const fixture = await createCrossPlatformReleaseFixture();
  try {
    await rm(path.join(fixture.directory, `RocketX_${fixture.version}_full-setup.exe`));
    const result = runVerifier(fixture.directory, fixture.version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /full installer/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('Windows 自动更新地址必须继续指向瘦版安装包', async () => {
  const fixture = await createCrossPlatformReleaseFixture({
    extraPlatforms: {
      'windows-x86_64': {
        url: `https://updates.example.com/RocketX_${await currentVersion()}_full-setup.exe`,
        signature: 'windows-signature',
      },
    },
  });
  try {
    const result = runVerifier(fixture.directory, fixture.version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /slim installer/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('正式发布的更新清单不能遗漏任一桌面平台', async () => {
  const fixture = await createCrossPlatformReleaseFixture();
  try {
    const updaterPath = path.join(fixture.directory, 'latest.json');
    const updater = JSON.parse(await readFile(updaterPath, 'utf8'));
    delete updater.platforms['darwin-aarch64'];
    await writeFile(updaterPath, JSON.stringify(updater));
    const result = runVerifier(fixture.directory, fixture.version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /darwin-aarch64/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
