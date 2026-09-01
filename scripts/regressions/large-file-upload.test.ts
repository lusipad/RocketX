import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DESKTOP_INLINE_UPLOAD_LIMIT,
  UPLOAD_SPOOL_CHUNK,
  safeSpoolName,
  shouldSpoolUpload,
  spoolChunkRanges,
} from '../../apps/web/src/lib/uploadRouting';

const MB = 1024 * 1024;

test('桌面端大文件必须走落盘通道，浏览器端和小文件保持直传（issue #377）', () => {
  // 500MB 直传会被 Tauri HTTP 插件展开成五亿元素的数组 → Invalid array length
  assert.equal(shouldSpoolUpload(500 * MB, true), true);
  assert.equal(shouldSpoolUpload(DESKTOP_INLINE_UPLOAD_LIMIT + 1, true), true);
  assert.equal(shouldSpoolUpload(DESKTOP_INLINE_UPLOAD_LIMIT, true), false);
  assert.equal(shouldSpoolUpload(64 * 1024, true), false);
  // 浏览器 fetch 自己会流式发送 Blob，不需要落盘
  assert.equal(shouldSpoolUpload(500 * MB, false), false);
  assert.equal(shouldSpoolUpload(Number.NaN, true), false);
});

test('落盘分块覆盖整个文件且每块不超过一个 chunk', () => {
  const size = 500 * MB;
  const ranges = spoolChunkRanges(size);
  assert.equal(ranges[0][0], 0);
  assert.equal(ranges[ranges.length - 1][1], size);
  let covered = 0;
  for (const [start, end] of ranges) {
    assert.ok(end > start);
    assert.ok(end - start <= UPLOAD_SPOOL_CHUNK);
    assert.equal(start, covered);
    covered = end;
  }
  assert.equal(covered, size);
  // 空文件也要写一次，否则原生上传拿不到文件
  assert.deepEqual(spoolChunkRanges(0), [[0, 0]]);
  assert.deepEqual(spoolChunkRanges(3, 2), [[0, 2], [2, 3]]);
});

test('落盘文件名保留原名，只清掉路径分隔符和控制字符', () => {
  assert.equal(safeSpoolName('季度报告 2026-Q3.pdf'), '季度报告 2026-Q3.pdf');
  assert.equal(safeSpoolName('..\\..\\etc\\passwd'), '.._.._etc_passwd');
  assert.equal(safeSpoolName('a/b:c*d?.bin'), 'a_b_c_d_.bin');
  assert.equal(safeSpoolName('   '), 'file');
  assert.ok(safeSpoolName('长'.repeat(400)).length <= 120);
});

test('内存文件的上传入口统一走通道选择，不再直接 uploadMedia', async () => {
  const store = await readFile(new URL('../../apps/web/src/stores/chat.ts', import.meta.url), 'utf8');
  assert.match(store, /if \(shouldSpoolUpload\(blob\.size, isTauri\)\) \{/);
  assert.match(store, /await uploadBlobToRoom\(rid, file, \{/);
  // 转发时重新上传的附件同样可能是大文件
  assert.match(store, /await uploadBlobToRoom\(rid, blob, \{/);
  // rest.uploadMedia 只保留通道选择函数里的那一处
  assert.equal(store.match(/rest\.uploadMedia\(/g)?.length, 1);

  const desktop = await readFile(
    new URL('../../apps/web/src/platform/desktopFs.ts', import.meta.url),
    'utf8',
  );
  assert.match(desktop, /for \(const \[start, end\] of spoolChunkRanges\(blob\.size\)\)/);
  assert.match(desktop, /await writeFile\(target, chunk, \{ append: start > 0 \}\)/);
  assert.match(desktop, /await uploadDesktopFile\(target, rid/);
  assert.match(desktop, /await remove\(root, \{ recursive: true \}\)/);
});

test('落盘目录已在桌面端 fs 能力白名单里', async () => {
  const capabilities = JSON.parse(
    await readFile(
      new URL('../../apps/desktop/src-tauri/capabilities/default.json', import.meta.url),
      'utf8',
    ),
  ) as { permissions: (string | { identifier: string; allow?: string[] })[] };
  const scope = capabilities.permissions.find(
    (entry): entry is { identifier: string; allow?: string[] } =>
      typeof entry === 'object' && entry.identifier === 'fs:scope',
  );
  assert.ok(scope?.allow?.includes('$APPDATA/upload-spool'));
  assert.ok(scope?.allow?.includes('$APPDATA/upload-spool/**'));
});
