import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import { searchMessagesGlobal } from '../../apps/web/src/lib/quickSearch';

const message = (id: string) => ({ _id: id } as RcMessage);

test('全局消息搜索的合法空结果不会触发逐房间回退', async () => {
  let roomCalls = 0;
  const result = await searchMessagesGlobal('nothing', ['a', 'b'], {
    global: async () => ({ message: { docs: [] } }),
    room: async () => {
      roomCalls++;
      return [];
    },
  });

  assert.deepEqual(result, []);
  assert.equal(roomCalls, 0);
});

test('全局搜索不可用时逐房间回退并发不超过 2', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await searchMessagesGlobal('needle', ['a', 'b', 'c', 'd'], {
    global: async () => {
      throw new Error('global unavailable');
    },
    room: async (rid) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return [message(rid)];
    },
  });

  assert.deepEqual(result.map((item) => item._id), ['a', 'b', 'c', 'd']);
  assert.equal(maxActive, 2);
});

test('逐房间回退失败会向界面抛错而不是伪装成零命中', async () => {
  await assert.rejects(
    searchMessagesGlobal('needle', ['a'], {
      global: async () => {
        throw new Error('global unavailable');
      },
      room: async () => {
        throw new Error('429 Too Many Requests');
      },
    }),
    /429/,
  );
});

test('过期查询不会在全局搜索失败后继续发起回退请求', async () => {
  let roomCalls = 0;
  const result = await searchMessagesGlobal(
    'stale',
    ['a', 'b'],
    {
      global: async () => {
        throw new Error('global unavailable');
      },
      room: async () => {
        roomCalls++;
        return [];
      },
    },
    () => false,
  );

  assert.deepEqual(result, []);
  assert.equal(roomCalls, 0);
});
