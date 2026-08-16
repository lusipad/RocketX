import assert from 'node:assert/strict';
import test from 'node:test';
import { RcApiError, RcRestClient } from '../../packages/rc-client/src/rest';

type CapturedRequest = {
  url: string;
  init: RequestInit;
  body: Uint8Array;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new Uint8Array();
}

function parseMultipartParts(body: Uint8Array, contentType: string): string[] {
  const match = /boundary=([^;]+)/i.exec(contentType);
  assert.ok(match, 'multipart 请求缺少 boundary');
  const boundary = match[1];
  const decoded = new TextDecoder().decode(body);
  return decoded
    .split(`--${boundary}`)
    .map((part) => part.trim())
    .filter((part) => part && part !== '--');
}

function makeClient(
  responder: (url: string, init: RequestInit, body: Uint8Array) => Response | Promise<Response>,
): RcRestClient {
  return new RcRestClient({
    baseUrl: 'https://chat.example.com/',
    authProvider: () => ({ authToken: 'token-123', userId: 'user-456' }),
    fetchImpl: (async (url, init) => {
      const body = await readBodyBytes(init?.body);
      return await responder(String(url), init ?? {}, body);
    }) as typeof fetch,
  });
}

test('getCustomEmojiByName 用 name 查询并规范化 aliases 数组', async () => {
  const requests: CapturedRequest[] = [];
  const client = makeClient((url, init, body) => {
    requests.push({ url, init, body });
    return jsonResponse({
      emojis: [
        { name: 'other', aliases: ['ignore'] },
        { name: 'rocketx_sticker_twemoji_1f914', aliases: ' think , , ponder ' },
      ],
    });
  });

  const emoji = await client.getCustomEmojiByName('rocketx_sticker_twemoji_1f914');

  assert.deepEqual(emoji, {
    name: 'rocketx_sticker_twemoji_1f914',
    aliases: ['think', 'ponder'],
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://chat.example.com/api/v1/emoji-custom.all?name=rocketx_sticker_twemoji_1f914',
  );
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.headers?.['X-Auth-Token' as never], 'token-123');
  assert.equal(requests[0].body.length, 0);
});

test('createCustomEmoji 发送带文本字段和原始文件字节的 multipart 请求', async () => {
  const requests: CapturedRequest[] = [];
  const client = makeClient((url, init, body) => {
    requests.push({ url, init, body });
    return jsonResponse({ success: true });
  });
  const fileBytes = new Uint8Array([1, 2, 3, 4, 5]);

  await client.createCustomEmoji({
    name: 'rocketx_sticker_twemoji_1f914',
    file: new Blob([fileBytes], { type: 'image/png' }),
    fileName: 'thinking.png',
    aliases: ['think', 'ponder'],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://chat.example.com/api/v1/emoji-custom.create');
  assert.equal(requests[0].init.method, 'POST');
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers['X-Auth-Token'], 'token-123');
  assert.equal(headers['X-User-Id'], 'user-456');
  assert.match(headers['Content-Type'], /^multipart\/form-data; boundary=/);

  const parts = parseMultipartParts(requests[0].body, headers['Content-Type']);
  assert.equal(parts.length, 3);
  assert.match(parts[0], /name="name"/);
  assert.match(parts[0], /\r\n\r\nrocketx_sticker_twemoji_1f914$/);
  assert.match(parts[1], /name="aliases"/);
  assert.match(parts[1], /\r\n\r\nthink,ponder$/);
  assert.match(parts[2], /name="emoji"; filename="thinking\.png"/);
  assert.match(parts[2], /Content-Type: image\/png/);
  assert.match(parts[2], /\u0001\u0002\u0003\u0004\u0005/);
});

test('setAvatar 保持单文件 multipart 且不附带额外文本字段', async () => {
  const requests: CapturedRequest[] = [];
  const client = makeClient((url, init, body) => {
    requests.push({ url, init, body });
    return jsonResponse({ success: true });
  });

  await client.setAvatar(new Blob([new Uint8Array([9, 8, 7])], { type: 'image/jpeg' }), 'me.jpg');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://chat.example.com/api/v1/users.setAvatar');
  const headers = requests[0].init.headers as Record<string, string>;
  const parts = parseMultipartParts(requests[0].body, headers['Content-Type']);

  assert.equal(parts.length, 1);
  assert.match(parts[0], /name="image"; filename="me\.jpg"/);
  assert.match(parts[0], /Content-Type: image\/jpeg/);
  assert.doesNotMatch(parts[0], /name="name"/);
  assert.doesNotMatch(parts[0], /name="aliases"/);
});

test('multipart 非 2xx 响应转成 RcApiError 并保留状态码和 errorType', async () => {
  const client = makeClient(() =>
    jsonResponse(
      {
        error: 'emoji create denied',
        errorType: 'error-not-allowed',
      },
      403,
    ),
  );

  await assert.rejects(
    client.createCustomEmoji({
      name: 'rocketx_sticker_twemoji_1f914',
      file: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      fileName: 'thinking.png',
    }),
    (error: unknown) => {
      assert.ok(error instanceof RcApiError);
      assert.equal(error.message, 'emoji create denied');
      assert.equal(error.status, 403);
      assert.equal(error.errorType, 'error-not-allowed');
      return true;
    },
  );
});
