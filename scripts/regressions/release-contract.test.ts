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
const rootManifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const CURRENT_VERSION: string = rootManifest.version;

test('发布标签只接受严格 SemVer', () => {
  assert.equal(parseReleaseTag('v1.0.0'), '1.0.0');
  for (const invalid of ['1.0.0', 'v1.0', 'v01.0.0', 'v1.0.0-rc.1', 'v1.0.0 ']) {
    assert.throws(() => parseReleaseTag(invalid), /strict SemVer/);
  }
});

test(`仓库全部公开版本面与 v${CURRENT_VERSION} 对齐`, async () => {
  await verifyVersions(CURRENT_VERSION);
});

test('0.x 发布不冒充 1.0 成熟度门禁', () => {
  assert.equal(requiresMaturityEvidence(CURRENT_VERSION), false);
  assert.equal(requiresMaturityEvidence('1.0.0'), true);
  assert.equal(requiresMaturityEvidence('2.3.4'), true);
});

test('待发布版本可以从 CHANGELOG 提取用户向 Release notes', async () => {
  const notes = await releaseNotes(CURRENT_VERSION);
  const versionEscaped = CURRENT_VERSION.replaceAll('.', '\\.');
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
  assert.match(desktopWorkflow, /核验发布标签来源与合同/);
  assert.match(tagWorkflow, /git config user\.name/);
  assert.match(tagWorkflow, /github-actions\[bot\]@users\.noreply\.github\.com/);
});
