import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { syncVersion } from '../sync-version.mjs';
import { verifyVersions } from '../verify-release.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rocketx-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const checked = new Set<string>();
  await verifyVersions(version, { onRead: (file: string) => checked.add(file) });
  for (const file of checked) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), await readFile(path.join(repoRoot, file)));
  }
  return { root, version, checked };
}

test('sync-version 实际覆盖集合等于 verifyVersions 实际检查集合，升版后全部对齐', async (t) => {
  const { root, version, checked } = await fixture(t);
  const next = '0.99.99';
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const changelog = `## v${next} - 2026-09-08\n\n人工填写的发版说明。\n\n${await readFile(changelogPath, 'utf8')}`;
  await writeFile(changelogPath, changelog);
  const lockPath = path.join(root, 'apps/desktop/src-tauri/Cargo.lock');
  const lock = await readFile(lockPath, 'utf8');
  const covered = await syncVersion(next, { root });
  assert.deepEqual(new Set(covered), checked);
  await verifyVersions(next, { root });
  assert.equal(await readFile(changelogPath, 'utf8'), changelog);
  assert.equal(await readFile(lockPath, 'utf8'), lock.replace(
    /(\[\[package\]\]\r?\nname = "rocketx"\r?\nversion = ")[^"]+(")/,
    `$1${next}$2`,
  ));
  assert.notEqual(next, version);
  const before = await Promise.all(covered.map((file: string) => readFile(path.join(root, file), 'utf8')));
  await syncVersion(next, { root });
  assert.deepEqual(await Promise.all(covered.map((file: string) => readFile(path.join(root, file), 'utf8'))), before);
});

test('sync-version 缺少目标 CHANGELOG 或版本非法时不写入文件', async (t) => {
  const { root, checked } = await fixture(t);
  const snapshot = () => Promise.all([...checked].map((file) => readFile(path.join(root, file), 'utf8')));
  const before = await snapshot();
  await assert.rejects(syncVersion('0.99.99', { root }), /CHANGELOG.md/);
  for (const version of ['v0.44.11', '01.2.3', '1.2', '1.2.3-rc.1']) {
    await assert.rejects(syncVersion(version, { root }), /strict SemVer/);
  }
  assert.deepEqual(await snapshot(), before);
});

test('verifyVersions 指名报告兼容性文档漂移', async (t) => {
  const { root, version } = await fixture(t);
  const file = path.join(root, 'docs/compatibility.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace(`RocketX \`v${version}\``, 'RocketX `v0.44.9`'));
  await assert.rejects(verifyVersions(version, { root }), /docs\/compatibility\.md/);
});
