import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('DSH 运行时以固定 npm 产物随 RocketX 打包，并在 prepare 合同里自证版本', async () => {
  const [rootPackageText, runtimePackageText, tauriConfigText, prepareScript, workspace, dshRs, notes] =
    await Promise.all([
      readFile('package.json', 'utf8'),
      readFile('apps/dsh-runtime/package.json', 'utf8'),
      readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'),
      readFile('scripts/prepare-dsh-runtime.mjs', 'utf8'),
      readFile('pnpm-workspace.yaml', 'utf8'),
      readFile('apps/desktop/src-tauri/src/dsh.rs', 'utf8'),
      readFile('docs/implementation-notes-dsh.md', 'utf8'),
    ]);

  const rootPackage = JSON.parse(rootPackageText) as {
    scripts?: Record<string, string>;
  };
  const runtimePackage = JSON.parse(runtimePackageText) as {
    name: string;
    private: boolean;
    dependencies?: Record<string, string>;
  };
  const tauriConfig = JSON.parse(tauriConfigText) as {
    build?: { beforeDevCommand?: string; beforeBuildCommand?: string };
    bundle?: { resources?: Record<string, string> };
  };

  assert.equal(rootPackage.scripts?.['prepare:dsh-runtime'], 'node scripts/prepare-dsh-runtime.mjs');
  assert.equal(runtimePackage.name, '@rcx/dsh-runtime');
  assert.equal(runtimePackage.private, true);
  assert.equal(runtimePackage.dependencies?.['@deepseek-ai/dsh'], '0.1.0-rc.6');

  assert.doesNotMatch(tauriConfig.build?.beforeDevCommand ?? '', /prepare:dsh-runtime/);
  assert.match(tauriConfig.build?.beforeBuildCommand ?? '', /^pnpm -w prepare:sidecars && pnpm -w run prepare:dsh-runtime && /);
  assert.equal(tauriConfig.bundle?.resources?.['target/dsh-runtime/'], 'dsh-runtime/');

  assert.doesNotMatch(prepareScript, /\bshell\s*:/);
  assert.match(prepareScript, /resolvePnpmInvocation/);
  assert.match(prepareScript, /process\.env\.APPDATA/);
  assert.match(prepareScript, /pnpm\.mjs/);
  assert.match(prepareScript, /runtimePackage\.dependencies\?\.\['@deepseek-ai\/dsh'\]/);
  assert.match(prepareScript, /部署产物实际安装版本必须是 @deepseek-ai\/dsh@\$\{dshVersion\}/u);
  assert.match(prepareScript, /'--trust-lockfile'/);
  assert.match(prepareScript, /'--filter'/);
  assert.match(prepareScript, /'@rcx\/dsh-runtime'/);
  assert.match(prepareScript, /'deploy'/);
  assert.match(prepareScript, /staging\.root/);
  assert.match(prepareScript, /'--prod'/);
  assert.match(prepareScript, /'--legacy'/);
  assert.doesNotMatch(prepareScript, /'--ignore-scripts'/);
  assert.match(prepareScript, /process\.execPath, \[staging\.cliPath, '--version'\]/);
  assert.match(prepareScript, /'--profile', 'web', '--dump-default-config'/);
  assert.match(prepareScript, /dsh-web-app/);
  assert.match(prepareScript, /dsh-host-webserver/);
  assert.match(prepareScript, /dsh-llm-deepseek/);
  assert.match(prepareScript, /assert\.equal\(\s*versionProbe\.stdout\.trim\(\),\s*dshVersion/u);
  assert.match(prepareScript, /Prepared DSH runtime at \$\{deployRoot\} \(\$\{summary\.files\} files, \$\{summary\.bytes\} bytes\)/);

  assert.match(workspace, /'@deepseek-ai\/dsh-subprocess-local@0\.1\.0-rc\.6': true/);
  assert.match(workspace, /'node-pty@1\.1\.0': true/);
  assert.match(workspace, /minimumReleaseAgeExclude:\s*\n\s*- '@deepseek-ai\/\*'/);
  assert.match(workspace, /supportedArchitectures:\s*\n\s*cpu:\s*\n\s*- x64\s*\n\s*- arm64/);

  assert.match(dshRs, /const DSH_BUNDLED_RUNTIME_DIR: &str = "dsh-runtime";/);
  assert.match(dshRs, /const DSH_BUNDLED_CLI_ENTRY: \[&str; 5\]/);
  assert.match(dshRs, /resource_dir\(\)[\s\S]*DSH_BUNDLED_RUNTIME_DIR/);
  assert.match(dshRs, /if cfg!\(debug_assertions\) \{\s*roots\.push\(development_bundled_runtime_root\(\)\);/);
  assert.match(dshRs, /pnpm prepare:dsh-runtime/u);
  assert.match(dshRs, /DSH 运行需要 22\.19\+ 或 24\+/u);

  assert.match(notes, /固定随 RocketX 安装包分发官方 npm/);
  assert.match(notes, /apps\/dsh-runtime\/package\.json/);
  assert.match(notes, /pnpm install/);
  assert.match(notes, /pnpm run prepare:dsh-runtime/);
});
