import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RcRestClient } from '../../packages/rc-client/src/rest';

test('删除消息向服务器提交消息自身房间并要求成功确认（issue #123）', async () => {
  let requestUrl = '';
  let requestBody: unknown;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example.test',
    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl = input.toString();
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await client.deleteMessage('room-from-message', 'message-1');
  assert.equal(requestUrl, 'https://chat.example.test/api/v1/chat.delete');
  assert.deepEqual(requestBody, { roomId: 'room-from-message', msgId: 'message-1', asUser: true });
});

test('服务端未确认删除时不能只从本地移除消息', async () => {
  const client = new RcRestClient({
    fetchImpl: (async () => new Response(JSON.stringify({ success: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  });
  await assert.rejects(client.deleteMessage('room', 'message'), /服务器未确认消息删除/);

  const store = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  assert.match(store, /deleteMessage: \(message: Pick<RcMessage, '_id' \| 'rid'>\)/);
  assert.match(store, /const \{ _id: msgId, rid \} = message/);
  assert.doesNotMatch(store, /deleteMessage: async \(msgId\)[\s\S]{0,120}activeRid/);

  for (const path of ['apps/web/src/components/MessageItem.tsx', 'apps/web/src/components/MessageList.tsx']) {
    assert.match(readFileSync(path, 'utf8'), /deleteMessage\(message\)/, path);
  }
});
