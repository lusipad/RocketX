import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseReleaseTag } from './verify-release.mjs';

const directoryIndex = process.argv.indexOf('--directory');
const tagIndex = process.argv.indexOf('--tag');
const directory = path.resolve(directoryIndex >= 0 ? process.argv[directoryIndex + 1] : 'release-assets');
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : '';
const version = parseReleaseTag(tag);
const names = await readdir(directory);
const versionPattern = version.replaceAll('.', '\\.');
const allowedAssetPatterns = [
  new RegExp(`^RocketX_${versionPattern}_.*-setup\\.exe(?:\\.sig)?$`, 'i'),
  new RegExp(`^RocketX_${versionPattern}_.*\\.msi(?:\\.sig)?$`, 'i'),
  new RegExp(`^RocketX_${versionPattern}_universal\\.dmg(?:\\.sig)?$`, 'i'),
  /^RocketX_universal\.app\.tar\.gz(?:\.sig)?$/i,
  new RegExp(`^RocketX_${versionPattern}_amd64\\.AppImage(?:\\.sig)?$`, 'i'),
  new RegExp(`^RocketX_${versionPattern}_amd64\\.deb(?:\\.sig)?$`, 'i'),
  new RegExp(`^RocketX-${versionPattern}-1\\.x86_64\\.rpm(?:\\.sig)?$`, 'i'),
  /^latest\.json$/i,
  new RegExp(`^rocketx-plugins-${versionPattern}\\.zip$`, 'i'),
  /^SHA256SUMS\.txt$/i,
];
const unexpectedAsset = names.find(
  (name) => !allowedAssetPatterns.some((pattern) => pattern.test(name)),
);
if (unexpectedAsset) throw new Error(`Unexpected release asset: ${unexpectedAsset}`);

function requireMatch(label, pattern) {
  const name = names.find((candidate) => pattern.test(candidate));
  if (!name) throw new Error(`Missing ${label} asset`);
  return name;
}

const slimInstaller = names.find((name) =>
  new RegExp(`${versionPattern}.*\\.exe$`, 'i').test(name) && !/_full-setup\.exe$/i.test(name));
if (!slimInstaller) throw new Error('Missing Windows slim installer asset');
const fullInstaller = requireMatch(
  'Windows full installer',
  new RegExp(`^RocketX_${versionPattern}_full-setup\\.exe$`, 'i'),
);
const required = [
  slimInstaller,
  requireMatch('Windows MSI', new RegExp(`${versionPattern}.*\\.msi$`, 'i')),
  fullInstaller,
  requireMatch('macOS universal DMG', new RegExp(`${versionPattern}.*universal.*\\.dmg$`, 'i')),
  requireMatch('macOS updater archive', /universal\.app\.tar\.gz$/i),
  requireMatch('Linux AppImage', new RegExp(`${versionPattern}.*\\.AppImage$`, 'i')),
  requireMatch('Linux DEB', new RegExp(`${versionPattern}.*\\.deb$`, 'i')),
  requireMatch('Linux RPM', new RegExp(`${versionPattern}.*\\.rpm$`, 'i')),
  requireMatch('updater metadata', /^latest\.json$/),
  requireMatch('plugins bundle', new RegExp(`rocketx-plugins-${versionPattern}\\.zip$`, 'i')),
];

for (const name of required) {
  const metadata = await stat(path.join(directory, name));
  if (!metadata.isFile() || metadata.size < 1_000) throw new Error(`${name} is empty or unexpectedly small`);
}

for (const pattern of [
  /\.exe\.sig$/i,
  /\.msi\.sig$/i,
  /\.AppImage\.sig$/i,
  /\.deb\.sig$/i,
  /\.rpm\.sig$/i,
  /universal\.app\.tar\.gz\.sig$/i,
]) {
  const signature = requireMatch(pattern.source, pattern);
  if ((await stat(path.join(directory, signature))).size === 0) throw new Error(`${signature} is empty`);
}

const updater = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'));
if (updater.version !== version) throw new Error(`latest.json version is ${updater.version}, expected ${version}`);
const platforms = Object.keys(updater.platforms ?? {});
for (const platform of ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
  if (!platforms.includes(platform)) throw new Error(`latest.json is missing ${platform}`);
  if (!updater.platforms[platform]?.signature?.trim()) {
    throw new Error(`latest.json is missing the ${platform} signature`);
  }
}
const windowsUpdaterUrl = updater.platforms['windows-x86_64'].url ?? '';
if (!/\.exe(?:$|\?)/i.test(windowsUpdaterUrl) || /_full-setup\.exe(?:$|\?)/i.test(windowsUpdaterUrl)) {
  throw new Error('latest.json must keep updating the slim installer, not the full setup');
}
if (!/\.AppImage(?:$|\?)/i.test(updater.platforms['linux-x86_64'].url ?? '')) {
  throw new Error('latest.json must update Linux through the AppImage');
}
for (const platform of ['darwin-aarch64', 'darwin-x86_64']) {
  if (!/universal\.app\.tar\.gz(?:$|\?)/i.test(updater.platforms[platform].url ?? '')) {
    throw new Error(`latest.json must update ${platform} through the universal app archive`);
  }
}

console.log(`Verified cross-platform release assets for v${version} (${names.length} files)`);
