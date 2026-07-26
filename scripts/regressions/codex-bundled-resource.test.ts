import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('两个安装包都不携带 Codex，full 只带增强 OCR', async () => {
  const [configText, hooks] = await Promise.all([
    readFile('apps/desktop/src-tauri/tauri.full.conf.json', 'utf8'),
    readFile('apps/desktop/src-tauri/windows/full-installer-hooks.nsh', 'utf8'),
  ]);
  const config = JSON.parse(configText) as {
    bundle: {
      createUpdaterArtifacts: boolean;
      resources: Record<string, string>;
      windows: { nsis: { installerHooks: string } };
    };
  };
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.resources['target/codex-resources/codex/'], undefined);
  assert.equal(
    config.bundle.resources['target/ocr-resources/ocr/'],
    'full-resources/ocr/',
  );
  assert.equal(
    config.bundle.windows.nsis.installerHooks,
    './windows/full-installer-hooks.nsh',
  );
  assert.doesNotMatch(hooks, /codex/i);
  assert.match(hooks, /\$LOCALAPPDATA\\RocketX\\resources\\ocr/);
  assert.match(hooks, /RMDir \/r "\$INSTDIR\\full-resources"/);
});
