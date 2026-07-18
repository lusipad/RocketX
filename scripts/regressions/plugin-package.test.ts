import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unzipSync } from 'node:zlib';

test('发布插件包包含可本地安装的内网通插件', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'rocketx-plugins-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/package-plugins.mjs', '--tag', 'v0.20.1', '--out', temp],
      { cwd: path.resolve(new URL('../..', import.meta.url).pathname), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const zipPath = path.join(temp, 'rocketx-plugins-0.20.1.zip');
    assert.ok((await stat(zipPath)).size > 1_000);

    // ZIP local file headers contain the packaged paths in plain bytes; this avoids shelling out to unzip.
    const content = await readFile(zipPath);
    const listing = content.toString('latin1');
    assert.match(listing, /rocketx-plugins-0\.20\.1\/manifest\.json/);
    assert.match(listing, /rocketx-plugins-0\.20\.1\/intranet-link\/rcx\.app\.json/);
    assert.match(listing, /rocketx-plugins-0\.20\.1\/intranet-link\/index\.html/);
    assert.match(listing, /rocketx-plugins-0\.20\.1\/intranet-link\/README\.md/);
    assert.throws(() => unzipSync(content), /incorrect header check|invalid/i, 'plugin bundle should be a zip, not gzip');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
