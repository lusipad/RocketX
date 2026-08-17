import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import { RcApiError } from '../../packages/rc-client/src/index';
import { rest } from '../../apps/web/src/lib/client';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useChat } from '../../apps/web/src/stores/chat';
import { useToast } from '../../apps/web/src/stores/toast';

const originalSendMessageRaw = rest.sendMessageRaw;
const originalGetReadReceipts = rest.getReadReceipts;
const originalGetMessage = rest.getMessage;

const rid = 'send-room';
const clientId = 'ABCDEFGHJKLMNPQRS';

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
    ts: new Date('2026-07-31T00:00:00.000Z').toISOString(),
    u: { _id: 'me', username: 'me', name: 'Me' },
  };
}

test.afterEach(() => {
  rest.sendMessageRaw = originalSendMessageRaw;
  rest.getReadReceipts = originalGetReadReceipts;
  rest.getMessage = originalGetMessage;
  useAuth.setState({ status: 'guest', user: null, error: null });
  useChat.setState({ activeRid: null, messages: {}, rooms: {}, subscriptions: {}, scrollNonce: 0 });
  useToast.setState({ toasts: [] });
});

test('send 使用显式 clientId 并返回可判定结果', async () => {
  reset();
  const payloads: Array<{ _id: string; rid: string; msg: string }> = [];
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async (payload) => {
    payloads.push(payload);
    return sentMessage(payload._id, payload.msg);
  }) as typeof rest.sendMessageRaw;

  const result = await useChat.getState().send('第一条', { rid, clientId });

  assert.deepEqual(result, { id: clientId, delivery: 'server' });
  assert.deepEqual(payloads.map((payload) => payload._id), [clientId]);
  assert.equal(useChat.getState().messages[rid]?.length, 1);
  assert.equal(useChat.getState().messages[rid]?.[0]?._id, clientId);
});

test('同一 clientId 重试不会在本地生成重复消息', async () => {
  reset();
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async (payload) => sentMessage(payload._id, payload.msg)) as typeof rest.sendMessageRaw;

  const first = await useChat.getState().send('同一条消息', { rid, clientId });
  const second = await useChat.getState().send('同一条消息', { rid, clientId });
  const messages = useChat.getState().messages[rid] ?? [];

  assert.deepEqual(first, { id: clientId, delivery: 'server' });
  assert.deepEqual(second, { id: clientId, delivery: 'server' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?._id, clientId);
  assert.equal(messages[0]?.msg, '同一条消息');
});

test('sendMessageRaw 报错但按 clientId 回查成功时仍视为 server 且不重复上屏', async () => {
  reset();
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async () => {
    throw new RcApiError('server unavailable', 503);
  }) as typeof rest.sendMessageRaw;
  rest.getMessage = (async (id) => sentMessage(id, '回查成功')) as typeof rest.getMessage;

  const result = await useChat.getState().send('回查成功', { rid, clientId });
  const messages = useChat.getState().messages[rid] ?? [];

  assert.deepEqual(result, { id: clientId, delivery: 'server' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?._id, clientId);
  assert.equal(messages[0]?.msg, '回查成功');
});

test('明确 4xx 拒绝时返回 failed', async () => {
  reset();
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async () => {
    throw new RcApiError('Forbidden', 403);
  }) as typeof rest.sendMessageRaw;

  const result = await useChat.getState().send('被拒绝', { rid, clientId });
  const messages = useChat.getState().messages[rid] ?? [];

  assert.deepEqual(result, { id: clientId, delivery: 'failed', reason: 'Forbidden' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.failed, true);
});

test('网络或 5xx 且回查失败时返回 unknown', async () => {
  reset();
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async () => {
    throw new RcApiError('Gateway Timeout', 504);
  }) as typeof rest.sendMessageRaw;
  rest.getMessage = (async () => {
    throw new RcApiError('Not Found', 404);
  }) as typeof rest.getMessage;

  const result = await useChat.getState().send('暂时无法确认', { rid, clientId });
  const messages = useChat.getState().messages[rid] ?? [];

  assert.deepEqual(result, {
    id: clientId,
    delivery: 'unknown',
    reason: '发送结果暂时无法确认，请检查原会话后重试',
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.failed, true);
});

test('同一 clientId 回查到不同正文时 fail closed', async () => {
  reset();
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async () => {
    throw new RcApiError('server unavailable', 503);
  }) as typeof rest.sendMessageRaw;
  rest.getMessage = (async (id) => sentMessage(id, '旧正文')) as typeof rest.getMessage;

  const result = await useChat.getState().send('新正文', { rid, clientId });
  const messages = useChat.getState().messages[rid] ?? [];

  assert.deepEqual(result, {
    id: clientId,
    delivery: 'failed',
    reason: '原会话里同一消息 ID 已存在不同内容，请检查原会话后重试',
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.msg, '新正文');
  assert.equal(messages[0]?.failed, true);
});

test('显式非法 clientId 时 fail closed，不回退随机 ID', async () => {
  reset();
  const result = await useChat.getState().send('拒绝发送', { rid, clientId: 'bad-id' });

  assert.deepEqual(result, {
    id: 'bad-id',
    delivery: 'failed',
    reason: '消息 ID 无效，已拒绝发送',
  });
  assert.equal(useChat.getState().messages[rid], undefined);
});

test('WS 抢先落库但正文不一致时 fail closed，不误判 server', async () => {
  reset();
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async () => {
    useChat.setState({
      messages: { [rid]: [sentMessage(clientId, '其他正文')] },
    });
    throw new RcApiError('server unavailable', 503);
  }) as typeof rest.sendMessageRaw;
  rest.getMessage = (async () => {
    throw new RcApiError('Not Found', 404);
  }) as typeof rest.getMessage;

  const result = await useChat.getState().send('本次正文', { rid, clientId });

  assert.deepEqual(result, {
    id: clientId,
    delivery: 'failed',
    reason: '原会话里同一消息 ID 已存在不同内容，请检查原会话后重试',
  });
});

test('显式 clientId 的 failed 或 unknown toast 不提供普通重试动作', async () => {
  reset();
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async () => {
    throw new RcApiError('Forbidden', 403);
  }) as typeof rest.sendMessageRaw;

  await useChat.getState().send('不给重试按钮', { rid, clientId });

  const lastToast = useToast.getState().toasts.at(-1);
  assert.equal(lastToast?.message, 'Forbidden');
  assert.equal(lastToast?.action, undefined);
});

test('preserveWhitespace=true 时 optimistic message 与 sendMessageRaw payload 都保留前导缩进', async () => {
  reset();
  const payloads: Array<{ _id: string; rid: string; msg: string }> = [];
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async (payload) => {
    payloads.push(payload);
    return sentMessage(payload._id, payload.msg);
  }) as typeof rest.sendMessageRaw;

  const text = '  - nested item';
  const result = await useChat.getState().send(text, { rid, clientId, preserveWhitespace: true });

  assert.deepEqual(result, { id: clientId, delivery: 'server' });
  assert.deepEqual(payloads.map((payload) => payload.msg), [text]);
  assert.equal(useChat.getState().messages[rid]?.[0]?.msg, text);
});

test('preserveWhitespace=true 但正文纯空白时仍拒绝发送', async () => {
  reset();
  const payloads: Array<{ _id: string; rid: string; msg: string }> = [];
  rest.getReadReceipts = (async () => []) as typeof rest.getReadReceipts;
  rest.sendMessageRaw = (async (payload) => {
    payloads.push(payload);
    return sentMessage(payload._id, payload.msg);
  }) as typeof rest.sendMessageRaw;

  const result = await useChat.getState().send('   \n\t', { rid, clientId, preserveWhitespace: true });

  assert.equal(result, undefined);
  assert.deepEqual(payloads, []);
  assert.equal(useChat.getState().messages[rid], undefined);
});
