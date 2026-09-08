import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageFiles, parseReleaseTag } from './verify-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function syncVersion(version, { root = repoRoot } = {}) {
  parseReleaseTag(`v${version}`);
  const updates = new Map();
  async function replace(relativePath, pattern, replacement) {
    const original = await readFile(path.join(root, relativePath), 'utf8');
    if (!pattern.test(original)) throw new Error(`${relativePath}: required version entry is missing`);
    updates.set(relativePath, { original, updated: original.replace(pattern, replacement) });
  }

  // Validate every target before writing; release notes must already be authored.
  await replace('CHANGELOG.md', new RegExp(`^## v${version.replaceAll('.', '\\.')} - \\d{4}-\\d{2}-\\d{2}\\r?$`, 'm'), (header) => header);
  for (const relativePath of [...packageFiles, 'apps/desktop/src-tauri/tauri.conf.json']) {
    await replace(relativePath, /("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  }
  await replace('apps/desktop/src-tauri/Cargo.toml', /(^version\s*=\s*")[^"]+(".*$)/m, `$1${version}$2`);
  await replace('apps/desktop/src-tauri/Cargo.lock', /(\[\[package\]\]\r?\nname = "rocketx"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);
  await replace('docs/release/README.md', /(current release target is `v)\d+\.\d+\.\d+(`)/, `$1${version}$2`);
  await replace('docs/compatibility.md', /(RocketX `v)\d+\.\d+\.\d+(` desktop line is split\.)/, `$1${version}$2`);

  for (const [relativePath, { original, updated }] of updates) {
    if (updated !== original) await writeFile(path.join(root, relativePath), updated);
  }
  return [...updates.keys()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  Promise.resolve().then(() => {
    if (process.argv.length !== 3) throw new Error('Usage: pnpm sync-version <x.y.z>');
    return syncVersion(version);
  }).then((files) => {
    console.log(`Version ${version} synchronized across ${files.length} files`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
