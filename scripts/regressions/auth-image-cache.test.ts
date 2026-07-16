import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthImageBlobCache } from '../../apps/web/src/lib/authImageCache';
import { BlobUrlCache } from '../../apps/web/src/lib/blobUrlCache';
import {
  NearViewportRegistry,
  type NearViewportObserverFactory,
} from '../../apps/web/src/lib/nearViewport';

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

test('消息图片缓存写满后不会淘汰头像缓存', () => {
  const cache = new AuthImageBlobCache(4, 2, () => undefined);
  cache.put('/avatar/user-a', 'avatar-a', 'blob:avatar-a');
  cache.put('/avatar/user-b', 'avatar-b', 'blob:avatar-b');

  cache.put('/file-upload/first.png', 'content-1', 'blob:content-1');
  cache.put('/file-upload/second.png', 'content-2', 'blob:content-2');
  cache.put('/file-upload/third.png', 'content-3', 'blob:content-3');

  assert.equal(cache.get('/avatar/user-a', 'avatar-a'), 'blob:avatar-a');
  assert.equal(cache.get('/avatar/user-b', 'avatar-b'), 'blob:avatar-b');
  assert.equal(cache.size('avatar'), 2);
  assert.equal(cache.size('content'), 2);
});

test('离屏头像共享观察器，并只在各自进入视口附近后加载', () => {
  let callback:
    | ((entries: readonly { isIntersecting: boolean; target: Element }[]) => void)
    | undefined;
  let observed = 0;
  let unobserved = 0;
  let disconnected = 0;
  let created = 0;
  const first = {} as Element;
  const second = {} as Element;
  const visible: string[] = [];
  const factory: NearViewportObserverFactory = (next, options) => {
    created += 1;
    assert.equal(options.rootMargin, '200px');
    callback = next;
    return {
      observe: () => {
        observed += 1;
      },
      unobserve: () => {
        unobserved += 1;
      },
      disconnect: () => {
        disconnected += 1;
      },
    };
  };
  const registry = new NearViewportRegistry(factory);

  const cleanupFirst = registry.observe(first, () => visible.push('first'));
  const cleanupSecond = registry.observe(second, () => visible.push('second'));
  assert.equal(created, 1);
  assert.equal(observed, 2);

  callback?.([{ isIntersecting: false, target: first }]);
  assert.deepEqual(visible, []);

  callback?.([{ isIntersecting: true, target: first }]);
  assert.deepEqual(visible, ['first']);
  assert.equal(unobserved, 1);
  assert.equal(disconnected, 0);

  cleanupFirst();
  cleanupSecond();
  assert.equal(unobserved, 2);
  assert.equal(disconnected, 1);
});
