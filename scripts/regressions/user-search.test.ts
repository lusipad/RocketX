import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcUser } from '../../packages/rc-client/src/index';
import { preloadPinyin } from '../../apps/web/src/lib/pinyin';
import {
  loadUserSearchRoster,
  mergeUserSearchResults,
} from '../../apps/web/src/lib/userSearch';

const user = (_id: string, username: string, name: string): RcUser => ({ _id, username, name });

preloadPinyin();
const pinyinReady = new Promise((resolve) => setTimeout(resolve, 500));

test('本地花名册支持用拼音首字母搜索联系人', async () => {
  await pinyinReady;
  const result = mergeUserSearchResults('ls', [user('1', 'lisi', '李四')], []);
  assert.deepEqual(result.map((item) => item.username), ['lisi']);
});

test('联系人备注名参与拼音搜索', async () => {
  await pinyinReady;
  const result = mergeUserSearchResults(
    'xw',
    [user('1', 'lisi', '李四')],
    [],
    () => '小王',
  );
  assert.deepEqual(result.map((item) => item.username), ['lisi']);
});

test('服务端结果与本地拼音结果按用户 ID 去重并以服务端数据为准', async () => {
  await pinyinReady;
  const local = user('1', 'lisi', '李四');
  const remote = user('1', 'lisi', '李四（远端）');
  const result = mergeUserSearchResults('ls', [local], [remote]);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, '李四（远端）');
});

test('服务端返回的非拼音命中用户仍会保留', async () => {
  await pinyinReady;
  const result = mergeUserSearchResults('ls', [], [user('2', 'wangwu', '王五')]);
  assert.deepEqual(result.map((item) => item.username), ['wangwu']);
});

test('搜索花名册会继续加载第二页的中文姓名', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    user(String(index), `user${index}`, `成员${index}`),
  );
  const calls: number[] = [];
  const result = await loadUserSearchRoster(async (offset) => {
    calls.push(offset);
    return offset === 0
      ? { users: firstPage, total: 101, via: 'directory' }
      : { users: [user('target', 'zhaoliu', '赵六')], total: 101, via: 'directory' };
  });

  assert.deepEqual(calls, [0, 100]);
  assert.deepEqual(
    mergeUserSearchResults('赵六', result.users, []).map((item) => item.username),
    ['zhaoliu'],
  );
});

test('搜索花名册缓存会复用同一账号的完整分页结果', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    user(String(index), `user${index}`, `成员${index}`),
  );
  const calls: number[] = [];
  const fetchPage = async (offset: number) => {
    calls.push(offset);
    return offset === 0
      ? { users: firstPage, total: 101, via: 'directory' }
      : { users: [user('target', 'zhaoliu', '赵六')], total: 101, via: 'directory' };
  };

  const first = await loadUserSearchRoster(fetchPage, { cacheKey: 'server-a\0user-a' });
  const second = await loadUserSearchRoster(fetchPage, { cacheKey: 'server-a\0user-a' });

  assert.deepEqual(calls, [0, 100]);
  assert.equal(first.users.length, 101);
  assert.deepEqual(second, first);
});

test('搜索花名册会保留分页不完整警告', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    user(String(index), `user${index}`, `成员${index}`),
  );
  const result = await loadUserSearchRoster(async (offset) =>
    offset === 0
      ? { users: firstPage, total: 101, via: 'directory' }
      : { users: [user('target', 'zhaoliu', '赵六')], total: 101, via: 'users.list' },
  );

  assert.equal(result.users.length, 100);
  assert.match(result.warning ?? '', /分页数据源发生变化/);
});
