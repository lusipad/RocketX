import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcUser } from '../../packages/rc-client/src/index';
import { collectUserDirectory } from '../../apps/web/src/lib/userDirectory';

const user = (id: string): RcUser => ({ _id: id, username: `user-${id}` });

test('用户目录正常分页并使用正确 offset', async () => {
  const offsets: number[] = [];
  const result = await collectUserDirectory(
    { users: [user('1'), user('2')], total: 5, via: 'directory' },
    async (offset) => {
      offsets.push(offset);
      return offset === 2
        ? { users: [user('3'), user('4')], total: 5, via: 'directory' }
        : { users: [user('5')], total: 5, via: 'directory' };
    },
    { pageSize: 2 },
  );

  assert.deepEqual(offsets, [2, 4]);
  assert.deepEqual(result.users.map((item) => item._id), ['1', '2', '3', '4', '5']);
  assert.equal(result.warning, undefined);
});

test('重复满页会在第一次无进展时停止', async () => {
  let calls = 0;
  const first = { users: [user('1'), user('2')], total: 100_000, via: 'directory' };
  const result = await collectUserDirectory(
    first,
    async () => {
      calls++;
      return first;
    },
    { pageSize: 2 },
  );

  assert.equal(calls, 1);
  assert.equal(result.users.length, 2);
  assert.match(result.warning ?? '', /没有新增用户/);
});

test('达到用户上限后停止并保留截断警告', async () => {
  let calls = 0;
  const result = await collectUserDirectory(
    { users: [user('1'), user('2')], total: 10, via: 'users.list' },
    async () => {
      calls++;
      return { users: [user('3'), user('4')], total: 10, via: 'users.list' };
    },
    { pageSize: 2, maxUsers: 3, maxPages: 2 },
  );

  assert.equal(calls, 1);
  assert.equal(result.users.length, 3);
  assert.match(result.warning ?? '', /最多加载 3 人/);
});

test('分页数据源变化时停止，避免混合不同排序的目录', async () => {
  const result = await collectUserDirectory(
    { users: [user('1')], total: 3, via: 'directory' },
    async () => ({ users: [user('2')], total: 3, via: 'users.list' }),
    { pageSize: 1 },
  );

  assert.deepEqual(result.users.map((item) => item._id), ['1']);
  assert.match(result.warning ?? '', /数据源发生变化/);
});

test('服务端提前返回空页时停止并保留已加载用户', async () => {
  const result = await collectUserDirectory(
    { users: [user('1')], total: 3, via: 'directory' },
    async () => ({ users: [], total: 3, via: 'directory' }),
    { pageSize: 1 },
  );

  assert.deepEqual(result.users.map((item) => item._id), ['1']);
  assert.match(result.warning ?? '', /只返回了 1 人/);
});

test('达到页面请求上限时停止并报告部分结果', async () => {
  let calls = 0;
  const result = await collectUserDirectory(
    { users: [user('1')], total: 10, via: 'directory' },
    async () => {
      calls++;
      return { users: [user(String(calls + 1))], total: 10, via: 'directory' };
    },
    { pageSize: 1, maxUsers: 10, maxPages: 2 },
  );

  assert.equal(calls, 1);
  assert.deepEqual(result.users.map((item) => item._id), ['1', '2']);
  assert.match(result.warning ?? '', /达到 2 页请求上限/);
});

test('请求期间查询失效时不合并返回页且不继续分页', async () => {
  let current = true;
  let calls = 0;
  const result = await collectUserDirectory(
    { users: [user('1')], total: 10, via: 'directory' },
    async () => {
      calls++;
      current = false;
      return { users: [user('2')], total: 10, via: 'directory' };
    },
    { pageSize: 1, isCurrent: () => current },
  );

  assert.equal(calls, 1);
  assert.deepEqual(result.users.map((item) => item._id), ['1']);
  assert.equal(result.warning, undefined);
});
