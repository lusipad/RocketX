import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseReleaseTag } from './verify-release.mjs';

const directoryIndex = process.argv.indexOf('--directory');
const tagIndex = process.argv.indexOf('--tag');
const directory = path.resolve(directoryIndex >= 0 ? process.argv[directoryIndex + 1] : 'release-assets');
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : '';
const version = parseReleaseTag(tag);
const names = await readdir(directory);
const deferredAssetPatterns = [
  /\.dmg(?:\.sig)?$/i,
  /universal\.app\.tar\.gz(?:\.sig)?$/i,
  /\.AppImage(?:\.sig)?$/i,
  /\.deb(?:\.sig)?$/i,
  /\.rpm(?:\.sig)?$/i,
];
const deferredAsset = names.find((name) => deferredAssetPatterns.some((pattern) => pattern.test(name)));
if (deferredAsset) {
  throw new Error(`Unexpected deferred-platform asset in Windows-only release: ${deferredAsset}`);
}

function requireMatch(label, pattern) {
  const name = names.find((candidate) => pattern.test(candidate));
  if (!name) throw new Error(`Missing ${label} asset`);
  return name;
}

const versionPattern = version.replaceAll('.', '\\.');
const required = [
  requireMatch('Windows MSI', new RegExp(`${versionPattern}.*\\.msi$`, 'i')),
  requireMatch('Windows installer', new RegExp(`${versionPattern}.*\\.exe$`, 'i')),
  requireMatch('updater metadata', /^latest\.json$/),
  requireMatch('plugins bundle', new RegExp(`rocketx-plugins-${versionPattern}\\.zip$`, 'i')),
];

for (const name of required) {
  const metadata = await stat(path.join(directory, name));
  if (!metadata.isFile() || metadata.size < 1_000) throw new Error(`${name} is empty or unexpectedly small`);
}

for (const pattern of [/\.exe\.sig$/i, /\.msi\.sig$/i]) {
  const signature = requireMatch(pattern.source, pattern);
  if ((await stat(path.join(directory, signature))).size === 0) throw new Error(`${signature} is empty`);
}

const updater = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'));
if (updater.version !== version) throw new Error(`latest.json version is ${updater.version}, expected ${version}`);
const platforms = Object.keys(updater.platforms ?? {});
if (!platforms.includes('windows-x86_64')) throw new Error('latest.json is missing windows-x86_64');
const nonWindowsPlatform = platforms.find((platform) => !platform.startsWith('windows-'));
if (nonWindowsPlatform) throw new Error(`latest.json contains non-Windows platform: ${nonWindowsPlatform}`);

console.log(`Verified Windows release assets for v${version} (${names.length} files)`);
