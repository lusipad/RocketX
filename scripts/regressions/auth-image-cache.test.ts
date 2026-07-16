import assert from 'node:assert/strict';
import test from 'node:test';
import { BlobUrlCache } from '../../apps/web/src/lib/blobUrlCache';

test('头像缓存只回收未使用的最旧 objectURL', () => {
  const revoked: string[] = [];
  const cache = new BlobUrlCache(2, (url) => revoked.push(url));
  cache.put('active', 'blob:active');
  cache.retain('active');
  cache.put('old', 'blob:old');
  cache.put('new', 'blob:new');

  assert.equal(cache.get('active'), 'blob:active');
  assert.equal(cache.get('old'), null);
  assert.equal(cache.get('new'), 'blob:new');
  assert.deepEqual(revoked, ['blob:old']);
});

test('超过上限时若全部仍在使用，释放后再安全回收', () => {
  const revoked: string[] = [];
  const cache = new BlobUrlCache(1, (url) => revoked.push(url));
  cache.put('first', 'blob:first');
  cache.retain('first');
  cache.put('second', 'blob:second');
  cache.retain('second');
  assert.equal(cache.size, 2);

  cache.release('first');
  assert.equal(cache.get('first'), null);
  assert.equal(cache.get('second'), 'blob:second');
  assert.deepEqual(revoked, ['blob:first']);
});

test('大量切换头像后缓存稳定收敛到上限', () => {
  const cache = new BlobUrlCache(128, () => undefined);
  for (let index = 0; index < 1000; index += 1) {
    cache.put(`avatar-${index}`, `blob:${index}`);
  }
  assert.equal(cache.size, 128);
});
