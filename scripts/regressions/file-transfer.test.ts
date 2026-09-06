import test from 'node:test';
import assert from 'node:assert/strict';
import { RcRestClient } from '../../packages/rc-client/src/rest';

function streamResponse(chunks: Uint8Array[], headers: Record<string, string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test('流式下载按块回调进度，total 取自 content-length，内容完整', async () => {
  const progresses: Array<{ loaded: number; total: number | null }> = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () =>
      streamResponse([bytes('hello '), bytes('world')], {
        'content-type': 'text/plain',
        'content-length': '11',
      })) as typeof fetch,
  });

  const blob = await client.fetchFileWithProgress('/file-upload/a', {
    onProgress: (loaded, total) => progresses.push({ loaded, total }),
  });

  assert.equal(await blob.text(), 'hello world');
  assert.equal(blob.type, 'text/plain');
  assert.deepEqual(
    progresses.map((p) => p.loaded),
    [6, 11],
  );
  assert.ok(progresses.every((p) => p.total === 11));
});

test('没有 content-length 时 total 为 null，收尾回报终值', async () => {
  const progresses: Array<{ loaded: number; total: number | null }> = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => streamResponse([bytes('abc')], {})) as typeof fetch,
  });

  await client.fetchFileWithProgress('/file-upload/a', {
    onProgress: (loaded, total) => progresses.push({ loaded, total }),
  });

  assert.deepEqual(progresses, [{ loaded: 3, total: null }, { loaded: 3, total: 3 }]);
});

test('响应没有 body 时退化为一次性回报', async () => {
  const progresses: Array<{ loaded: number; total: number | null }> = [];
  const blob = new Blob(['fallback'], { type: 'application/pdf' });
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        body: null,
        blob: async () => blob,
      }) as unknown as Response) as typeof fetch,
  });

  const result = await client.fetchFileWithProgress('/file-upload/a', {
    onProgress: (loaded, total) => progresses.push({ loaded, total }),
  });

  assert.equal(result.size, blob.size);
  assert.deepEqual(progresses, [{ loaded: blob.size, total: blob.size }]);
});

test('上传取消信号透传给 fetch', async () => {
  const controller = new AbortController();
  const signals: Array<AbortSignal | null | undefined> = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).includes('/rooms.media/')) {
        // rooms.media 调用：抓 signal
        signals.push(init.signal ?? null);
        return new Response(JSON.stringify({ file: { _id: 'f1' } }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });

  await client.uploadMedia('room-1', new Blob(['data']), { signal: controller.signal });
  await client.uploadMedia('room-1', new Blob(['data']));
  assert.equal(signals.length, 2);
  assert.equal(signals[0], controller.signal);
  // 未传 signal 时不得伪造 AbortSignal（mock 把 undefined 归一成 null 记录）
  assert.equal(signals[1], null);
});
