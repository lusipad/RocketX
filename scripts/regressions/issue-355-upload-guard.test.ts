import test from 'node:test';
import assert from 'node:assert/strict';
import { RcApiError, RcRestClient } from '../../packages/rc-client/src/index';
import { rest } from '../../apps/web/src/lib/client';
import {
  setUploadSizeLimitProviderForTests,
  useChat,
} from '../../apps/web/src/stores/chat';
import { humanError, useToast } from '../../apps/web/src/stores/toast';

const originalUploadMedia = rest.uploadMedia;
const rid = 'upload-room';
const MIB = 1024 * 1024;

/** 构造带 name 的 Blob（Node 里 File 未必可用，uploadFiles 只读 name/size） */
function namedFile(name: string, size: number): File {
  return Object.assign(new Blob([new Uint8Array(size)]), { name }) as File;
}

function reset(limit: unknown) {
  useChat.setState({ activeRid: rid, replyTo: null, uploading: 0 });
  useToast.setState({ toasts: [] });
  return setUploadSizeLimitProviderForTests(async () => limit);
}

test.afterEach(() => {
  rest.uploadMedia = originalUploadMedia;
  useChat.setState({ activeRid: null, replyTo: null, uploading: 0 });
  useToast.setState({ toasts: [] });
});

test('上传预检：超过服务器上限的文件直接拦截，不发请求（issue #355）', async () => {
  const restore = reset(10 * MIB);
  try {
    let uploads = 0;
    rest.uploadMedia = (async () => {
      uploads += 1;
    }) as typeof rest.uploadMedia;

    const ok = await useChat.getState().uploadFiles([namedFile('big.bin', 11 * MIB)]);

    assert.equal(ok, false);
    assert.equal(uploads, 0);
    const errorToast = useToast.getState().toasts.find((t) => t.kind === 'error');
    assert.ok(errorToast?.message.includes('超过服务器文件大小上限 10 MB'));
  } finally {
    restore();
  }
});

test('上传预检：多文件里有一个超限就整体不发，并指出具体文件（issue #355）', async () => {
  const restore = reset(5 * MIB);
  try {
    let uploads = 0;
    rest.uploadMedia = (async () => {
      uploads += 1;
    }) as typeof rest.uploadMedia;

    const ok = await useChat
      .getState()
      .uploadFiles([namedFile('small.txt', 100), namedFile('huge.zip', 6 * MIB)]);

    assert.equal(ok, false);
    assert.equal(uploads, 0);
    const errorToast = useToast.getState().toasts.find((t) => t.kind === 'error');
    assert.ok(errorToast?.message.includes('huge.zip'));
    // 预检失败不吞掉输入区挂着的引用草稿
    assert.equal(useChat.getState().replyTo, null);
  } finally {
    restore();
  }
});

test('上传预检：未超限时照常发送（issue #355）', async () => {
  const restore = reset(10 * MIB);
  try {
    const uploaded: string[] = [];
    rest.uploadMedia = (async (_rid: string, file: Blob, opts?: { fileName?: string }) => {
      uploaded.push(opts?.fileName ?? (file as File).name);
    }) as typeof rest.uploadMedia;

    const ok = await useChat.getState().uploadFiles([namedFile('a.txt', 100)]);

    assert.equal(ok, true);
    assert.deepEqual(uploaded, ['a.txt']);
  } finally {
    restore();
  }
});

test('上传预检：读不到上限设置（返回 0）时不拦截（issue #355）', async () => {
  const restore = reset(0);
  try {
    let uploads = 0;
    rest.uploadMedia = (async () => {
      uploads += 1;
    }) as typeof rest.uploadMedia;

    const ok = await useChat.getState().uploadFiles([namedFile('big.bin', 500 * MIB)]);

    assert.equal(ok, true);
    assert.equal(uploads, 1);
  } finally {
    restore();
  }
});

test('humanError：服务端文件超限错误给出明确提示而不是笼统「发送失败」（issue #355）', () => {
  assert.equal(
    humanError(new RcApiError('File too large', 413, 'error-file-too-large'), '发送 big.bin 失败'),
    '文件超过服务器允许的大小上限，请压缩或拆分后再发',
  );
  // 只有 413 状态、没有 errorType 时同样识别
  assert.equal(
    humanError(new RcApiError('HTTP 413', 413), '发送失败'),
    '文件超过服务器允许的大小上限，请压缩或拆分后再发',
  );
});

test('上传失败 toast：服务端 413 透传为明确上限提示（issue #355）', async () => {
  const restore = reset(0);
  try {
    rest.uploadMedia = (async () => {
      throw new RcApiError('File too large', 413, 'error-file-too-large');
    }) as typeof rest.uploadMedia;

    const ok = await useChat.getState().uploadFiles([namedFile('big.bin', 100)]);

    assert.equal(ok, false);
    const errorToast = useToast.getState().toasts.find((t) => t.kind === 'error');
    assert.equal(errorToast?.message, '文件超过服务器允许的大小上限，请压缩或拆分后再发');
  } finally {
    restore();
  }
});

test('uploadMedia：multipart 体拼成 Blob 零拷贝，不再整段 arrayBuffer（issue #355）', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new RcRestClient({
    baseUrl: 'https://rc.example.com',
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      const body = url.toString().includes('rooms.media/')
        ? { file: { _id: 'f1' } }
        : { success: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch,
  });
  const blob = new Blob(['payload-bytes'], { type: 'text/plain' });
  let arrayBufferCalls = 0;
  const originalArrayBuffer = blob.arrayBuffer.bind(blob);
  (blob as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => {
    arrayBufferCalls += 1;
    return originalArrayBuffer();
  };

  await client.uploadMedia(rid, blob, { fileName: '报告.txt', msg: '看下' });

  const uploadCall = calls.find((c) => c.url.includes(`/api/v1/rooms.media/${rid}`));
  assert.ok(uploadCall);
  // body 是 Blob 而不是物化的 Uint8Array
  assert.ok(uploadCall.init?.body instanceof Blob);
  // 源文件没有被整体读进内存
  assert.equal(arrayBufferCalls, 0);
  // multipart 内容不变：头 + 文件字节 + 尾
  const text = await (uploadCall.init!.body as Blob).text();
  const contentType = (uploadCall.init!.headers as Record<string, string>)['Content-Type'];
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  assert.ok(boundary);
  assert.ok(text.includes(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="报告.txt"`));
  assert.ok(text.includes('payload-bytes'));
  assert.ok(text.endsWith(`\r\n--${boundary}--\r\n`));
  // 两段式确认请求照常发出
  assert.ok(calls.some((c) => c.url.includes(`rooms.mediaConfirm/${rid}/f1`)));
});

test('uploadMedia：服务端返回 error-file-too-large 时 errorType 透传到 RcApiError（issue #355）', async () => {
  const client = new RcRestClient({
    baseUrl: 'https://rc.example.com',
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ success: false, error: 'File too large', errorType: 'error-file-too-large' }),
        { status: 413 },
      )) as typeof fetch,
  });

  const error = await client
    .uploadMedia(rid, new Blob(['x']), { fileName: 'x.bin' })
    .then(
      () => null,
      (err: unknown) => err,
    );

  assert.ok(error instanceof RcApiError);
  assert.equal((error as RcApiError).status, 413);
  assert.equal((error as RcApiError).errorType, 'error-file-too-large');
});
