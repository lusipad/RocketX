import test from 'node:test';
import assert from 'node:assert/strict';
import type { RcMessage } from '../../packages/rc-client/src/index';
import { rest } from '../../apps/web/src/lib/client';
import { useChat } from '../../apps/web/src/stores/chat';

const originalSendMessageRaw = rest.sendMessageRaw;
const originalFetchFile = rest.fetchFile;
const originalUploadMedia = rest.uploadMedia;

interface SentMessage {
  rid: string;
  msg?: string;
  attachments?: Array<Record<string, unknown>>;
}

interface Uploaded {
  rid: string;
  size: number;
  fileName?: string;
  msg?: string;
}

function setup() {
  const sent: SentMessage[] = [];
  const fetched: string[] = [];
  const uploaded: Uploaded[] = [];
  rest.sendMessageRaw = (async (message: SentMessage) => {
    sent.push(message);
    return {} as never;
  }) as typeof rest.sendMessageRaw;
  rest.fetchFile = (async (path: string) => {
    fetched.push(path);
    return new Blob(['file-bytes'], { type: 'image/png' });
  }) as typeof rest.fetchFile;
  rest.uploadMedia = (async (rid: string, file: Blob, opts?: { fileName?: string; msg?: string }) => {
    uploaded.push({ rid, size: file.size, fileName: opts?.fileName, msg: opts?.msg });
  }) as typeof rest.uploadMedia;
  return { sent, fetched, uploaded };
}

test.afterEach(() => {
  rest.sendMessageRaw = originalSendMessageRaw;
  rest.fetchFile = originalFetchFile;
  rest.uploadMedia = originalUploadMedia;
});

function imageMessage(overrides: Partial<RcMessage> = {}): RcMessage {
  return {
    _id: 'm1',
    rid: 'source-room',
    msg: '看这张图',
    ts: '2026-07-17T00:00:00.000Z',
    u: { _id: 'u1', username: 'alice' },
    attachments: [
      {
        title: '截图.png',
        image_url: '/file-upload/abc/%E6%88%AA%E5%9B%BE.png',
        title_link: '/file-upload/abc/%E6%88%AA%E5%9B%BE.png',
      },
    ],
    ...overrides,
  };
}

test('跨会话转发图片：下载原文件重传，文字作为说明，仍是一条消息（issue #69）', async () => {
  const { sent, fetched, uploaded } = setup();

  await useChat.getState().forwardMessage(imageMessage(), ['target-room']);

  assert.deepEqual(fetched, ['/file-upload/abc/%E6%88%AA%E5%9B%BE.png']);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].rid, 'target-room');
  assert.equal(uploaded[0].fileName, '截图.png');
  assert.equal(uploaded[0].msg, '看这张图');
  // 单文件 + 文字合成一条上传消息，不再发出带「请在原会话查看」提示的附件消息
  assert.deepEqual(sent, []);
});

test('转发回原会话不重传，保留原文件链接', async () => {
  const { sent, fetched, uploaded } = setup();

  await useChat.getState().forwardMessage(imageMessage(), ['source-room']);

  assert.deepEqual(fetched, []);
  assert.deepEqual(uploaded, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachments?.[0]?.image_url, '/file-upload/abc/%E6%88%AA%E5%9B%BE.png');
});

test('文件下载失败时退回附件元数据和查看提示，转发不整体失败', async () => {
  const { sent, uploaded } = setup();
  rest.fetchFile = (async () => {
    throw new Error('download failed');
  }) as typeof rest.fetchFile;

  await useChat.getState().forwardMessage(imageMessage(), ['target-room']);

  assert.deepEqual(uploaded, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg, '看这张图');
  const attachment = sent[0].attachments?.[0] as { text?: string; image_url?: string };
  assert.ok(attachment?.text?.includes('请在原会话查看'));
  assert.equal(attachment?.image_url, undefined);
});

test('受保护文件之外的附件先随文字发出，再逐个重传文件', async () => {
  const { sent, uploaded } = setup();
  const msg = imageMessage({
    attachments: [
      { title: '外链卡片', text: '公开链接', title_link: 'https://example.com/page' },
      { title: '截图.png', image_url: '/file-upload/abc/img.png' },
    ],
  });

  await useChat.getState().forwardMessage(msg, ['target-room']);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg, '看这张图');
  assert.equal(sent[0].attachments?.length, 1);
  assert.equal(sent[0].attachments?.[0]?.title, '外链卡片');
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].msg, '');
  assert.equal(uploaded[0].fileName, '截图.png');
});

test('多选逐条转发跨会话时同样重传文件', async () => {
  const { sent, uploaded } = setup();
  const first = imageMessage({ _id: 'm1', ts: '2026-07-17T00:00:00.000Z' });
  const second = imageMessage({
    _id: 'm2',
    ts: '2026-07-17T00:01:00.000Z',
    msg: '纯文字',
    attachments: [],
  });

  await useChat.getState().forwardMessages([second, first], ['target-room'], false);

  // 按时间正序：先图片消息（重传），后纯文字消息
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].msg, '看这张图');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg, '纯文字');
});
