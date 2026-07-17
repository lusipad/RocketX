import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const packageFiles = [
  'package.json',
  'apps/web/package.json',
  'apps/desktop/package.json',
  'packages/app-sdk/package.json',
  'packages/create-rcx-app/package.json',
  'packages/rc-client/package.json',
  'packages/rcx-store/package.json',
  'services/ado-bridge/package.json',
];

export function parseReleaseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) throw new Error(`Release tag must be strict SemVer: ${tag}`);
  return match.slice(1).join('.');
}

export function requiresMaturityEvidence(version) {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isInteger(major) && major >= 1;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'));
}

export async function verifyVersions(version) {
  const failures = [];
  for (const relativePath of packageFiles) {
    const manifest = await readJson(relativePath);
    if (manifest.version !== version) failures.push(`${relativePath}: ${manifest.version ?? '<missing>'}`);
  }

  const cargo = await readFile(path.join(repoRoot, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  if (cargoVersion !== version) failures.push(`apps/desktop/src-tauri/Cargo.toml: ${cargoVersion ?? '<missing>'}`);

  const cargoLock = await readFile(path.join(repoRoot, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
  const lockedVersion = /\[\[package\]\]\r?\nname = "rocketx"\r?\nversion = "([^"]+)"/.exec(cargoLock)?.[1];
  if (lockedVersion !== version) failures.push(`apps/desktop/src-tauri/Cargo.lock: ${lockedVersion ?? '<missing>'}`);

  const tauri = await readJson('apps/desktop/src-tauri/tauri.conf.json');
  if (tauri.version !== version) failures.push(`apps/desktop/src-tauri/tauri.conf.json: ${tauri.version ?? '<missing>'}`);

  if (failures.length) {
    throw new Error(`Release version ${version} is not aligned:\n${failures.join('\n')}`);
  }
}

export async function releaseNotes(version) {
  const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const header = new RegExp(`^## v${version.replaceAll('.', '\\.')} - (\\d{4}-\\d{2}-\\d{2})$`, 'm');
  const match = header.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md must contain a dated v${version} section`);
  const rest = changelog.slice(match.index + match[0].length).replace(/^\r?\n/, '');
  const end = rest.search(/^## /m);
  const body = (end === -1 ? rest : rest.slice(0, end)).trim();
  if (!body) throw new Error(`CHANGELOG.md v${version} section is empty`);
  return `# RocketX v${version}\n\n${body}\n`;
}

async function verifyVisual(relativePath, signature) {
  const absolutePath = path.join(repoRoot, relativePath);
  const metadata = await stat(absolutePath);
  if (metadata.size < 50_000) throw new Error(`${relativePath} is too small to be a real product capture`);
  const bytes = await readFile(absolutePath);
  if (!bytes.subarray(0, signature.length).equals(signature)) {
    throw new Error(`${relativePath} has an unexpected file signature`);
  }
}

async function readEvidence(version, gate) {
  const relativePath = `docs/release/v${version}-${gate.toLowerCase()}.json`;
  const evidence = await readJson(relativePath);
  if (evidence.gate !== gate || evidence.result !== 'pass') {
    throw new Error(`${relativePath} must record ${gate} with result=pass`);
  }
  if (typeof evidence.tester !== 'string' || evidence.tester.trim().length < 3) {
    throw new Error(`${relativePath} must identify an external tester alias`);
  }
  const startedAt = Date.parse(evidence.startedAt);
  const completedAt = Date.parse(evidence.completedAt);
  const durationMinutes = (completedAt - startedAt) / 60_000;
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 30) {
    throw new Error(`${relativePath} must prove completion within 30 minutes`);
  }
  if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length === 0) {
    throw new Error(`${relativePath} must reference at least one evidence artifact`);
  }
  const expectedDocument = gate === 'G3' ? 'README.md' : 'docs/app-development.md';
  if (evidence.document !== expectedDocument) {
    throw new Error(`${relativePath} must use only ${expectedDocument}`);
  }
  return evidence;
}

export async function verifyReadyEvidence(version) {
  await verifyVisual('docs/assets/readme/rocketx-today.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await verifyVisual('docs/assets/readme/rocketx-shared-agent.gif', Buffer.from('GIF8'));
  const [g3, g4] = await Promise.all([readEvidence(version, 'G3'), readEvidence(version, 'G4')]);
  if (g3.tester.trim().toLowerCase() === g4.tester.trim().toLowerCase()) {
    throw new Error('G3 and G4 must be completed by two different external testers');
  }
}

export async function verifyRelease(tag, { requireReady = false } = {}) {
  const version = parseReleaseTag(tag);
  await verifyVersions(version);
  await releaseNotes(version);
  if (requireReady && requiresMaturityEvidence(version)) await verifyReadyEvidence(version);
  return version;
}

async function main() {
  const tagIndex = process.argv.indexOf('--tag');
  const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : '';
  const version = await verifyRelease(tag, { requireReady: process.argv.includes('--require-ready') });
  console.log(`Release contract verified for v${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
