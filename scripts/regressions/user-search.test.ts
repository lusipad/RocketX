import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcUser } from '../../packages/rc-client/src/index';
import { preloadPinyin } from '../../apps/web/src/lib/pinyin';
import { mergeUserSearchResults } from '../../apps/web/src/lib/userSearch';

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
