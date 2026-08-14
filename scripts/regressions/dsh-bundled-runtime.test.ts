import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('DSH 运行时归档只进入 Windows full 包，slim 仅携带 bridge，并在 prepare 合同里自证版本', async () => {
  const [rootPackageText, runtimePackageText, tauriConfigText, fullConfigText, prepareScript, workspace, desktopWorkflow, dshRs] =
    await Promise.all([
      readFile('package.json', 'utf8'),
      readFile('apps/dsh-runtime/package.json', 'utf8'),
      readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'),
      readFile('apps/desktop/src-tauri/tauri.full.conf.json', 'utf8'),
      readFile('scripts/prepare-dsh-runtime.mjs', 'utf8'),
      readFile('pnpm-workspace.yaml', 'utf8'),
      readFile('.github/workflows/desktop.yml', 'utf8'),
      readFile('apps/desktop/src-tauri/src/dsh.rs', 'utf8'),
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
  const fullConfig = JSON.parse(fullConfigText) as {
    bundle?: { resources?: Record<string, string> };
  };

  assert.equal(rootPackage.scripts?.['prepare:dsh-runtime'], 'node scripts/prepare-dsh-runtime.mjs');
  assert.equal(runtimePackage.name, '@rcx/dsh-runtime');
  assert.equal(runtimePackage.private, true);
  assert.equal(runtimePackage.dependencies?.['@deepseek-ai/dsh'], '0.1.0-rc.6');

  assert.doesNotMatch(tauriConfig.build?.beforeDevCommand ?? '', /prepare:dsh-runtime/);
  assert.equal(tauriConfig.build?.beforeBuildCommand, 'pnpm -w prepare:sidecars && pnpm --filter @rcx/web build');
  assert.equal(tauriConfig.bundle?.resources?.['src/dsh_bridge.mjs'], 'dsh_bridge.mjs');
  assert.equal(tauriConfig.bundle?.resources?.['target/dsh-runtime.tar.gz'], undefined);
  assert.equal(fullConfig.bundle?.resources?.['target/dsh-runtime.tar.gz'], 'full-resources/dsh-runtime.tar.gz');

  assert.doesNotMatch(prepareScript, /\bshell\s*:/);
  assert.match(prepareScript, /resolvePnpmInvocation/);
  assert.match(prepareScript, /process\.env\.APPDATA/);
  assert.match(prepareScript, /pnpm\.mjs/);
  assert.match(prepareScript, /runtimePackage\.dependencies\?\.\['@deepseek-ai\/dsh'\]/);
  assert.match(prepareScript, /deployedPackage\.dependencies\?\.\['@deepseek-ai\/dsh'\]\?\.split\('\(', 1\)\[0\]/);
  assert.match(prepareScript, /部署产物实际安装版本必须是 @deepseek-ai\/dsh@\$\{dshVersion\}/u);
  assert.match(prepareScript, /'--trust-lockfile'/);
  assert.match(prepareScript, /'--config\.node-linker=hoisted'/);
  assert.match(prepareScript, /'--config\.prefer-symlinked-executables=false'/);
  assert.match(prepareScript, /'--filter'/);
  assert.match(prepareScript, /'@rcx\/dsh-runtime'/);
  assert.match(prepareScript, /'deploy'/);
  assert.match(prepareScript, /staging\.root/);
  assert.match(prepareScript, /'--prod'/);
  assert.match(prepareScript, /summary\.symlinks\.length/);
  assert.match(prepareScript, /部署产物不能包含 symlink/u);
  assert.match(prepareScript, /const archivePath = path\.join\(tauriRoot, 'target', 'dsh-runtime\.tar\.gz'\)/);
  assert.match(prepareScript, /const archiveStagingPath = `\$\{archivePath\}\.__staging`/);
  assert.match(prepareScript, /tarCommand\(\)/);
  assert.match(prepareScript, /\['-czf', archiveStagingPath, '-C', staging\.root, '\.'\]/);
  assert.match(prepareScript, /replacePathAtomically\(archivePath, archiveStagingPath\)/);
  assert.doesNotMatch(prepareScript, /'--legacy'/);
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
  assert.match(workspace, /injectWorkspacePackages: true/);
  assert.match(workspace, /minimumReleaseAgeExclude:\s*\n\s*- '@deepseek-ai\/\*'/);
  assert.match(workspace, /supportedArchitectures:\s*\n\s*cpu:\s*\n\s*- x64\s*\n\s*- arm64/);

  const prepareRuntimeIndex = desktopWorkflow.indexOf('run: pnpm prepare:dsh-runtime');
  const rustTestsIndex = desktopWorkflow.indexOf('- name: Rust 单元测试');
  assert.ok(prepareRuntimeIndex >= 0);
  assert.ok(rustTestsIndex > prepareRuntimeIndex);

  assert.match(dshRs, /const DSH_BUNDLED_RUNTIME_DIR: &str = "dsh-runtime";/);
  assert.match(dshRs, /const DSH_VERIFIED_VERSION: &str = "0\.1\.0-rc\.6";/);
  assert.match(dshRs, /const DSH_BUNDLED_RUNTIME_ARCHIVE: &str = "dsh-runtime\.tar\.gz";/);
  assert.match(dshRs, /const DSH_BUNDLED_RUNTIME_CACHE_DIR: &str = "bundled-runtime";/);
  assert.match(dshRs, /const DSH_BUNDLED_CLI_ENTRY: \[&str; 5\]/);
  assert.match(dshRs, /resource_dir\(\)[\s\S]*DSH_BUNDLED_RUNTIME_ARCHIVE/);
  assert.match(dshRs, /if cfg!\(debug_assertions\) \{\s*archives\.push\(development_bundled_runtime_archive\(\)\);/);
  assert.match(dshRs, /prepare_bundled_runtime_root_from_archive/);
  assert.match(dshRs, /archive\s*\.\s*unpack\(&staging_root\)/);
  assert.match(dshRs, /bundled_runtime_marker_matches/);
  assert.match(dshRs, /if let Some\(bundled_root\) = resolve_debug_bundled_runtime_root\(\)\?/);
  assert.match(dshRs, /verify_installed_dsh_version\(&node_path, &cli_path\)/);
  assert.match(dshRs, /resolve_node_runtime\(app, use_private_node\)/);
  assert.match(
    dshRs,
    /if use_private_node \{\s*bundled\s*\} else \{\s*system\.into_iter\(\)\.collect\(\)/,
  );
  assert.match(dshRs, /pnpm prepare:dsh-runtime/u);
  assert.match(dshRs, /DSH 运行需要 22\.19\+ 或 24\+/u);
});
