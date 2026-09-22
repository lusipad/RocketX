import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RcRestClient } from '../../packages/rc-client/src/rest';
import { RcDownloadInterruptedError } from '../../packages/rc-client/src/files';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const hit = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return hit ? hit[1] : null;
}

/** 先吐若干块，再按 mode 收尾：报错（连接被掐）或干净结束（提前截断） */
function partialResponse(
  chunks: Uint8Array[],
  mode: 'error' | 'end',
  headers: Record<string, string>,
  status = 200,
): Response {
  // 必须按 pull 逐块吐：enqueue 之后立刻 error 会把队列里的块一起丢掉，
  // 那就不是「传到一半被掐断」，而是「一个字节都没到」。
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(chunks[next]);
        next += 1;
        return;
      }
      if (mode === 'error') controller.error(new Error('error decoding response body'));
      else controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

test('html 下载被掐断时按 Range 续传，内容完整（issue #393）', async () => {
  const ranges: Array<string | null> = [];
  const encodings: Array<string | null> = [];
  let call = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (_input: URL | RequestInfo, init?: RequestInit) => {
      ranges.push(headerOf(init, 'range'));
      encodings.push(headerOf(init, 'accept-encoding'));
      call += 1;
      if (call === 1) {
        return partialResponse([bytes('<html>')], 'error', {
          'content-type': 'text/html',
          'content-length': '13',
        });
      }
      return partialResponse([bytes('</html>')], 'end', {
        'content-type': 'text/html',
        'content-range': 'bytes 6-12/13',
      }, 206);
    }) as typeof fetch,
  });

  const blob = await client.fetchFile('/file-upload/a/page.html');

  assert.equal(await blob.text(), '<html></html>');
  assert.equal(blob.type, 'text/html');
  assert.deepEqual(ranges, [null, 'bytes=6-']);
  // 桌面端 reqwest 没开 gzip 特性：站内文件一律要求不压缩，别让代理压出解不开的流
  assert.deepEqual(encodings, ['identity', 'identity']);
});

test('服务端不支持 Range 时整文件重下并丢掉已收前缀（issue #393）', async () => {
  let call = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      call += 1;
      if (call === 1) {
        return partialResponse([bytes('abcd')], 'error', { 'content-length': '8' });
      }
      // 200 而不是 206：整文件重下，客户端必须自己跳过前 4 字节
      return partialResponse([bytes('abcd'), bytes('efgh')], 'end', { 'content-length': '8' });
    }) as typeof fetch,
  });

  const blob = await client.fetchFile('/file-upload/a');

  assert.equal(await blob.text(), 'abcdefgh');
  assert.equal(call, 2);
});

test('content-length 未收满就干净结束也当作中断续传（issue #393）', async () => {
  const progresses: Array<{ loaded: number; total: number | null }> = [];
  let call = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      call += 1;
      // 代理提前收尾：HTTP 层「正常」结束，但只给了 3/6 字节
      if (call === 1) return partialResponse([bytes('abc')], 'end', { 'content-length': '6' });
      return partialResponse([bytes('def')], 'end', { 'content-length': '3' }, 206);
    }) as typeof fetch,
  });

  const blob = await client.fetchFileWithProgress('/file-upload/a', {
    onProgress: (loaded, total) => progresses.push({ loaded, total }),
  });

  assert.equal(await blob.text(), 'abcdef');
  assert.deepEqual(progresses, [
    { loaded: 3, total: 6 },
    { loaded: 6, total: 6 },
  ]);
});

test('长度未知时 416 按「已经传完」收尾，不当成失败（issue #393）', async () => {
  let call = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      call += 1;
      // chunked 响应没有 content-length；断在结尾时续传请求越界，服务端回 416
      if (call === 1) return partialResponse([bytes('done')], 'error', { 'content-type': 'text/html' });
      return new Response(null, { status: 416 });
    }) as typeof fetch,
  });

  const blob = await client.fetchFile('/file-upload/a/page.html');
  assert.equal(await blob.text(), 'done');
  assert.equal(call, 2);
});

test('续传用尽后抛中文可读错误，不把 error decoding response body 糊给用户（issue #393）', async () => {
  let call = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      call += 1;
      return partialResponse([bytes('ab')], 'error', { 'content-length': '99' });
    }) as typeof fetch,
  });

  await assert.rejects(
    client.fetchFile('/file-upload/a/page.html'),
    (err: unknown) => {
      assert.ok(err instanceof RcDownloadInterruptedError);
      assert.match(err.message, /下载中断/);
      assert.match(err.message, /error decoding response body/);
      assert.equal((err as RcDownloadInterruptedError).loaded, 2);
      return true;
    },
  );
  // 首次请求 + 三次续传后才放弃
  assert.equal(call, 4);
});

test('取消下载不触发续传（issue #393）', async () => {
  const controller = new AbortController();
  let call = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      call += 1;
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(streamController) {
          if (!sent) {
            sent = true;
            streamController.enqueue(bytes('ab'));
            return;
          }
          controller.abort();
          streamController.error(new DOMException('下载已取消', 'AbortError'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-length': '99' } });
    }) as typeof fetch,
  });

  await assert.rejects(
    client.fetchFileWithProgress('/file-upload/a', { signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
  assert.equal(call, 1);
});

test('取消后的 done 不触发续传，不把半截内容当完整文件（issue #393）', async () => {
  const controller = new AbortController();
  let call = 0;
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async () => {
      call += 1;
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(streamController) {
          if (!sent) {
            sent = true;
            streamController.enqueue(bytes('ab'));
            return;
          }
          // 取消后底层 read() 正常返回 done：content-length 没收满也不能重新发请求
          controller.abort();
          streamController.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-length': '99' } });
    }) as typeof fetch,
  });

  const blob = await client.fetchFileWithProgress('/file-upload/a', { signal: controller.signal });
  assert.equal(await blob.text(), 'ab');
  assert.equal(call, 1);
});

test('桌面下载走断点续传通道，且 content-length 缺失时 total 不被当成 0（issue #393）', () => {
  const download = readFileSync('apps/web/src/lib/download.ts', 'utf8');
  assert.match(download, /rest\.openFileStream\(path, \{ signal: options\?\.signal \}\)/);
  // Number(null) === 0 会把进度算成 Infinity%，总长度只能由 openFileStream 给出
  assert.doesNotMatch(download, /Number\(response\.headers\.get\('content-length'\)\)/);
});
