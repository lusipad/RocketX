import { copyFile, mkdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();
const manifest = path.join(repoRoot, 'plugins', 'intranet-link', 'native', 'Cargo.toml');
const outputDirectory = path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'resources', 'plugins');

await mkdir(outputDirectory, { recursive: true });

if (process.platform !== 'win32') {
  console.log('Native plugin sidecars are currently Windows-only; nothing to prepare on this platform.');
  process.exit(0);
}

const build = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', manifest], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`Native plugin sidecar build failed with exit code ${build.status}`);

const source = path.join(repoRoot, 'plugins', 'intranet-link', 'native', 'target', 'release', 'rcx-plugin-intranet-link.exe');
const destination = path.join(outputDirectory, 'rcx-plugin-intranet-link.exe');
if (!(await stat(source).catch(() => null))?.isFile()) {
  throw new Error(`Native plugin sidecar was not produced: ${source}`);
}
await copyFile(source, destination);
console.log(`Prepared native plugin sidecar: ${destination}`);
