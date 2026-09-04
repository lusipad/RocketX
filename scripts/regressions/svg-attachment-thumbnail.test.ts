import test from 'node:test';
import assert from 'node:assert/strict';
import { RcRestClient } from '../../packages/rc-client/src/index';

test('Tauri 文件响应按真实 Content-Type 恢复 SVG 的 PNG 缩略图 MIME', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const client = new RcRestClient({
    baseUrl: 'https://rc.example.com',
    fetchImpl: (async () => {
      const response = new Response(png);
      Object.defineProperty(response, 'headers', {
        value: new Headers({ 'content-type': 'image/png' }),
      });
      return response;
    }) as typeof fetch,
  });

  const blob = await client.fetchFile('/file-upload/thumb-id/wooden-docks.svg');

  assert.equal(blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), png);
});
