import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const generatedDir = resolve(root, 'apps/web/src/agent/protocol/generated');
const codexEntry = resolve(root, 'node_modules/@openai/codex/bin/codex.js');
const compatibilityFile = resolve(root, 'apps/web/src/agent/protocol/compatibility.ts');
const mode = process.argv[2];

if (mode !== '--write' && mode !== '--check') {
  throw new Error('用法：node scripts/codex-protocol.mjs --write|--check');
}

function runCodex(args) {
  if (!existsSync(codexEntry)) {
    throw new Error('缺少仓库锁定的 @openai/codex，请先运行 pnpm install');
  }
  const result = spawnSync(process.execPath, [codexEntry, ...args], {
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
      else if (entry.isFile()) result.set(key, (await readFile(path, 'utf8')).replaceAll('\r\n', '\n'));
    }
  }
  await walk(dir);
  return result;
}

const versionOutput = runCodex(['--version']);
const cliVersion = /^codex-cli (\S+)$/.exec(versionOutput)?.[1];
if (!cliVersion) {
  throw new Error(`无法识别 Codex CLI 版本：${versionOutput || '未知版本'}`);
}
const compatibilitySource = await readFile(compatibilityFile, 'utf8');
const expectedVersion = /CODEX_APP_SERVER_VERSION = '([^']+)'/.exec(compatibilitySource)?.[1];
if (!expectedVersion || cliVersion !== expectedVersion) {
  throw new Error(`仓库 Codex CLI ${cliVersion} 与 app-server 基线 ${expectedVersion ?? '未知'} 不一致`);
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
    console.log(`已用 codex-cli ${cliVersion} 生成 ${(await filesUnder(generatedDir)).length} 个协议文件。`);
  } else {
    if (!(await stat(generatedDir).catch(() => null))) throw new Error('协议生成物不存在，请先运行 codex:protocol:generate');
    const [expected, actual] = await Promise.all([snapshot(tempGenerated), snapshot(generatedDir)]);
    const paths = new Set([...expected.keys(), ...actual.keys()]);
    const changed = [...paths].filter((path) => expected.get(path) !== actual.get(path)).sort();
    if (changed.length > 0) {
      throw new Error(`协议生成物与 codex-cli ${cliVersion} 不一致：${changed.slice(0, 20).join(', ')}`);
    }
    console.log(`协议生成物与 codex-cli ${cliVersion} 一致（${actual.size} 个文件）。`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
