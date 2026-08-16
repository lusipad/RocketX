import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RcRestClient } from '../../packages/rc-client/src/rest';

type TwemojiManifest = {
  groups?: Array<{
    items?: Array<{
      id?: string;
      title?: string;
      src?: string;
    }>;
  }>;
};

function readTwemojiManifest(): TwemojiManifest {
  return JSON.parse(
    readFileSync(resolve(__dirname, '../../apps/web/public/stickers/twemoji/manifest.json'), 'utf8'),
  ) as TwemojiManifest;
}

function manifestStickerMap(): Map<string, { title?: string; src?: string }> {
  return new Map(
    (readTwemojiManifest().groups ?? [])
      .flatMap((group) => group.items ?? [])
      .filter((item): item is { id: string; title?: string; src?: string } => typeof item.id === 'string')
      .map((item) => [item.id, { title: item.title, src: item.src }]),
  );
}

test('内置 Twemoji manifest 包含新增常用贴纸资源', () => {
  const stickers = manifestStickerMap();

  assert.deepEqual(stickers.get('1f44c'), { title: 'OK', src: './ok.png' });
  assert.deepEqual(stickers.get('1f44b'), { title: '招手', src: './wave.png' });
  assert.deepEqual(stickers.get('1f44f'), { title: '鼓掌', src: './clap.png' });
  assert.deepEqual(stickers.get('1f525'), { title: '火速', src: './fire.png' });
});

test('uploadMedia 发送 GIF 时保留 image/gif MIME 和原始字节', async () => {
  const requests: Array<{ url: string; init: RequestInit; body: Uint8Array }> = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example.com/',
    authProvider: () => ({ authToken: 'token-123', userId: 'user-456' }),
    fetchImpl: (async (url, init) => {
      const body = init?.body instanceof Uint8Array
        ? init.body
        : new Uint8Array(await new Response(init?.body).arrayBuffer());
      requests.push({ url: String(url), init: init ?? {}, body });
      if (String(url).includes('/rooms.media/')) {
        return new Response(JSON.stringify({ file: { _id: 'file-1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });
  const gifBytes = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);

  await client.uploadMedia(
    'room-1',
    new File([gifBytes], 'wave.gif', { type: 'image/gif' }),
    { msg: 'gif sticker' },
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://chat.example.com/api/v1/rooms.media/room-1');
  const headers = requests[0].init.headers as Record<string, string>;
  assert.match(headers['Content-Type'], /^multipart\/form-data; boundary=/);
  const bodyText = new TextDecoder().decode(requests[0].body);
  assert.match(bodyText, /filename="wave\.gif"/);
  assert.match(bodyText, /Content-Type: image\/gif/);
  assert.match(bodyText, /GIF89a/);
  assert.equal(requests[1].url, 'https://chat.example.com/api/v1/rooms.mediaConfirm/room-1/file-1');
});
