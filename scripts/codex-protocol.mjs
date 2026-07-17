import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

const expectedVersion = '0.144.4';
const root = resolve(import.meta.dirname, '..');
const generatedDir = resolve(root, 'apps/web/src/agent/protocol/generated');
const mode = process.argv[2];

if (mode !== '--write' && mode !== '--check') {
  throw new Error('用法：node scripts/codex-protocol.mjs --write|--check');
}

function runCodex(args) {
  let executable = 'codex';
  let commandArgs = args;
  if (process.platform === 'win32') {
    const lookup = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8' });
    const shim = lookup.stdout?.split(/\r?\n/).find(Boolean);
    const entry = shim ? join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : '';
    if (!entry || !existsSync(entry)) throw new Error('找不到 PATH 中 codex.cmd 对应的官方 Node 入口');
    executable = process.execPath;
    commandArgs = [entry, ...args];
  }
  const result = spawnSync(executable, commandArgs, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      result.error?.message ||
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        `codex 退出码 ${result.status}`,
    );
  }
  return result.stdout.trim();
}

async function filesUnder(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(relative(dir, path).replaceAll('\\', '/'));
  }
  return files;
}

async function snapshot(dir) {
  const result = new Map();
  async function walk(current, prefix = '') {
    const names = await readdir(current, { withFileTypes: true });
    for (const entry of names) {
      const path = join(current, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, key);
      else if (entry.isFile()) result.set(key, await readFile(path, 'utf8'));
    }
  }
  await walk(dir);
  return result;
}

const versionOutput = runCodex(['--version']);
if (versionOutput !== `codex-cli ${expectedVersion}`) {
  throw new Error(`协议只能由 codex-cli ${expectedVersion} 生成，当前为 ${versionOutput || '未知版本'}`);
}

const tempRoot = await mkdtemp(join(tmpdir(), 'rocketx-codex-protocol-'));
const tempGenerated = join(tempRoot, 'generated');

try {
  runCodex(['app-server', 'generate-ts', '--experimental', '--out', tempGenerated]);
  if (mode === '--write') {
    const allowedParent = resolve(root, 'apps/web/src/agent/protocol');
    if (resolve(generatedDir, '..') !== allowedParent || basename(generatedDir) !== 'generated') {
      throw new Error(`拒绝覆盖非协议目录：${generatedDir}`);
    }
    await rm(generatedDir, { recursive: true, force: true });
    await cp(tempGenerated, generatedDir, { recursive: true });
    console.log(`已用 codex-cli ${expectedVersion} 生成 ${(await filesUnder(generatedDir)).length} 个协议文件。`);
  } else {
    if (!(await stat(generatedDir).catch(() => null))) throw new Error('协议生成物不存在，请先运行 codex:protocol:generate');
    const [expected, actual] = await Promise.all([snapshot(tempGenerated), snapshot(generatedDir)]);
    const paths = new Set([...expected.keys(), ...actual.keys()]);
    const changed = [...paths].filter((path) => expected.get(path) !== actual.get(path)).sort();
    if (changed.length > 0) {
      throw new Error(`协议生成物与 codex-cli ${expectedVersion} 不一致：${changed.slice(0, 20).join(', ')}`);
    }
    console.log(`协议生成物与 codex-cli ${expectedVersion} 一致（${actual.size} 个文件）。`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
