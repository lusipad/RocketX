import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcUser } from '../../packages/rc-client/src/index';
import { RcRestClient } from '../../packages/rc-client/src/rest';

const user = (id: string): RcUser => ({ _id: id, username: `user-${id}` });

function json(members: RcUser[], total?: number): Response {
  return new Response(
    JSON.stringify({ success: true, members, ...(total === undefined ? {} : { total }) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('成员分页在无 total 的重复满页上立即报错', async () => {
  let calls = 0;
  const page = [user('1'), user('2')];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      calls++;
      if (calls > 3) throw new Error('测试保护：旧实现仍在重复请求');
      return json(page);
    }) as typeof fetch,
  });

  await assert.rejects(client.getMembers('room', 'c', 2), /没有新增成员/);
  assert.equal(calls, 2);
});

test('成员分页不能用重复记录追平 total 后返回残缺结果', async () => {
  let calls = 0;
  const page = [user('1'), user('2')];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      calls++;
      return json(page, 4);
    }) as typeof fetch,
  });

  await assert.rejects(client.getMembers('room', 'c', 2), /没有新增成员/);
  assert.equal(calls, 2);
});

test('成员分页达到请求页数上限后报错', async () => {
  let calls = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input: URL | RequestInfo) => {
      calls++;
      if (calls > 1_001) throw new Error('测试保护：旧实现超过预期请求预算');
      const offset = new URL(String(input)).searchParams.get('offset') ?? '0';
      return json([user(offset)]);
    }) as typeof fetch,
  });

  await assert.rejects(client.getMembers('room', 'c', 1), /分页请求达到 1000 页上限/);
  assert.equal(calls, 1_000);
});

test('已知 total 时提前空页会报成员列表不完整', async () => {
  let calls = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      calls++;
      return calls === 1 ? json([user('1')], 2) : json([], 2);
    }) as typeof fetch,
  });

  await assert.rejects(client.getMembers('room', 'c', 1), /成员列表不完整/);
  assert.equal(calls, 2);
});

test('后续页省略 total 时仍保留首屏完整性约束', async () => {
  let calls = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      calls++;
      if (calls === 1) return json([user('1')], 3);
      if (calls === 2) return json([user('2')]);
      return json([]);
    }) as typeof fetch,
  });

  await assert.rejects(client.getMembers('room', 'c', 1), /成员列表不完整/);
  assert.equal(calls, 3);
});

test('非正 count 保持旧行为并按每页 1 人请求', async () => {
  let requestedCount = '';
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input: URL | RequestInfo) => {
      requestedCount = new URL(String(input)).searchParams.get('count') ?? '';
      return json([user('1')], 1);
    }) as typeof fetch,
  });

  const members = await client.getMembers('room', 'c', 0);
  assert.equal(requestedCount, '1');
  assert.equal(members.length, 1);
});
