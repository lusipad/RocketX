import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import { rest } from '../../apps/web/src/lib/client';
import { postBridgeMessage } from '../../apps/web/src/kernel/postMessage';
import { useAuth } from '../../apps/web/src/stores/auth';
import { setChatMessageSizeProviderForTests, useChat } from '../../apps/web/src/stores/chat';
import { useToast } from '../../apps/web/src/stores/toast';

const originalSendMessageRaw = rest.sendMessageRaw;
const originalGetReadReceipts = rest.getReadReceipts;

const rid = 'bridge-room';

function reset() {
  useAuth.setState({
    status: 'authed',
    user: { _id: 'me', username: 'me', name: 'Me' },
    error: null,
  });
  useChat.setState({
    activeRid: rid,
    messages: {},
    rooms: { [rid]: { _id: rid, t: 'c' } as never },
    subscriptions: { [rid]: { rid, t: 'c', name: 'bridge' } as never },
    scrollNonce: 0,
  });
}

function sentMessage(id: string, text: string): RcMessage {
  return {
    _id: id,
    rid,
    msg: text,
    ts: new Date('2026-08-18T00:00:00.000Z').toISOString(),
    u: { _id: 'me', username: 'me', name: 'Me' },
  };
}

test.afterEach(() => {
  rest.sendMessageRaw = originalSendMessageRaw;
  rest.getReadReceipts = originalGetReadReceipts;
  useAuth.setState({ status: 'guest', user: null, error: null });
  useChat.setState({ activeRid: null, messages: {}, rooms: {}, subscriptions: {}, scrollNonce: 0 });
  useToast.setState({ toasts: [] });
});

test('空文本仍报错，未加入的会话仍拒绝', async () => {
  reset();
  await assert.rejects(() => postBridgeMessage(rid, '   '), /消息不能为空/);
  await assert.rejects(() => postBridgeMessage('no-such-room', 'hi'), /只能向已加入的会话/);
});

test('超过固定 20k 上限的长文本不再整条拒绝，按 Message_MaxAllowedSize 拆分顺序发送', async () => {
  reset();
  const restore = setChatMessageSizeProviderForTests(async () => 5000);
  try {
    const payloads: Array<{ _id: string; rid: string; msg: string }> = [];
    rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
    rest.sendMessageRaw = (async (payload) => {
      payloads.push(payload);
      return sentMessage(payload._id, payload.msg);
    }) as typeof rest.sendMessageRaw;

    // 21000+ 字符：旧的固定 20_000 上限会直接抛「消息为空或过长」
    const text = '长'.repeat(21_000);
    const result = await postBridgeMessage(rid, text);

    assert.deepEqual(result, { ok: true });
    assert.equal(payloads.length >= 5, true);
    for (const payload of payloads) {
      assert.equal(payload.msg.length <= 5000, true);
    }
    assert.equal(payloads.map((payload) => payload.msg).join(''), text);
  } finally {
    restore();
  }
});

test('不超长时仍走单段发送，tmid 透传', async () => {
  reset();
  const restore = setChatMessageSizeProviderForTests(async () => 5000);
  try {
    const payloads: Array<{ _id: string; rid: string; msg: string; tmid?: string }> = [];
    rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
    rest.sendMessageRaw = (async (payload) => {
      payloads.push(payload);
      return sentMessage(payload._id, payload.msg);
    }) as typeof rest.sendMessageRaw;

    const result = await postBridgeMessage(rid, '短短一条', 'thread-9');

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(payloads.map((payload) => payload.msg), ['短短一条']);
    assert.equal(payloads[0]?.tmid, 'thread-9');
  } finally {
    restore();
  }
});
