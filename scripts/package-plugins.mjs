import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseReleaseTag } from './verify-release.mjs';

const tagIndex = process.argv.indexOf('--tag');
const outIndex = process.argv.indexOf('--out');
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : `v${JSON.parse(await readFile('package.json', 'utf8')).version}`;
const version = parseReleaseTag(tag);
const outputDir = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1] : 'dist/plugins');
const pluginsRoot = path.resolve('plugins');
const packageRoot = path.join(outputDir, `rocketx-plugins-${version}`);
const zipName = `rocketx-plugins-${version}.zip`;
const zipPath = path.join(outputDir, zipName);

function fail(message) {
  throw new Error(message);
}

function validateManifest(plugin, manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail(`${plugin}: rcx.app.json must be an object`);
  if (manifest.runtime !== 'iframe') fail(`${plugin}: only iframe plugins are packaged`);
  if (manifest.entry !== 'index.html') fail(`${plugin}: packaged plugins must use index.html entry`);
  if (manifest.service) {
    if (manifest.service.runtime !== 'native' || manifest.service.protocol !== 'jsonrpc-stdio') {
      fail(`${plugin}: native service must use jsonrpc-stdio`);
    }
    if (!manifest.permissions?.includes('native:service')) fail(`${plugin}: native service permission is missing`);
  }
  if (!Array.isArray(manifest.permissions)) fail(`${plugin}: permissions must be an array`);
  for (const permission of manifest.permissions) {
    if (typeof permission !== 'string') fail(`${plugin}: permission must be a string`);
  }
}

async function validatePlugin(plugin) {
  const root = path.join(pluginsRoot, plugin);
  const manifestPath = path.join(root, 'rcx.app.json');
  const entryPath = path.join(root, 'index.html');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(plugin, manifest);
  const entry = await readFile(entryPath, 'utf8');
  if (!/^<!doctype html>/i.test(entry.trimStart())) fail(`${plugin}: index.html must be a standalone HTML document`);
  if (/<script\b[^>]*\bsrc\s*=/i.test(entry)) fail(`${plugin}: external scripts are not allowed in packaged plugins`);
  if (/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(entry)) {
    fail(`${plugin}: dynamic HTML injection APIs are not allowed`);
  }
  return { root, manifest };
}

const pluginNames = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (pluginNames.length === 0) fail('No plugins found to package');

await mkdir(outputDir, { recursive: true });
await rm(packageRoot, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(packageRoot, { recursive: true });

const packaged = [];
for (const plugin of pluginNames) {
  const { root, manifest } = await validatePlugin(plugin);
  const destination = path.join(packageRoot, plugin);
  await mkdir(destination, { recursive: true });
  for (const name of ['rcx.app.json', 'index.html', 'README.md']) {
    const source = path.join(root, name);
    if ((await stat(source).catch(() => null))?.isFile()) {
      await copyFile(source, path.join(destination, name));
    }
  }
  if (manifest.service) {
    const nativeRoot = path.join(root, 'native');
    if (!(await stat(path.join(nativeRoot, 'Cargo.toml')).catch(() => null))?.isFile()) {
      fail(`${plugin}: native service source is missing Cargo.toml`);
    }
    await cp(nativeRoot, path.join(destination, 'native'), {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes('target'),
    });
  }
  packaged.push({ directory: plugin, id: manifest.id, name: manifest.name, version: manifest.version });
}

await writeFile(
  path.join(packageRoot, 'manifest.json'),
  `${JSON.stringify({ version, packagedAt: new Date(0).toISOString(), plugins: packaged }, null, 2)}\n`,
);

const archiveCommand = process.platform === 'win32' ? 'tar.exe' : 'zip';
const archiveArgs = process.platform === 'win32'
  ? ['-a', '-c', '-f', zipPath, path.basename(packageRoot)]
  : ['-X', '-r', zipPath, path.basename(packageRoot)];
const result = spawnSync(archiveCommand, archiveArgs, {
  cwd: outputDir,
  stdio: 'inherit',
});
if (result.error) fail(`zip failed to start: ${result.error.message}`);
if (result.status !== 0) fail(`zip failed with exit code ${result.status}`);
const metadata = await stat(zipPath);
if (!metadata.isFile() || metadata.size < 1_000) fail(`${zipName} is empty or unexpectedly small`);
console.log(`Packaged ${packaged.length} plugin(s): ${zipPath}`);
