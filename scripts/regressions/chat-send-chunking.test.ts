import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import { RcApiError } from '../../packages/rc-client/src/index';
import { rest } from '../../apps/web/src/lib/client';
import { useAuth } from '../../apps/web/src/stores/auth';
import { setChatMessageSizeProviderForTests, useChat } from '../../apps/web/src/stores/chat';
import { useToast } from '../../apps/web/src/stores/toast';

const originalSendMessageRaw = rest.sendMessageRaw;
const originalGetMessage = rest.getMessage;
const originalGetReadReceipts = rest.getReadReceipts;

const rid = 'chunk-room';
const clientId = 'ABCDEFGHJKLMNPQRS';
const MESSAGE_ID_RE = /^[23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz]{17}$/;

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
    subscriptions: {},
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
  rest.getMessage = originalGetMessage;
  rest.getReadReceipts = originalGetReadReceipts;
  useAuth.setState({ status: 'guest', user: null, error: null });
  useChat.setState({ activeRid: null, messages: {}, rooms: {}, subscriptions: {}, scrollNonce: 0 });
  useToast.setState({ toasts: [] });
});

test('未超限时仍走单段路径，行为不变', async () => {
  reset();
  const restore = setChatMessageSizeProviderForTests(async () => 5000);
  try {
    const payloads: Array<{ _id: string; rid: string; msg: string }> = [];
    rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
    rest.sendMessageRaw = (async (payload) => {
      payloads.push(payload);
      return sentMessage(payload._id, payload.msg);
    }) as typeof rest.sendMessageRaw;

    const result = await useChat.getState().send('短短一条', { rid, clientId });

    assert.deepEqual(result, { id: clientId, delivery: 'server' });
    assert.deepEqual(payloads.map((payload) => payload.msg), ['短短一条']);
    assert.equal(payloads[0]?._id, clientId);
    assert.equal(useChat.getState().messages[rid]?.length, 1);
  } finally {
    restore();
  }
});

test('超长时按上限拆分，后续段各自新 id 顺序发送且 tmid 透传', async () => {
  reset();
  const restore = setChatMessageSizeProviderForTests(async () => 10);
  try {
    const payloads: Array<{ _id: string; rid: string; msg: string; tmid?: string }> = [];
    rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
    rest.sendMessageRaw = (async (payload) => {
      payloads.push(payload);
      return sentMessage(payload._id, payload.msg);
    }) as typeof rest.sendMessageRaw;

    const result = await useChat.getState().send('aaaa bbbb cccc dddd eeee', {
      rid,
      clientId,
      tmid: 'thread-1',
    });

    assert.deepEqual(result, { id: clientId, delivery: 'server' });
    assert.deepEqual(payloads.map((payload) => payload.msg), ['aaaa bbbb ', 'cccc dddd ', 'eeee']);
    assert.equal(payloads[0]?._id, clientId);
    for (const payload of payloads.slice(1)) {
      assert.match(payload._id, MESSAGE_ID_RE);
      assert.notEqual(payload._id, clientId);
    }
    assert.equal(new Set(payloads.map((payload) => payload._id)).size, 3);
    assert.equal(payloads.every((payload) => payload.tmid === 'thread-1'), true);
    const messages = useChat.getState().messages[rid] ?? [];
    assert.equal(messages.length, 3);
    assert.deepEqual(messages.map((message) => message.msg), ['aaaa bbbb ', 'cccc dddd ', 'eeee']);
  } finally {
    restore();
  }
});

test('多段发送时第一段保留乐观上屏', async () => {
  reset();
  const restore = setChatMessageSizeProviderForTests(async () => 10);
  try {
    let optimisticSeen: RcMessage | undefined;
    const payloads: Array<{ _id: string; rid: string; msg: string }> = [];
    rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
    rest.sendMessageRaw = (async (payload) => {
      if (payloads.length === 0) {
        optimisticSeen = (useChat.getState().messages[rid] ?? []).find(
          (message) => message._id === payload._id,
        );
      }
      payloads.push(payload);
      return sentMessage(payload._id, payload.msg);
    }) as typeof rest.sendMessageRaw;

    const result = await useChat.getState().send('aaaa bbbb cccc', { rid, clientId });

    assert.deepEqual(result, { id: clientId, delivery: 'server' });
    assert.equal(payloads.length, 2);
    assert.equal(optimisticSeen?._id, clientId);
    assert.equal(optimisticSeen?.msg, 'aaaa bbbb ');
    assert.equal(optimisticSeen?.pending, true);
  } finally {
    restore();
  }
});

test('分段中途失败即停止后续段并提示，已发出的第一段保持成功态', async () => {
  reset();
  const restore = setChatMessageSizeProviderForTests(async () => 10);
  try {
    const payloads: Array<{ _id: string; rid: string; msg: string }> = [];
    rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
    rest.sendMessageRaw = (async (payload) => {
      payloads.push(payload);
      if (payloads.length === 2) throw new RcApiError('Forbidden', 403);
      return sentMessage(payload._id, payload.msg);
    }) as typeof rest.sendMessageRaw;

    const result = await useChat.getState().send('aaaa bbbb cccc dddd eeee', { rid, clientId });

    assert.equal(payloads.length, 2);
    assert.equal(result?.id, clientId);
    assert.equal(result?.delivery, 'failed');
    assert.match(result?.reason ?? '', /第 2\/3 段失败/);
    const messages = useChat.getState().messages[rid] ?? [];
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?._id, clientId);
    assert.equal(messages[0]?.failed, undefined);
    const lastToast = useToast.getState().toasts.at(-1);
    assert.equal(lastToast?.kind, 'error');
    assert.match(lastToast?.message ?? '', /第 2\/3 段失败/);
  } finally {
    restore();
  }
});

test('第一段结果不确定但已回查落库时，仍继续发送剩余分段', async () => {
  reset();
  const restore = setChatMessageSizeProviderForTests(async () => 10);
  try {
    const payloads: Array<{ _id: string; rid: string; msg: string }> = [];
    rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
    rest.sendMessageRaw = (async (payload) => {
      payloads.push(payload);
      if (payloads.length === 1) throw new RcApiError('Server Error', 500);
      return sentMessage(payload._id, payload.msg);
    }) as typeof rest.sendMessageRaw;
    rest.getMessage = (async (messageId) => {
      assert.equal(messageId, clientId);
      return sentMessage(clientId, payloads[0]?.msg ?? '');
    }) as typeof rest.getMessage;

    const result = await useChat.getState().send('aaaa bbbb cccc dddd eeee', { rid, clientId });

    assert.deepEqual(result, { id: clientId, delivery: 'server' });
    assert.deepEqual(payloads.map((payload) => payload.msg), ['aaaa bbbb ', 'cccc dddd ', 'eeee']);
    assert.equal((useChat.getState().messages[rid] ?? []).length, 3);
  } finally {
    restore();
  }
});

test('引用前缀拆分后只落在第一段', async () => {
  reset();
  useChat.setState({
    subscriptions: { [rid]: { rid, t: 'c', name: 'general' } as never },
  });
  const restore = setChatMessageSizeProviderForTests(async () => 50);
  try {
    const payloads: Array<{ _id: string; rid: string; msg: string }> = [];
    rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
    rest.sendMessageRaw = (async (payload) => {
      payloads.push(payload);
      return sentMessage(payload._id, payload.msg);
    }) as typeof rest.sendMessageRaw;
    const quoted = sentMessage('quoted-message-id', '被引用的消息');

    const result = await useChat.getState().send('bbbb cccc dddd', { rid, clientId, quote: quoted });

    assert.deepEqual(result, { id: clientId, delivery: 'server' });
    assert.equal(payloads.length > 1, true);
    assert.equal(payloads[0]?.msg.startsWith('[ ](/channel/general?msg=quoted-message-id) '), true);
    for (const payload of payloads.slice(1)) {
      assert.equal(payload.msg.includes('?msg='), false);
    }
  } finally {
    restore();
  }
});
