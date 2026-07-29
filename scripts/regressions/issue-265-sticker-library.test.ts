import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyPersonalStickerLibrary,
  mergeStickerImports,
  parseQqStickerDirectory,
  type StickerImportCandidate,
} from '../../apps/web/src/lib/stickerLibrary';

test('QQ pack_info.json + stickers 目录只导入匹配 stickerId 前缀的图片，并保留包名/标题标签（issue #265）', () => {
  const matched = parseQqStickerDirectory(
    {
      packName: '项目回怼包',
      stickers: [
        { stickerId: '101', name: '收到' },
        { stickerId: '102', name: '马上看' },
        { stickerId: '103', name: '缺文件' },
      ],
    },
    [
      { path: 'C:\\Export\\stickers\\101_收到.png', name: '101_收到.png', isFile: true },
      { path: 'C:\\Export\\stickers\\102_马上看.gif', name: '102_马上看.gif', isFile: true },
      { path: 'C:\\Export\\stickers\\README.txt', name: 'README.txt', isFile: true },
    ],
  );

  assert.deepEqual(matched, [
    {
      path: 'C:\\Export\\stickers\\101_收到.png',
      fileName: '101_收到.png',
      title: '收到',
      tags: ['项目回怼包', '收到'],
    },
    {
      path: 'C:\\Export\\stickers\\102_马上看.gif',
      fileName: '102_马上看.gif',
      title: '马上看',
      tags: ['项目回怼包', '马上看'],
    },
  ]);
});

test('个人贴纸库按 digest 去重，并在超出条数/总字节配额时停止吸收新条目（issue #265）', () => {
  const current = {
    version: 1 as const,
    records: [{
      id: 'digest-existing',
      digest: 'digest-existing',
      title: '已有',
      fileName: 'existing.png',
      mimeType: 'image/png',
      size: 4,
      storedPath: 'C:\\library\\existing.png',
      createdAt: 1,
      source: 'file' as const,
      tags: ['已有'],
    }],
  };
  const makeCandidate = (
    digest: string,
    title: string,
    bytes: number,
  ): StickerImportCandidate & { digest: string; storedPath: string; createdAt: number } => ({
    title,
    fileName: `${title}.png`,
    mimeType: 'image/png',
    bytes: new Uint8Array(bytes).fill(1),
    source: 'directory',
    tags: [title],
    digest,
    storedPath: `C:\\library\\${title}.png`,
    createdAt: bytes,
  });

  const { next, report } = mergeStickerImports(
    current,
    [
      makeCandidate('digest-existing', '重复', 5),
      makeCandidate('digest-new-1', '新一张', 6),
      makeCandidate('digest-new-2', '新二张', 7),
    ],
    { maxItems: 2, maxTotalBytes: 10 },
  );

  assert.deepEqual(report, {
    total: 3,
    imported: 1,
    duplicates: 1,
    unsupported: 0,
    quotaSkipped: 1,
  });
  assert.deepEqual(next.records.map((record) => record.digest), ['digest-new-1', 'digest-existing']);
});

test('空库默认是 v1 空记录集（issue #265）', () => {
  assert.deepEqual(emptyPersonalStickerLibrary(), { version: 1, records: [] });
});
