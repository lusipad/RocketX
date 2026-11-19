import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPiBundle } from './verify-pi-bundle.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const tauri = path.join(repo, 'apps/desktop/src-tauri');
const resources = path.join(tauri, 'resources/pi-runtime');
const generated = path.join(resources, 'generated');
const cache = path.join(tauri, 'target/pi-node-downloads');
const pin = JSON.parse(await readFile(path.join(resources, 'node-release.json'), 'utf8'));
const sdkName = '@earendil-works/pi-coding-agent';
const manifest = JSON.parse(await readFile(path.join(repo, 'apps/pi-runtime/package.json'), 'utf8'));
const sdkVersion = manifest.dependencies[sdkName];
assert.match(sdkVersion, /^\d+\.\d+\.\d+$/);
const architectures = process.platform === 'darwin' ? ['arm64', 'x64'] : [process.arch];
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function stageNode(work, payload, arch) {
  const windows = process.platform === 'win32';
  const platform = windows ? 'win' : process.platform;
  const prefix = `node-v${pin.version}-${platform}-${arch}`;
  const suffix = `${platform}-${arch}.${windows ? 'zip' : 'tar.gz'}`;
  const expected = pin.archives[suffix];
  assert.ok(expected, `No pinned Node distribution for ${suffix}`);
  const name = `node-v${pin.version}-${suffix}`;
  const archive = path.join(cache, name);
  if (await sha256(archive).catch(() => '') !== expected) {
    const download = path.join(work, name);
    execFileSync(windows ? 'curl.exe' : 'curl', ['--fail', '--location', '--retry', '3', '--output', download,
      `https://nodejs.org/dist/v${pin.version}/${name}`], { stdio: 'inherit' });
    assert.equal(await sha256(download), expected, `Node archive checksum mismatch: ${name}`);
    await copyFile(download, archive);
  }
  const node = windows ? 'node.exe' : 'bin/node';
  execFileSync(tar, ['-xf', archive, '-C', work, `${prefix}/${node}`, `${prefix}/LICENSE`]);
  const destination = path.join(payload, 'bin', arch);
  await mkdir(destination, { recursive: true });
  const executable = path.join(destination, windows ? 'node.exe' : 'node');
  await copyFile(path.join(work, prefix, node), executable);
  if (!windows) await chmod(executable, 0o755);
  await copyFile(path.join(work, prefix, 'LICENSE'), path.join(destination, 'LICENSE'));
}

await mkdir(cache, { recursive: true });
const work = await mkdtemp(path.join(tauri, 'target/pi-package-'));
try {
  const payload = path.join(work, 'payload');
  const pnpmArgs = ['--config.node-linker=hoisted', '--config.prefer-symlinked-executables=false',
    '--filter', '@rcx/pi-runtime', 'deploy', payload, '--prod'];
  // 使用当前 workspace 已锁定并安装的 pnpm，避免经 cmd 拼接路径。
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm, 'Run via pnpm prepare:pi-runtime');
  await access(pnpm);
  execFileSync(process.execPath, [pnpm, ...pnpmArgs], {
    cwd: repo, stdio: 'inherit', env: { ...process.env, CI: 'true', npm_config_frozen_lockfile: 'true' },
  });
  const deployed = JSON.parse(await readFile(path.join(payload, 'node_modules', sdkName, 'package.json'), 'utf8'));
  assert.equal(deployed.version, sdkVersion);
  const entries = await readdir(path.join(payload, 'node_modules'), { recursive: true, withFileTypes: true });
  assert.ok(!entries.some(entry => entry.isSymbolicLink()), 'Pi SDK payload must be self-contained without symlinks');
  for (const arch of architectures) await stageNode(work, payload, arch);

  const archive = path.join(work, 'runtime.tar.gz');
  execFileSync(tar, ['-czf', archive, '-C', payload, 'node_modules', 'bin']);
  const digest = await sha256(archive);
  const bridge = path.join(tauri, 'src/pi_app_server.mjs');
  await verifyPiBundle(archive, bridge, pin.version, sdkVersion, architectures);
  await mkdir(generated, { recursive: true });
  await rename(archive, path.join(generated, 'runtime.tar.gz'));
  await writeFile(path.join(generated, 'runtime.sha256'), digest + '\n');
  console.log(`Packaged Pi ${sdkVersion}, Node ${pin.version} (${architectures.join(', ')}), SHA256 ${digest}`);
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
