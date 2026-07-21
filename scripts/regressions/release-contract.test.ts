import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  parseReleaseTag,
  releaseNotes,
  requiresMaturityEvidence,
  verifyVersions,
} from '../verify-release.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

async function currentVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  return manifest.version;
}

test('发布标签只接受严格 SemVer', () => {
  assert.equal(parseReleaseTag('v1.0.0'), '1.0.0');
  for (const invalid of ['1.0.0', 'v1.0', 'v01.0.0', 'v1.0.0-rc.1', 'v1.0.0 ']) {
    assert.throws(() => parseReleaseTag(invalid), /strict SemVer/);
  }
});

test('仓库全部公开版本面与当前版本对齐', async () => {
  const version = await currentVersion();
  await verifyVersions(version);
});

test('0.x 发布不冒充 1.0 成熟度门禁', async () => {
  const version = await currentVersion();
  assert.equal(requiresMaturityEvidence(version), false);
  assert.equal(requiresMaturityEvidence('1.0.0'), true);
  assert.equal(requiresMaturityEvidence('2.3.4'), true);
});

test('待发布版本可以从 CHANGELOG 提取用户向 Release notes', async () => {
  const version = await currentVersion();
  const notes = await releaseNotes(version);
  const versionEscaped = version.replaceAll('.', '\\.');
  assert.match(notes, new RegExp(`^# RocketX v${versionEscaped}`, 'm'));
  assert.doesNotMatch(notes, /^## v0\.15/m);
});

test('发布工作流先验证 main 上的注解标签再执行标签代码', async () => {
  const [npmWorkflow, releaseWorkflow, desktopWorkflow, tagWorkflow] = await Promise.all([
    readFile(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/publish-release.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/tag-version.yml', import.meta.url), 'utf8'),
  ]);

  for (const workflow of [npmWorkflow, releaseWorkflow]) {
    assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*inputs\.tag/);
    assert.match(workflow, /git cat-file -t/);
    assert.match(workflow, /git merge-base --is-ancestor/);
  }
  assert.match(npmWorkflow, /RELEASE_SHA/);
  assert.match(npmWorkflow, /pnpm pack --pack-destination/);
  assert.match(npmWorkflow, /manifest\.gitHead = releaseSha/);
  assert.match(npmWorkflow, /grep -q '\"workspace:/);
  assert.match(npmWorkflow, /npm publish \"\$tarball\" --access public --provenance/);
  assert.doesNotMatch(npmWorkflow, /cd \"\$directory\" && npm publish/);
  assert.doesNotMatch(releaseWorkflow, /npm view/);
  assert.doesNotMatch(releaseWorkflow, /@rcx\/app-sdk|create-rcx-app/);
  assert.match(releaseWorkflow, /environment:\s*release/);
  assert.match(releaseWorkflow, /isDraft/);
  assert.match(releaseWorkflow, /verify-release-assets\.mjs/);
  assert.match(releaseWorkflow, /sha256sum -c SHA256SUMS\.txt/);
  assert.match(releaseWorkflow, /--draft=false --latest/);
  assert.match(desktopWorkflow, /核验发布标签来源与合同/);
  const prepareRelease = desktopWorkflow.match(/prepare-release:[\s\S]*$/)?.[0] ?? '';
  assert.match(prepareRelease, /pnpm\/action-setup@v5[\s\S]*pnpm package:plugins/);
  assert.match(tagWorkflow, /git config user\.name/);
  assert.match(tagWorkflow, /github-actions\[bot\]@users\.noreply\.github\.com/);
});
