import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  parseReleaseTag,
  publicSdkPackage,
  releaseNotes,
  requiresMaturityEvidence,
  verifyVersions,
} from '../verify-release.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

async function currentVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  return manifest.version;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('发布标签只接受严格 SemVer', () => {
  assert.equal(parseReleaseTag('v1.0.0'), '1.0.0');
  for (const invalid of ['1.0.0', 'v1.0', 'v01.0.0', 'v1.0.0-rc.1', 'v1.0.0 ']) {
    assert.throws(() => parseReleaseTag(invalid), /strict SemVer/);
  }
});

test('仓库全部公开版本面与当前版本对齐', async () => {
  const version = await currentVersion();
  assert.equal(publicSdkPackage, '@lusipad/rocketx');
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
  const [npmWorkflow, releaseWorkflow, desktopWorkflow, tagWorkflow, tauriConfigText] = await Promise.all([
    readFile(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/publish-release.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/tag-version.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ]);
  const tauriConfig = JSON.parse(tauriConfigText);

  for (const workflow of [npmWorkflow, releaseWorkflow]) {
    assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*inputs\.tag/);
    assert.match(workflow, /git cat-file -t/);
  }
  assert.match(npmWorkflow, /git merge-base --is-ancestor/);
  // publish 与 desktop 的校验语义刻意不同：构建发生在打 tag 的瞬间，tag 必须
  // 就是 main 头（下面 desktop.yml 的断言仍是严格等值）；发布则常晚于继续开发，
  // 只要求 tag 在 main 历史上——v0.32.0 曾因 main 前进 6 个提交被旧校验卡死。
  assert.match(releaseWorkflow, /git merge-base --is-ancestor "\$release_sha" origin\/main/);
  assert.match(npmWorkflow, /RELEASE_SHA/);
  assert.match(npmWorkflow, /pnpm pack --pack-destination/);
  assert.match(npmWorkflow, /manifest\.gitHead = releaseSha/);
  assert.match(npmWorkflow, /grep -q '\"workspace:/);
  assert.match(npmWorkflow, /npm publish \"\$tarball\" --access public --provenance/);
  assert.doesNotMatch(npmWorkflow, /cd \"\$directory\" && npm publish/);
  assert.doesNotMatch(npmWorkflow, /@rcx\/app-sdk/);
  assert.doesNotMatch(releaseWorkflow, /npm view/);
  assert.doesNotMatch(releaseWorkflow, /@rcx\/app-sdk|create-rcx-app/);
  assert.match(releaseWorkflow, /environment:\s*release/);
  assert.match(releaseWorkflow, /isDraft/);
  assert.match(releaseWorkflow, /verify-release-assets\.mjs/);
  assert.match(releaseWorkflow, /sha256sum -c SHA256SUMS\.txt/);
  assert.match(releaseWorkflow, /--draft=false --latest/);
  assert.doesNotMatch(releaseWorkflow, /--latest=false|STABLE_LATEST_TAG/);
  assert.match(releaseWorkflow, /三平台/);
  assert.match(releaseWorkflow, /public-release-assets/);
  assert.match(
    releaseWorkflow,
    /test "\$\(gh api "repos\/\$GITHUB_REPOSITORY\/releases\/latest" --jq '\.tag_name'\)" = "\$INPUT_TAG"/,
  );
  assert.match(desktopWorkflow, /核验发布标签来源与合同/);
  assert.doesNotMatch(desktopWorkflow, /ROCKETX_BUNDLE_CODEX/);
  assert.match(desktopWorkflow, /ROCKETX_BUNDLE_OCR/);
  assert.match(desktopWorkflow, /package-full-setup\.ps1/);
  assert.match(desktopWorkflow, /gh release upload[\s\S]*\$fullInstaller/);
  const buildJob = desktopWorkflow.match(/\n  build:[\s\S]*?\n  prepare-release:/)?.[0] ?? '';
  assert.match(buildJob, /matrix:/);
  assert.match(buildJob, /windows-latest/);
  assert.match(buildJob, /macos-latest/);
  assert.match(buildJob, /ubuntu-22\.04/);
  assert.match(buildJob, /updaterJsonPreferNsis:\s*true/);
  assert.match(buildJob, /\.dmg/);
  assert.match(buildJob, /\.AppImage/);
  assert.match(buildJob, /\.deb/);
  assert.match(buildJob, /\.rpm/);
  assert.match(buildJob, /matrix\.platform == 'windows-latest'/);
  assert.equal(tauriConfig.bundle.targets, 'all');
  assert.equal(tauriConfig.bundle.macOS.signingIdentity, '-');
  assert.match(desktopWorkflow, /test "\$release_sha" = "\$\(git rev-parse origin\/main\)"/);
  const prepareRelease = desktopWorkflow.match(/prepare-release:[\s\S]*$/)?.[0] ?? '';
  assert.match(prepareRelease, /核验三平台产物并准备草稿 Release/);
  assert.match(prepareRelease, /pnpm\/action-setup@v5[\s\S]*pnpm package:plugins/);
  const draftReleaseEditIndex = prepareRelease.search(/gh release edit[^\n]*--draft[^\n]*--notes-file RELEASE_NOTES\.md/);
  const draftAssertionIndexes = [...prepareRelease.matchAll(/test "\$\(gh release view[^\n]*--json isDraft[^\n]*\)" = "true"/g)].map(
    (match) => match.index ?? -1,
  );
  assert.notEqual(draftReleaseEditIndex, -1);
  assert.equal(draftAssertionIndexes.length, 2);
  assert.ok(draftAssertionIndexes[0] < draftReleaseEditIndex);
  assert.ok(draftReleaseEditIndex < draftAssertionIndexes[1]);
  assert.match(tagWorkflow, /git config user\.name/);
  assert.match(tagWorkflow, /github-actions\[bot\]@users\.noreply\.github\.com/);
});

test('发布文档与当前三平台 Latest 目标一致', async () => {
  const version = await currentVersion();
  const [releaseGuide, compatibility, changelog] = await Promise.all([
    readFile(new URL('../../docs/release/README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/compatibility.md', import.meta.url), 'utf8'),
    readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
  ]);
  const escapedVersion = escapeRegex(version);

  assert.match(releaseGuide, new RegExp(`current release target is \`v${escapedVersion}\``));
  assert.match(releaseGuide, /Windows x64, macOS universal, and Linux x64/);
  assert.match(releaseGuide, /three-platform Release as GitHub Latest/);
  assert.match(compatibility, new RegExp('RocketX `v' + escapedVersion + '` desktop line is split\\.'));
  assert.match(compatibility, /Starting with `v0\.43\.0`/);
  assert.match(compatibility, /not Apple-notarized/);
  assert.match(changelog, new RegExp(`^## v${escapedVersion} - `, 'm'));
  assert.match(changelog, /恢复 Windows、macOS 和 Linux 三平台交付/);
});
