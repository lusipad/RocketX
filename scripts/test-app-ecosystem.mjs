import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const startedAt = Date.now();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'rocketx-ecosystem-'));

function run(command, args, cwd = repoRoot) {
  const useCommandShell = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
  const executable = useCommandShell ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const quoteCommandArgument = (value) => /[\s&|<>^]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
  const executableArgs = useCommandShell
    ? ['/d', '/c', `${command} ${args.map(quoteCommandArgument).join(' ')}`]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    [command, ...args, result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
  return result.stdout.trim();
}

try {
  const artifacts = path.join(temporary, 'artifacts');
  const cleanRoom = path.join(temporary, 'consumer');
  await mkdir(artifacts, { recursive: true });
  await mkdir(cleanRoom, { recursive: true });
  run(pnpm, ['pack', '--pack-destination', artifacts], path.join(repoRoot, 'packages', 'app-sdk'));
  run(pnpm, ['pack', '--pack-destination', artifacts], path.join(repoRoot, 'packages', 'create-rcx-app'));

  const tarballs = (await readdir(artifacts)).filter((file) => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 2, `Expected two package tarballs, got ${tarballs.join(', ')}`);
  const sdkTarball = path.join(artifacts, tarballs.find((file) => file.includes('app-sdk')) ?? '');
  const cliTarball = path.join(artifacts, tarballs.find((file) => file.includes('create-rcx-app')) ?? '');
  for (const [tarball, expected] of [
    [sdkTarball, ['package/dist/index.js', 'package/dist/index.d.ts']],
    [cliTarball, ['package/dist/create-cli.js', 'package/dist/rcx-cli.js', 'package/dist/templates/hello/index.html']],
  ]) {
    const files = run('tar', ['-tf', tarball]).split(/\r?\n/);
    for (const file of expected) assert.ok(files.includes(file), `${path.basename(tarball)} is missing ${file}`);
    assert.ok(!files.some((file) => file.startsWith('package/src/')), `${path.basename(tarball)} leaked src/`);
    assert.ok(!files.some((file) => file.endsWith('.map')), `${path.basename(tarball)} leaked source maps`);
  }

  const packedCliManifest = JSON.parse(run('tar', ['-xOf', cliTarball, 'package/package.json']));
  const sdkManifest = JSON.parse(await readFile(path.join(repoRoot, 'packages/app-sdk/package.json'), 'utf8'));
  assert.equal(packedCliManifest.dependencies['@rcx/app-sdk'], sdkManifest.version);

  run(npm, ['init', '-y'], cleanRoom);
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', sdkTarball, cliTarball], cleanRoom);
  const generated = path.join(cleanRoom, 'first-app');
  const binDirectory = path.join(cleanRoom, 'node_modules', '.bin');
  const createCommand = path.join(binDirectory, process.platform === 'win32' ? 'create-rcx-app.cmd' : 'create-rcx-app');
  const rcxCommand = path.join(binDirectory, process.platform === 'win32' ? 'rcx-app.cmd' : 'rcx-app');
  run(createCommand, [generated, '--template', 'hello'], cleanRoom);
  run(rcxCommand, ['validate', generated], cleanRoom);
  const manifest = JSON.parse(await readFile(path.join(generated, 'rcx.app.json'), 'utf8'));
  assert.equal(manifest.id, 'dev.local.first-app');

  const cliModule = await import(pathToFileURL(path.join(cleanRoom, 'node_modules', 'create-rcx-app', 'dist', 'index.js')).href);
  const development = await cliModule.startDevServer(generated, 0);
  try {
    const response = await fetch(development.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /__RCX_BRIDGE__/);
  } finally {
    await development.close();
  }

  const sdkModule = await import(pathToFileURL(path.join(cleanRoom, 'node_modules', '@rcx', 'app-sdk', 'dist', 'index.js')).href);
  assert.equal(sdkModule.parseManifest(manifest).id, 'dev.local.first-app');
  console.log(JSON.stringify({
    status: 'ok',
    tarballs: tarballs.sort(),
    generatedApp: manifest.id,
    durationMs: Date.now() - startedAt,
  }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
