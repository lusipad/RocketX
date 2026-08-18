import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcPreferences } from '../../packages/rc-client/src/index';
import { rest } from '../../apps/web/src/lib/client';
import {
  listArchivedAliases,
  useAliases,
} from '../../apps/web/src/stores/aliases';

/**
 * 导入历史备注（issue #350 跟进）：换服务器地址后，旧备注被 accountScope
 * 归档为 `rcx-aliases#<userId>@<serverBase>`，这里锁定「扫描 → 合并导入」语义。
 */

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

// 当前登录账号：user-cur，同源（不设 rcx-server → same-origin）
storage.setItem('rcx-auth', JSON.stringify({ authToken: 'tok', userId: 'user-cur' }));

const originalSetPreferences = rest.setPreferences;
let writes: Partial<RcPreferences>[];
let warns: string[];
const originalWarn = console.warn;

function reset() {
  storage.clear();
  storage.setItem('rcx-auth', JSON.stringify({ authToken: 'tok', userId: 'user-cur' }));
  useAliases.setState({ aliases: {} });
  writes = [];
  warns = [];
}

test.beforeEach(() => {
  console.warn = (...args: unknown[]) => warns.push(String(args[0]));
  rest.setPreferences = async (data) => {
    writes.push(data);
  };
});

test.afterEach(() => {
  console.warn = originalWarn;
  rest.setPreferences = originalSetPreferences;
  reset();
});

test('扫描：列出所有归档的 owner/serverBase/条目数，排除当前账号', () => {
  reset();
  storage.setItem('rcx-aliases#u-old@http://old-ip:3000', JSON.stringify({ 'u:a': '甲', 'r:r1': '群' }));
  storage.setItem('rcx-aliases#u2@http://10.0.0.2:3100', JSON.stringify({ 'u:b': '乙' }));
  // 当前账号（user-cur@same-origin）的归档理论上不存在，但要容错排除
  storage.setItem('rcx-aliases#user-cur@same-origin', JSON.stringify({ 'u:c': '丙' }));
  // 其他 scoped key 的归档不属于备注
  storage.setItem('rcx-todos#u-old@http://old-ip:3000', JSON.stringify([1, 2]));

  const list = listArchivedAliases();

  assert.deepEqual(list, [
    { owner: 'u-old@http://old-ip:3000', serverBase: 'http://old-ip:3000', count: 2 },
    { owner: 'u2@http://10.0.0.2:3100', serverBase: 'http://10.0.0.2:3100', count: 1 },
  ]);
});

test('扫描：JSON 损坏与空归档跳过并告警', () => {
  reset();
  storage.setItem('rcx-aliases#u-bad@http://x:1', '{broken');
  storage.setItem('rcx-aliases#u-arr@http://x:2', '[1,2]');
  storage.setItem('rcx-aliases#u-empty@http://x:3', '{}');
  storage.setItem('rcx-aliases#u-ok@http://x:4', JSON.stringify({ 'u:a': '甲' }));

  const list = listArchivedAliases();

  assert.deepEqual(list, [{ owner: 'u-ok@http://x:4', serverBase: 'http://x:4', count: 1 }]);
  assert.equal(warns.length, 2, '两个损坏归档各告警一次');
});

test('导入：当前已有的键优先，归档只补缺；服务端写回成功后删除归档', async () => {
  reset();
  useAliases.setState({ aliases: { 'u:a': '当前备注' } });
  storage.setItem('rcx-aliases', JSON.stringify({ 'u:a': '当前备注' }));
  storage.setItem(
    'rcx-aliases#u-old@http://old-ip:3000',
    JSON.stringify({ 'u:a': '旧备注', 'u:b': '只存在于归档' }),
  );

  const added = await useAliases.getState().importArchived('u-old@http://old-ip:3000');

  assert.equal(added, 1, '只有 u:b 是新补入的');
  assert.deepEqual(useAliases.getState().aliases, {
    'u:a': '当前备注',
    'u:b': '只存在于归档',
  });
  // 本机缓存持久化
  assert.equal(
    storage.getItem('rcx-aliases'),
    JSON.stringify({ 'u:a': '当前备注', 'u:b': '只存在于归档' }),
  );
  // 归档 key 已删除
  assert.equal(storage.getItem('rcx-aliases#u-old@http://old-ip:3000'), null);
  // 触发服务端写回（realtime 未连接 → savePreferences 落到 REST）
  assert.deepEqual(writes, [
    { rcxAliases: { 'u:a': '当前备注', 'u:b': '只存在于归档' } },
  ]);
});

test('导入：服务端写回失败时保留归档，避免丢失可恢复数据', async () => {
  reset();
  storage.setItem(
    'rcx-aliases#u-old@http://old-ip:3000',
    JSON.stringify({ 'u:b': '只存在于归档' }),
  );
  rest.setPreferences = async () => {
    throw new Error('offline');
  };

  const added = await useAliases.getState().importArchived('u-old@http://old-ip:3000');

  assert.equal(added, 1);
  assert.deepEqual(useAliases.getState().aliases, { 'u:b': '只存在于归档' });
  assert.notEqual(storage.getItem('rcx-aliases#u-old@http://old-ip:3000'), null);
  assert.match(warns[0] ?? '', /写回服务端失败/);
});

test('导入：归档不存在或损坏时返回 0，不产生写回', async () => {
  reset();
  storage.setItem('rcx-aliases#u-bad@http://x:1', '{broken');

  assert.equal(await useAliases.getState().importArchived('u-nobody@http://x:9'), 0);
  assert.equal(await useAliases.getState().importArchived('u-bad@http://x:1'), 0);
  assert.equal(writes.length, 0);
  assert.equal(warns.length, 1, '损坏归档告警一次');
  // 损坏的归档保留在原地（不该由导入动作悄悄删掉）
  assert.equal(storage.getItem('rcx-aliases#u-bad@http://x:1'), '{broken');
});
