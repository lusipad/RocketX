import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * convertAsciiEmoji / hideUsernames 是死键：没有 UI 写入、没有代码消费，
 * 只躺在默认值和类型里让「这个开关管什么」变成谜。已从两端移除，这里锁定不回潮。
 */
const DEAD_KEYS = ['convertAsciiEmoji', 'hideUsernames'];

const FILES = [
  ['apps/web/src/stores/prefs.ts', '../../apps/web/src/stores/prefs.ts'],
  ['packages/rc-client/src/types.ts', '../../packages/rc-client/src/types.ts'],
] as const;

for (const [label, path] of FILES) {
  test(`${label} 不再携带死键 ${DEAD_KEYS.join(' / ')}`, async () => {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    for (const key of DEAD_KEYS) {
      assert.ok(!source.includes(key), `${label} 仍引用死键 ${key}`);
    }
  });
}
