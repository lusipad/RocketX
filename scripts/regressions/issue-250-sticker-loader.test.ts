import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  fetchStickerFile,
  loadStickerCatalog,
  stickerEntryKey,
} from '../../apps/web/src/lib/stickerLoader';

test('贴纸 loader 会逐包/逐项跳过非法 manifest，并保留其他有效包与格式信息（issue #250）', async () => {
  const fetchLog: string[] = [];
  const responses = new Map<string, Response>([
    [
      'https://assets.test/stickers/index.json',
      new Response(JSON.stringify({
        packages: [
          { id: 'basics', manifest: './basics/manifest.json' },
          { id: 'broken-package', manifest: './broken/manifest.json' },
          { id: 'signals', manifest: './signals/manifest.json' },
        ],
      })),
    ],
    [
      'https://assets.test/stickers/basics/manifest.json',
      new Response(JSON.stringify({
        id: 'basics',
        title: '基础动作',
        groups: [
          {
            id: 'daily',
            title: '工作日常',
            items: [
              {
                id: 'focus-frame',
                title: '进入状态',
                src: './focus-frame.png',
                tags: ['focus', 'ready'],
              },
              {
                id: '',
                title: '非法条目',
                src: './broken.png',
              },
              {
                id: 'remote-entry',
                title: '远程条目',
                src: 'https://untrusted.test/remote.png',
              },
              {
                id: 'parent-entry',
                title: '越界条目',
                src: '../outside.png',
              },
            ],
          },
        ],
      })),
    ],
    [
      'https://assets.test/stickers/broken/manifest.json',
      new Response(JSON.stringify({
        id: 'broken-package',
        title: '坏包',
        groups: 'not-an-array',
      })),
    ],
    [
      'https://assets.test/stickers/signals/manifest.json',
      new Response(JSON.stringify({
        id: 'signals',
        title: '协作信号',
        groups: [
          {
            id: 'status',
            title: '会议状态',
            items: [
              {
                id: 'ship-it',
                title: '已收工',
                src: './ship-it.webp',
                tags: ['ship', 'done'],
              },
              {
                id: 'waiting-ping',
                title: '等你一句话',
                src: './waiting-ping.gif',
                tags: ['waiting', 'ping'],
              },
            ],
          },
        ],
      })),
    ],
  ]);

  const catalog = await loadStickerCatalog(
    'https://assets.test/stickers/index.json',
    async (input) => {
      const url = String(input);
      fetchLog.push(url);
      const response = responses.get(url);
      if (!response) return new Response('missing', { status: 404 });
      return response.clone();
    },
  );

  assert.deepEqual(fetchLog, [
    'https://assets.test/stickers/index.json',
    'https://assets.test/stickers/basics/manifest.json',
    'https://assets.test/stickers/broken/manifest.json',
    'https://assets.test/stickers/signals/manifest.json',
  ]);
  assert.deepEqual(catalog.groups.map((group) => group.title), ['工作日常', '会议状态']);
  assert.equal(catalog.entries.length, 3);
  assert.equal(catalog.entries.find((entry) => entry.id === 'focus-frame')?.mimeType, 'image/png');
  assert.equal(catalog.entries.find((entry) => entry.id === 'ship-it')?.mimeType, 'image/webp');
  assert.equal(catalog.entries.find((entry) => entry.id === 'waiting-ping')?.mimeType, 'image/gif');
  assert.equal(catalog.entries.some((entry) => entry.title === '非法条目'), false);
  assert.equal(catalog.entries.some((entry) => entry.id === 'remote-entry'), false);
  assert.equal(catalog.entries.some((entry) => entry.id === 'parent-entry'), false);
  assert.notEqual(
    stickerEntryKey({ packageId: 'basics', id: 'shared' }),
    stickerEntryKey({ packageId: 'signals', id: 'shared' }),
  );
});
test('贴纸资源转 File 时在响应头缺失类型的情况下仍按扩展名保留图片 MIME（issue #250）', async () => {
  const file = await fetchStickerFile(
    {
      id: 'ship-it',
      title: '已收工',
      packageId: 'signals',
      packageTitle: '协作信号',
      groupId: 'status',
      groupTitle: '会议状态',
      src: 'https://assets.test/stickers/signals/ship-it.webp',
      fileName: 'ship-it.webp',
      mimeType: 'image/webp',
      tags: ['ship'],
    },
    async () => new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 }),
  );

  assert.equal(file.name, 'ship-it.webp');
  assert.equal(file.type, 'image/webp');
  assert.equal(file.size, 4);
});

test('真实默认贴纸目录提供 21 张静态贴纸和 3 张 GIF（issue #250）', async () => {
  const stickersRoot = path.resolve('apps/web/public/stickers');
  const rawIndex = JSON.parse(await readFile(path.join(stickersRoot, 'index.json'), 'utf8')) as {
    packages?: Array<{ manifest?: string }>;
  };
  const manifests = (rawIndex.packages ?? [])
    .map((pkg) => typeof pkg.manifest === 'string' ? pkg.manifest : null)
    .filter((manifest): manifest is string => !!manifest);

  let totalEntries = 0;
  const packageIds = new Set<string>();
  const packageCounts = new Map<string, number>();
  const entryIds = new Set<string>();
  for (const manifest of manifests) {
    const manifestPath = path.resolve(stickersRoot, manifest);
    const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      id?: string;
      groups?: Array<{ items?: Array<{ id?: string }> }>;
    };
    const packageId = typeof rawManifest.id === 'string' ? rawManifest.id : '';
    if (packageId) packageIds.add(packageId);
    for (const group of rawManifest.groups ?? []) {
      for (const item of group.items ?? []) {
        if (typeof item.id === 'string' && item.id) {
          totalEntries += 1;
          packageCounts.set(packageId, (packageCounts.get(packageId) ?? 0) + 1);
          entryIds.add(item.id);
        }
      }
    }
  }

  assert.equal(totalEntries, 24);
  assert.equal(packageCounts.get('twemoji'), 21);
  assert.equal(packageCounts.get('noto-animated'), 3);
  assert.ok(packageIds.has('noto-animated'), `缺少 noto-animated 包：${JSON.stringify([...packageIds])}`);
  assert.ok(entryIds.has('1f44d'), '缺少现有静态贴纸 1f44d');
  assert.ok(entryIds.has('1f91d'), `缺少新增静态贴纸 1f91d：${JSON.stringify([...entryIds])}`);
});

test('贴纸资源转 File 时保留多帧 GIF 的 MIME、文件名和原始 GIF89a 字节（issue #250）', async () => {
  const gifBytes = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x02, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
    0x21, 0xf9, 0x04, 0x04, 0x00, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    0x21, 0xf9, 0x04, 0x04, 0x00, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b,
  ]);
  const file = await fetchStickerFile(
    {
      id: 'waiting-ping',
      title: '等你一句话',
      packageId: 'noto-animated',
      packageTitle: 'Noto Animated',
      groupId: 'async-signals',
      groupTitle: '异步信号',
      src: 'https://assets.test/stickers/noto-animated/waiting-ping.gif',
      fileName: 'waiting-ping.gif',
      mimeType: 'image/gif',
      tags: ['waiting'],
    },
    async () => new Response(gifBytes, { status: 200 }),
  );

  assert.equal(file.name, 'waiting-ping.gif');
  assert.equal(file.type, 'image/gif');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), gifBytes);
  assert.equal(new TextDecoder().decode(gifBytes.slice(0, 6)), 'GIF89a');
});
