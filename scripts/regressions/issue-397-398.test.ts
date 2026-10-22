import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDiscussion,
  normalizeDiscussionName,
  RcRestClient,
  ROOM_NAME_MAX_LENGTH,
} from '../../packages/rc-client/src/index';
import { prepareTauriRequestInit } from '../../apps/web/src/lib/http';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test('讨论名称完全支持中文、空格与常用标点，不走 ASCII slug 转换（issue #397）', () => {
  assert.equal(normalizeDiscussionName('需求评审'), '需求评审');
  assert.equal(normalizeDiscussionName('关于 v2 架构设计的讨论'), '关于 v2 架构设计的讨论');
  assert.equal(normalizeDiscussionName('#123 修复登录失败（紧急）🎉'), '#123 修复登录失败（紧急）🎉');
  assert.equal(normalizeDiscussionName('  去除首尾空白  '), '去除首尾空白');
  assert.equal(normalizeDiscussionName(''), '讨论');
  assert.equal(normalizeDiscussionName('   ', '兜底'), '兜底');

  // 超长截断至 ROOM_NAME_MAX_LENGTH
  const longChinese = '长'.repeat(ROOM_NAME_MAX_LENGTH + 20);
  assert.equal(normalizeDiscussionName(longChinese).length, ROOM_NAME_MAX_LENGTH);
  assert.equal(normalizeDiscussionName(longChinese), '长'.repeat(ROOM_NAME_MAX_LENGTH));
});

test('createDiscussion 接口发出中文原名 t_name，不落入哈希兜底（issue #397）', async () => {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
      captured.push({
        path: String(input).replace(/^.*\/api\/v1\//, ''),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ success: true, discussion: { _id: 'd1', fname: '需求评审' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await client.createDiscussion('parent-1', '需求评审');

  assert.equal(captured[0].path, 'rooms.createDiscussion');
  assert.equal(captured[0].body.prid, 'parent-1');
  assert.equal(captured[0].body.t_name, '需求评审');
  assert.doesNotMatch(String(captured[0].body.t_name), /^discussion-[0-9a-f]{8}$/);
});

test('prepareTauriRequestInit 完整保留 Accept-Encoding: identity 请求头（issue #398）', () => {
  const init: RequestInit = {
    headers: {
      'Accept-Encoding': 'identity',
      'X-Auth-Token': 'tok-123',
    },
  };
  const prepared = prepareTauriRequestInit(init);
  const headers = prepared.headers as Record<string, string>;

  // 不能经过 browser new Headers() 导致 forbidden header 被静默吞掉
  assert.equal(headers['Accept-Encoding'], 'identity');
  assert.equal(headers['X-Auth-Token'], 'tok-123');
  assert.equal(headers['Origin'], '');
});

test('响应带 content-encoding 时将 total 视为未知，避免误判传输中断（issue #398）', async () => {
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      // 代理返回 gzip 压缩流：content-length 是压缩前（1000 字节），但接收体仅 50 字节
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes('<html><body>compressed</body></html>'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-encoding': 'gzip',
          'content-length': '1000',
        },
      });
    }) as typeof fetch,
  });

  // openFileStream 内部在 content-encoding 非 identity 时应将 total 置为 null
  const { stream, total } = await client.openFileStream('/file-upload/1/page.html');
  assert.equal(total, null, '压缩响应 content-length 与流不匹配时 total 必须是 null');

  const reader = stream.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
  }
  assert.ok(received > 0);
  assert.ok(received < 1000);
});
