import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const runtimePackageRoot = path.join(repoRoot, 'apps', 'dsh-runtime');
const tauriRoot = path.join(repoRoot, 'apps', 'desktop', 'src-tauri');
const deployRoot = path.join(tauriRoot, 'target', 'dsh-runtime');
const archivePath = path.join(tauriRoot, 'target', 'dsh-runtime.tar.gz');
const bridgeSource = path.join(tauriRoot, 'src', 'dsh_bridge.mjs');
const cliRelativePath = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

function run(command, args, options = {}) {
  const { echo = true, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (echo) process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (echo) process.stderr.write(text);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function ensureFile(filePath, label) {
  const info = await stat(filePath).catch(() => null);
  assert.ok(info?.isFile(), `${label} 缺失：${filePath}`);
}

async function pathExists(targetPath) {
  return (await stat(targetPath).catch(() => null)) !== null;
}

async function summarizeDirectory(root) {
  let files = 0;
  let bytes = 0;
  const symlinks = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(nextPath);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      bytes += (await stat(nextPath)).size;
    }
  }
  return { files, bytes, symlinks };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function deploymentLayout(root) {
  return {
    root,
    bridgeTarget: path.join(root, 'dsh_bridge.mjs'),
    cliPath: path.join(root, cliRelativePath),
    deployedPackageJsonPath: path.join(root, 'package.json'),
    deployedDshPackageJsonPath: path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  };
}

async function resolvePnpmInvocation() {
  const candidate = process.env.npm_execpath?.trim();
  if (candidate) {
    await ensureFile(candidate, 'pnpm CLI');
    return { command: process.execPath, prefixArgs: [candidate] };
  }
  if (process.platform !== 'win32') {
    return { command: 'pnpm', prefixArgs: [] };
  }
  const windowsPnpm = path.join(
    process.env.APPDATA ?? '',
    'npm',
    'node_modules',
    'pnpm',
    'bin',
    'pnpm.mjs',
  );
  await ensureFile(windowsPnpm, 'pnpm CLI');
  return { command: process.execPath, prefixArgs: [windowsPnpm] };
}

function tarCommand() {
  return process.platform === 'win32' ? 'tar.exe' : 'tar';
}

async function replacePathAtomically(targetPath, preparedPath) {
  const backupPath = `${targetPath}.__old-${Date.now()}`;
  const hadTarget = await pathExists(targetPath);
  if (hadTarget) {
    await rename(targetPath, backupPath);
  }
  try {
    await rename(preparedPath, targetPath);
  } catch (error) {
    if (hadTarget && await pathExists(backupPath) && !await pathExists(targetPath)) {
      await rename(backupPath, targetPath);
    }
    throw error;
  }
  if (await pathExists(backupPath)) {
    void rm(backupPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    }).catch(() => undefined);
  }
}

async function main() {
  const runtimePackage = await readJson(path.join(runtimePackageRoot, 'package.json'));
  const dshVersion = runtimePackage.dependencies?.['@deepseek-ai/dsh'];
  assert.equal(typeof dshVersion, 'string', 'apps/dsh-runtime/package.json 必须声明 @deepseek-ai/dsh');
  assert.equal(
    dshVersion.startsWith('workspace:') || dshVersion.startsWith('file:'),
    false,
    'apps/dsh-runtime/package.json 不能使用 workspace/file 形式引用 DSH',
  );
  assert.equal(
    /^[~^]/u.test(dshVersion),
    false,
    'apps/dsh-runtime/package.json 必须使用精确版本，不允许 ^ 或 ~',
  );
  assert.match(
    dshVersion,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
    'apps/dsh-runtime/package.json 里的 DSH 版本必须是精确 semver',
  );
  assert.equal(
    runtimePackage.dependencies?.['@deepseek-ai/dsh'],
    dshVersion,
    `apps/dsh-runtime/package.json 必须固定 @deepseek-ai/dsh@${dshVersion}`,
  );

  const staging = deploymentLayout(`${deployRoot}.__staging`);
  await rm(staging.root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
  await mkdir(path.dirname(deployRoot), { recursive: true });
  const pnpm = await resolvePnpmInvocation();
  await run(pnpm.command, [
    ...pnpm.prefixArgs,
    '--trust-lockfile',
    '--config.node-linker=hoisted',
    '--filter',
    '@rcx/dsh-runtime',
    'deploy',
    staging.root,
    '--prod',
  ], {
    env: {
      ...process.env,
      CI: process.env.CI ?? 'true',
      npm_config_confirmModulesPurge: 'false',
    },
  });
  await cp(bridgeSource, staging.bridgeTarget, { force: true });

  await ensureFile(staging.cliPath, 'DSH CLI');
  await ensureFile(staging.bridgeTarget, 'DSH bridge');

  const deployedPackage = await readJson(staging.deployedPackageJsonPath);
  assert.equal(
    deployedPackage.dependencies?.['@deepseek-ai/dsh']?.split('(', 1)[0],
    dshVersion,
    `部署产物 package.json 必须解析到 @deepseek-ai/dsh@${dshVersion}`,
  );

  const deployedDshPackage = await readJson(staging.deployedDshPackageJsonPath);
  assert.equal(
    deployedDshPackage.version,
    dshVersion,
    `部署产物实际安装版本必须是 @deepseek-ai/dsh@${dshVersion}`,
  );

  const lockfile = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  assert.match(
    lockfile,
    new RegExp(
      `'@deepseek-ai/dsh':\\s*\\n\\s*specifier:\\s*${escapeRegExp(dshVersion)}\\s*\\n\\s*version:\\s*${escapeRegExp(dshVersion)}`,
      'u',
    ),
    `pnpm-lock.yaml 必须锁定 @deepseek-ai/dsh ${dshVersion}`,
  );

  const bridgeText = await readFile(staging.bridgeTarget, 'utf8');
  assert.match(bridgeText, /usage: node dsh_bridge\.mjs <dsh-cli> <patch>/, 'bridge 复制结果不符合预期');

  const versionProbe = await run(process.execPath, [staging.cliPath, '--version'], { cwd: staging.root });
  assert.equal(
    versionProbe.stdout.trim(),
    dshVersion,
    `部署后的 DSH CLI --version 必须返回 ${dshVersion}`,
  );

  const probeHome = await mkdtemp(path.join(os.tmpdir(), 'rocketx-dsh-runtime-probe-'));
  try {
    const dumpProbe = await run(
      process.execPath,
      [staging.cliPath, '--profile', 'web', '--dump-default-config'],
      {
        cwd: staging.root,
        env: { ...process.env, DSH_HOME: probeHome },
        echo: false,
      },
    );
    assert.match(dumpProbe.stdout, /@deepseek-ai\/dsh-web-app/);
    assert.match(dumpProbe.stdout, /@deepseek-ai\/dsh-host-webserver/);
    assert.match(dumpProbe.stdout, /@deepseek-ai\/dsh-llm-deepseek/);
  } finally {
    await rm(probeHome, { recursive: true, force: true });
  }

  const summary = await summarizeDirectory(staging.root);
  assert.equal(
    summary.symlinks.length,
    0,
    `部署产物不能包含 symlink；请检查 node-linker=hoisted 是否生效：${summary.symlinks.slice(0, 5).join(', ')}`,
  );

  const archiveStagingPath = `${archivePath}.__staging`;
  await rm(archiveStagingPath, { force: true });
  await run(tarCommand(), ['-czf', archiveStagingPath, '-C', staging.root, '.']);

  await replacePathAtomically(deployRoot, staging.root);
  await replacePathAtomically(archivePath, archiveStagingPath);
  console.log(
    `Prepared DSH runtime at ${deployRoot} (${summary.files} files, ${summary.bytes} bytes)`,
  );
}

await main();
