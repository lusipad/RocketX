import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BridgeDestroyedError,
  BridgeRpcError,
  BridgeTimeoutError,
  createBridgeClient,
  type BridgeMessageEvent,
} from '../../packages/app-sdk/src/index';
import { createMemoryBackend, createRcxStore } from '../../packages/rcx-store/src/index';

test('rcx-store 隔离应用私有数据并覆盖五类存储', async () => {
  const store = createRcxStore({ backend: createMemoryBackend() });

  await store.apps.set('hello', { manifest: { name: 'Hello' } });
  await store.appData.set('hello', 'token', 'hello-token');
  await store.appData.set('dashboard', 'token', 'dashboard-token');
  await store.appData.set('user@server:hello', 'token', 'scoped-token');
  await store.vectors.set('message-1', [0.2, 0.8]);
  await store.outbox.set('pending-1', { text: 'later' });
  const audit = await store.audit.append({
    appId: 'hello',
    action: 'chat.postMessage',
    allowed: false,
    reason: 'missing chat:write',
  });

  assert.deepEqual(await store.apps.get('hello'), { manifest: { name: 'Hello' } });
  assert.equal(await store.appData.get('hello', 'token'), 'hello-token');
  assert.equal(await store.appData.get('dashboard', 'token'), 'dashboard-token');
  assert.equal(await store.appData.get('user@server:hello', 'token'), 'scoped-token');
  assert.deepEqual(await store.appData.list('hello'), [{ key: 'token', value: 'hello-token' }]);
  assert.deepEqual(await store.vectors.get('message-1'), [0.2, 0.8]);
  assert.deepEqual(await store.outbox.get('pending-1'), { text: 'later' });
  assert.equal(audit.appId, 'hello');
  assert.equal(typeof audit.id, 'string');
  assert.equal(typeof audit.timestamp, 'number');
  assert.deepEqual(await store.audit.list(), [audit]);

  await store.appData.clear('hello');
  assert.equal(await store.appData.get('hello', 'token'), undefined);
  assert.equal(await store.appData.get('dashboard', 'token'), 'dashboard-token');
  await store.appData.clearAllForApp('hello');
  assert.equal(await store.appData.get('user@server:hello', 'token'), undefined);
});

class FakeMessageBus {
  readonly sent: Array<{ message: unknown; origin: string }> = [];
  private listeners = new Set<(event: BridgeMessageEvent) => void>();

  postMessage(message: unknown, origin: string): void {
    this.sent.push({ message, origin });
  }

  addEventListener(_type: 'message', listener: (event: BridgeMessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: BridgeMessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  emit(data: unknown, origin = 'https://host.test'): void {
    for (const listener of this.listeners) listener({ data, origin, source: this });
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

test('app-sdk 使用 JSON-RPC 关联并乱序完成 call 与 requestUI', async () => {
  const bus = new FakeMessageBus();
  const client = createBridgeClient({ target: bus, source: bus, origin: 'https://host.test' });
  const call = client.call<{ id: string }>('chat.postMessage', { text: 'hello' });
  const ui = client.requestUI<boolean>('panel', { appId: 'hello' });

  const callMessage = bus.sent[0]?.message as { id: string };
  const uiMessage = bus.sent[1]?.message as { id: string };
  assert.deepEqual(bus.sent[0], {
    origin: 'https://host.test',
    message: {
      jsonrpc: '2.0',
      id: callMessage.id,
      method: 'rcx/call',
      params: { method: 'chat.postMessage', params: { text: 'hello' } },
    },
  });
  assert.deepEqual(bus.sent[1]?.message, {
    jsonrpc: '2.0',
    id: uiMessage.id,
    method: 'rcx/requestUI',
    params: { kind: 'panel', props: { appId: 'hello' } },
  });

  bus.emit({ jsonrpc: '2.0', id: uiMessage.id, result: true });
  bus.emit({ jsonrpc: '2.0', id: callMessage.id, result: { id: 'message-1' } });
  assert.equal(await ui, true);
  assert.deepEqual(await call, { id: 'message-1' });
  client.destroy();
});

test('app-sdk 订阅事件、拒绝 RPC 错误并在销毁时清理请求', async () => {
  const bus = new FakeMessageBus();
  const client = createBridgeClient({ target: bus, source: bus, origin: 'https://host.test' });
  const events: unknown[] = [];
  const unsubscribe = client.on('room.changed', (payload) => events.push(payload));

  bus.emit({
    jsonrpc: '2.0',
    method: 'rcx/event',
    params: { event: 'room.changed', payload: { rid: 'room-1' } },
  });
  unsubscribe();
  bus.emit({
    jsonrpc: '2.0',
    method: 'rcx/event',
    params: { event: 'room.changed', payload: { rid: 'room-2' } },
  });
  assert.deepEqual(events, [{ rid: 'room-1' }]);

  const failed = client.call('chat.postMessage');
  const failedMessage = bus.sent.at(-1)?.message as { id: string };
  bus.emit({
    jsonrpc: '2.0',
    id: failedMessage.id,
    error: { code: -32001, message: 'permission denied', data: { scope: 'chat:write' } },
  });
  await assert.rejects(failed, (error) => {
    assert.ok(error instanceof BridgeRpcError);
    assert.equal(error.code, -32001);
    return true;
  });

  const pending = client.call('rooms.get');
  client.destroy();
  assert.equal(bus.listenerCount, 0);
  await assert.rejects(pending, BridgeDestroyedError);
  await assert.rejects(client.call('rooms.get'), BridgeDestroyedError);
});

test('app-sdk 超时后拒绝请求', async () => {
  const bus = new FakeMessageBus();
  const client = createBridgeClient({ target: bus, source: bus, timeoutMs: 10 });
  await assert.rejects(client.call('rooms.get'), BridgeTimeoutError);
  client.destroy();
});
