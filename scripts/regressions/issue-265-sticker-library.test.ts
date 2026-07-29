import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  applyPreparedStickerImport,
  canCollectMessageSticker,
  emptyPersonalStickerLibrary,
  mergeStickerImports,
  parseQqStickerDirectory,
  resolveCollectibleStickerSource,
  resolveStickerDirectoryEntries,
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

test('QQ stickers 子目录路径通过 join 解析，避免手工反斜杠在 POSIX 语义下失真（issue #265）', async () => {
  const resolved = await resolveStickerDirectoryEntries(
    '/tmp/export/stickers',
    [{ name: '101_wave.png', isFile: true }],
    async (left, right) => path.posix.join(left, right),
  );

  assert.deepEqual(resolved, [{
    name: '101_wave.png',
    isFile: true,
    path: '/tmp/export/stickers/101_wave.png',
  }]);
});

test('写入中途失败时回滚本次新增文件，但不误删既有 digest 文件（issue #265）', async () => {
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
  const prepared = [
    {
      title: '第一张',
      fileName: 'first.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      source: 'file' as const,
      tags: ['第一张'],
      digest: 'digest-first',
      storedPath: 'C:\\library\\first.png',
      createdAt: 10,
    },
    {
      title: '第二张',
      fileName: 'second.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([4, 5, 6]),
      source: 'file' as const,
      tags: ['第二张'],
      digest: 'digest-second',
      storedPath: 'C:\\library\\second.png',
      createdAt: 11,
    },
  ];
  const writes: string[] = [];
  const removals: string[] = [];

  await assert.rejects(
    applyPreparedStickerImport(current, prepared, {
      writeFile: async (targetPath) => {
        writes.push(targetPath);
        if (targetPath.endsWith('second.png')) throw new Error('disk full');
      },
      removeFile: async (targetPath) => {
        removals.push(targetPath);
      },
      persistLibrary: async () => {
        throw new Error('should not persist');
      },
    }),
    /disk full/,
  );

  assert.deepEqual(writes, ['C:\\library\\first.png', 'C:\\library\\second.png']);
  assert.deepEqual(removals, ['C:\\library\\first.png']);
});

test('持久化失败时回滚本次新增文件（issue #265）', async () => {
  const prepared = [{
    title: '第一张',
    fileName: 'first.png',
    mimeType: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
    source: 'file' as const,
    tags: ['第一张'],
    digest: 'digest-first',
    storedPath: 'C:\\library\\first.png',
    createdAt: 10,
  }];
  const removals: string[] = [];

  await assert.rejects(
    applyPreparedStickerImport({ version: 1, records: [] }, prepared, {
      writeFile: async () => {},
      removeFile: async (targetPath) => {
        removals.push(targetPath);
      },
      persistLibrary: async () => {
        throw new Error('persist failed');
      },
    }),
    /persist failed/,
  );

  assert.deepEqual(removals, ['C:\\library\\first.png']);
});

test('消息收藏只接受安全的真实图片附件，并优先使用 image_url（issue #265）', () => {
  const pngMessage = {
    file: { name: 'wave.png', type: 'image/png' },
    attachments: [{
      title: 'wave.png',
      image_url: '/file-upload/thumb/wave.png',
      title_link: '/file-upload/full/wave.png',
    }],
  };
  const titleLinkOnlyImage = {
    file: { name: 'photo.jpg', type: 'image/jpeg' },
    attachments: [{
      title: 'photo.jpg',
      title_link: '/file-upload/full/photo.jpg',
    }],
  };
  const arbitraryLink = {
    file: { name: 'report.pdf', type: 'application/pdf' },
    attachments: [{
      title: 'report.pdf',
      title_link: '/file-upload/full/report.pdf',
    }],
  };
  const svgMessage = {
    file: { name: 'unsafe.svg', type: 'image/svg+xml' },
    attachments: [{
      title: 'unsafe.svg',
      image_url: '/file-upload/full/unsafe.svg',
      title_link: '/file-upload/full/unsafe.svg',
    }],
  };

  assert.equal(canCollectMessageSticker(pngMessage as any), true);
  assert.equal(resolveCollectibleStickerSource(pngMessage as any)?.sourcePath, '/file-upload/thumb/wave.png');
  assert.equal(canCollectMessageSticker(titleLinkOnlyImage as any), true);
  assert.equal(resolveCollectibleStickerSource(titleLinkOnlyImage as any)?.sourcePath, '/file-upload/full/photo.jpg');
  assert.equal(canCollectMessageSticker(arbitraryLink as any), false);
  assert.equal(canCollectMessageSticker(svgMessage as any), false);
});
