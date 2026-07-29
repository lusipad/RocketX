import assert from 'node:assert/strict';
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
