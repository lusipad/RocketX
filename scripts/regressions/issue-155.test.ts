import assert from 'node:assert/strict';
import test from 'node:test';
import { rest } from '../../apps/web/src/lib/client';
import { useChat } from '../../apps/web/src/stores/chat';

const originalUploadMedia = rest.uploadMedia;

test.afterEach(() => {
  rest.uploadMedia = originalUploadMedia;
  useChat.setState({
    activeRid: null,
    pendingFiles: null,
    pendingUploadMessage: null,
    replyTo: null,
    uploading: 0,
  });
});

test('文字与图片一起发送时，正文跟随第一张图片且只发送一次（issue #155）', async () => {
  const uploaded: Array<{ name: string; msg?: string }> = [];
  rest.uploadMedia = (async (_rid: string, file: Blob, opts?: { msg?: string }) => {
    uploaded.push({ name: (file as File).name, msg: opts?.msg });
  }) as typeof rest.uploadMedia;
  useChat.setState({ activeRid: 'room-1', uploading: 0, replyTo: null });

  const sent = await useChat.getState().uploadFiles(
    [
      new File(['first'], 'first.png', { type: 'image/png' }),
      new File(['second'], 'second.png', { type: 'image/png' }),
    ],
    undefined,
    '图片说明',
  );

  assert.equal(sent, true);
  assert.deepEqual(uploaded, [
    { name: 'first.png', msg: '图片说明' },
    { name: 'second.png', msg: undefined },
  ]);
});
