import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcPreferences } from '../../packages/rc-client/src/index';
import { rest, realtime } from '../../apps/web/src/lib/client';
import {
  buildAliasExport,
  parseAliasExport,
  useAliases,
} from '../../apps/web/src/stores/aliases';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

type AliasMap = Record<string, string>;

const originalSetPreferences = rest.setPreferences;
const storage = new MemoryStorage();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

/** 记录导入时发往服务端的 preferences */
let writes: Partial<RcPreferences>[] = [];

function reset(aliases: AliasMap = {}) {
  useAliases.setState({ aliases, nameFormat: 'alias' });
  storage.removeItem('rcx-aliases');
  writes = [];
}

test.afterEach(() => {
  rest.setPreferences = originalSetPreferences;
  realtime.status = 'idle';
  reset();
});

// ---- 导出 / 解析 ----

test('导出只含人的备注：r: 会话备注被过滤（rid 换服务器即失效，走账号同步）', () => {
  const text = buildAliasExport({ 'u:zhangsan': '张三', 'r:room-1': '值班群' });
  const file = JSON.parse(text) as { aliases: AliasMap };
  assert.deepEqual(file.aliases, { 'u:zhangsan': '张三' });
});

test('导出再解析是恒等往返（人的备注）', () => {
  const aliases: AliasMap = { 'u:zhangsan': '张三', 'u:lisi': '李四' };
  const parsed = parseAliasExport(buildAliasExport(aliases));
  assert.deepEqual(parsed, { aliases, skippedRooms: 0 });
});

test('解析兼容手写的裸 key→备注 映射，并丢弃空白备注', () => {
  const parsed = parseAliasExport(
    JSON.stringify({ 'u:lisi': ' 李四 ', 'u:empty': '   ' }),
  );
  assert.deepEqual(parsed, { aliases: { 'u:lisi': '李四' }, skippedRooms: 0 });
});

test('旧版导出文件里的 r: 会话备注被跳过并计数，不影响人的备注导入', () => {
  const parsed = parseAliasExport(
    JSON.stringify({
      version: 1,
      aliases: { 'u:zhangsan': '张三', 'r:room-1': '值班群', 'r:room-2': '产品群' },
    }),
  );
  assert.deepEqual(parsed, { aliases: { 'u:zhangsan': '张三' }, skippedRooms: 2 });
});

test('非法文件一律拒绝：坏 JSON、数组、非备注键、非字符串值', () => {
  assert.equal(parseAliasExport('not json'), null);
  assert.equal(parseAliasExport('[]'), null);
  assert.equal(parseAliasExport(JSON.stringify({ 'x:foo': 'bar' })), null);
  assert.equal(parseAliasExport(JSON.stringify({ 'u:a': 42 })), null);
  // 包装结构里 aliases 字段非法也拒绝
  assert.equal(parseAliasExport(JSON.stringify({ version: 1, aliases: [] })), null);
});

// ---- 导入 ----

test('导入只补缺不覆盖：已有键保持本机值，返回实际补入条数并写回服务端', async () => {
  reset({ 'u:zhangsan': '本机备注' });
  rest.setPreferences = async (data) => {
    writes.push(data);
  };

  const added = await useAliases.getState().importAliases({
    'u:zhangsan': '文件里的备注',
    'r:room-1': '值班群',
  });

  assert.equal(added, 1);
  assert.deepEqual(useAliases.getState().aliases, {
    'u:zhangsan': '本机备注',
    'r:room-1': '值班群',
  });
  assert.equal(
    storage.getItem('rcx-aliases'),
    JSON.stringify({ 'u:zhangsan': '本机备注', 'r:room-1': '值班群' }),
  );
  assert.deepEqual(writes, [
    { rcxAliases: { 'u:zhangsan': '本机备注', 'r:room-1': '值班群' } },
  ]);
});

test('文件里的备注全部已有时不改动、不写回', async () => {
  reset({ 'u:zhangsan': '本机备注' });
  rest.setPreferences = async (data) => {
    writes.push(data);
  };

  const added = await useAliases.getState().importAliases({ 'u:zhangsan': '别的值' });

  assert.equal(added, 0);
  assert.deepEqual(useAliases.getState().aliases, { 'u:zhangsan': '本机备注' });
  assert.equal(writes.length, 0);
});

test('离线导入：写回失败不回滚本地，备注先在本机生效', async () => {
  reset();
  rest.setPreferences = async () => {
    throw new Error('离线');
  };

  const added = await useAliases.getState().importAliases({ 'u:wangwu': '王五' });

  assert.equal(added, 1);
  assert.deepEqual(useAliases.getState().aliases, { 'u:wangwu': '王五' });
  assert.equal(storage.getItem('rcx-aliases'), JSON.stringify({ 'u:wangwu': '王五' }));
});
