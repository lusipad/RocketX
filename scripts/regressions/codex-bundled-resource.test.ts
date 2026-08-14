import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('slim 不携带 Codex/DSH 运行时，Windows full 额外携带 Codex、DSH archive、Node 与 OCR', async () => {
  const [configText, hooks, packageScript, workflow] = await Promise.all([
    readFile('apps/desktop/src-tauri/tauri.full.conf.json', 'utf8'),
    readFile('apps/desktop/src-tauri/windows/full-installer-hooks.nsh', 'utf8'),
    readFile('scripts/package-full-setup.ps1', 'utf8'),
    readFile('.github/workflows/desktop.yml', 'utf8'),
  ]);
  const config = JSON.parse(configText) as {
    bundle: {
      createUpdaterArtifacts: boolean;
      resources: Record<string, string>;
      windows: { nsis: { installerHooks: string } };
    };
  };
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(
    config.bundle.resources['target/codex-resources/codex/'],
    'full-resources/codex/',
  );
  assert.equal(
    config.bundle.resources['target/ocr-resources/ocr/'],
    'full-resources/ocr/',
  );
  assert.equal(
    config.bundle.resources['target/dsh-runtime.tar.gz'],
    'full-resources/dsh-runtime.tar.gz',
  );
  assert.equal(
    config.bundle.resources['target/node-resources/node/'],
    'full-resources/node/',
  );
  assert.equal(
    config.bundle.windows.nsis.installerHooks,
    './windows/full-installer-hooks.nsh',
  );
  assert.match(hooks, /\$LOCALAPPDATA\\RocketX\\resources\.__staging\\ocr/);
  assert.match(hooks, /\$LOCALAPPDATA\\RocketX\\resources\.__staging\\codex/);
  assert.match(hooks, /\$LOCALAPPDATA\\RocketX\\resources\.__staging\\node/);
  assert.match(hooks, /\$LOCALAPPDATA\\RocketX\\resources\.__staging\\dsh-runtime\.tar\.gz/);
  assert.match(hooks, /Rename "\$LOCALAPPDATA\\RocketX\\resources" "\$LOCALAPPDATA\\RocketX\\resources\.__old"/);
  assert.match(hooks, /Rename "\$LOCALAPPDATA\\RocketX\\resources\.__staging" "\$LOCALAPPDATA\\RocketX\\resources"/);
  assert.match(hooks, /原有资源保持不变/u);
  assert.match(hooks, /RMDir \/r "\$INSTDIR\\full-resources"/);
  assert.match(packageScript, /Get-Command node\.exe[^\r\n]*\|\s*[\r\n]+\s*Select-Object -First 1/);
  assert.match(packageScript, /Full setup requires Node\.js 22\.19\+ or 24\+/);
  assert.match(workflow, /matrix\.platform == 'windows-latest' && '22\.19\.0' \|\| '22'/);
});
