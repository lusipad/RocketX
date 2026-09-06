import test from 'node:test';
import assert from 'node:assert/strict';
import type { RcMessage } from '../../packages/rc-client/src/index';
import { RcRestClient } from '../../packages/rc-client/src/rest';

const message = (id: string, ts: string): RcMessage =>
  ({ _id: id, rid: 'r1', tmid: 'root', msg: `m-${id}`, ts, u: { _id: 'u1', username: 'admin' } }) as RcMessage;

function page(ids: string[], startOffset: number, total?: number): Response {
  return new Response(
    JSON.stringify({
      success: true,
      messages: ids.map((id, i) => message(id, new Date(Date.UTC(2026, 0, 1, 0, 0, startOffset + i)).toISOString())),
      ...(total === undefined ? {} : { total }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('话题消息超过一页时自动翻页拉全并按时间排序', async () => {
  const urls: string[] = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      urls.push(url.searchParams.get('offset') ?? '');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (offset === 0) return page(['a', 'b'], 0, 3);
      return page(['c'], 2, 3);
    }) as typeof fetch,
  });

  const list = await client.getThreadMessages('root', 2);
  assert.deepEqual(list.map((m) => m.msg), ['m-a', 'm-b', 'm-c']);
  assert.deepEqual(urls, ['0', '2']);
});

test('短页即停，不再多发请求', async () => {
  let calls = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      calls++;
      return page(['a'], 0);
    }) as typeof fetch,
  });

  const list = await client.getThreadMessages('root');
  assert.equal(list.length, 1);
  assert.equal(calls, 1);
});

test('重复消息按 _id 去重，不会把旧记录数进来', async () => {
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input: URL | RequestInfo) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset') ?? 0);
      if (offset === 0) return page(['a', 'b'], 0, 3);
      // 服务端翻页边界抖动：a 又出现一次
      return page(['a', 'c'], 2, 3);
    }) as typeof fetch,
  });

  const list = await client.getThreadMessages('root', 2);
  assert.deepEqual(list.map((m) => m._id), ['a', 'b', 'c']);
});
