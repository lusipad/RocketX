import test from 'node:test';
import assert from 'node:assert/strict';
import { imageBlobWithDetectedMime, sniffImageMime } from '../../apps/web/src/lib/imageMime';

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><path fill="#000" d="M40 40h520v160H40z"/></svg>',
);

test('PNG 字节 + .svg URL：按魔数判定为 image/png，不再被 URL 后缀带偏', async () => {
  const blob = new Blob([PNG_BYTES], { type: '' });
  const sniffed = await sniffImageMime(blob);
  assert.equal(sniffed, 'image/png');

  const fixed = await imageBlobWithDetectedMime(blob, '/file-upload/thumb-id/wooden-docks.svg');
  assert.equal(fixed.type, 'image/png');
  assert.deepEqual(new Uint8Array(await fixed.arrayBuffer()), PNG_BYTES);
});

test('PNG 字节 + .svg URL + 服务端谎报 image/svg+xml：字节嗅探覆盖声明 MIME', async () => {
  const blob = new Blob([PNG_BYTES], { type: 'image/svg+xml' });
  const fixed = await imageBlobWithDetectedMime(blob, '/file-upload/thumb-id/wooden-docks.svg');
  assert.equal(fixed.type, 'image/png');
  assert.deepEqual(new Uint8Array(await fixed.arrayBuffer()), PNG_BYTES);
});

test('PNG 字节 + application/octet-stream：嗅探出 image/png', async () => {
  const blob = new Blob([PNG_BYTES], { type: 'application/octet-stream' });
  const fixed = await imageBlobWithDetectedMime(blob, '/file-upload/thumb-id/img.svg');
  assert.equal(fixed.type, 'image/png');
});

test('真实 SVG 字节：判定为 image/svg+xml', async () => {
  const blob = new Blob([SVG_BYTES], { type: '' });
  const sniffed = await sniffImageMime(blob);
  assert.equal(sniffed, 'image/svg+xml');

  const fixed = await imageBlobWithDetectedMime(blob, '/file-upload/thumb-id/wooden-docks.svg');
  assert.equal(fixed.type, 'image/svg+xml');
});

test('SVG 字节 + 谎报 image/png：字节嗅探覆盖（黑底 SVG 在灯箱的空白场景同源）', async () => {
  const blob = new Blob([SVG_BYTES], { type: 'image/png' });
  const fixed = await imageBlobWithDetectedMime(blob, '/file-upload/thumb-id/wooden-docks.svg');
  assert.equal(fixed.type, 'image/svg+xml');
});

test('声明 MIME 有效且与嗅探一致时保持原值', async () => {
  const blob = new Blob([PNG_BYTES], { type: 'image/png' });
  const fixed = await imageBlobWithDetectedMime(blob, '/file-upload/thumb-id/logo.png');
  assert.equal(fixed.type, 'image/png');
});
