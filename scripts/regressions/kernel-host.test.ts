import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHostCapabilities, isCurrentServerFilePath } from '../../apps/web/src/kernel/capabilities/host';
import { CapabilityBus } from '../../apps/web/src/kernel/capabilities/bus';
import { parseManifest } from '../../apps/web/src/kernel/manifest';
import { PermissionGate } from '../../apps/web/src/kernel/permission';
import type { KernelHost } from '../../apps/web/src/kernel/host';

const appId = 'com.example.host-contract';
const manifest = parseManifest({
  id: appId,
  version: '1.0.0',
  name: 'Host contract test',
  publisher: 'Example',
  runtime: 'iframe',
  entry: './index.html',
  permissions: [
    'chat:read',
    'chat:history',
    'chat:write',
    'rooms:list',
    'users:read',
    'files:read',
    'lan:discover',
    'lan:transfer',
  ],
});

function context() {
  return { appId, manifest };
}

function host(overrides: Partial<KernelHost> = {}): KernelHost {
  const state = {
    rid: 'room-1',
    sent: [] as Array<{ rid: string; text: string; tmid?: string }>,
    fileReads: [] as string[],
    lanSends: [] as Array<{ userId: string; roomId: string; text: string }>,
  };
  const base: KernelHost = {
    identity: { userId: () => 'user-1' },
    chat: {
      current: () => ({ rid: state.rid, messages: [{ _id: 'm1', rid: state.rid!, msg: 'hello' } as never] }),
      history: () => [{ _id: 'old', rid: 'room-1', msg: 'old' } as never],
      postMessage: async (rid, text, tmid) => {
        state.sent.push({ rid, text, ...(tmid ? { tmid } : {}) });
        return { ok: true };
      },
    },
    rooms: {
      list: () => [{ rid: 'room-1', name: 'Room 1', type: 'c', unread: 2 }],
      isMember: (rid) => rid === 'room-1',
      typeOf: (rid) => (rid === 'room-1' ? 'c' : null),
      memberIds: (rid) => (rid === 'room-1' ? ['user-2'] : []),
    },
    users: {
      read: () => [{ _id: 'user-2', username: 'two', name: 'Two', status: 'online' }],
    },
    files: {
      list: async () => [],
      read: async (path) => {
        state.fileReads.push(path);
        return new Blob(['ok'], { type: 'text/plain' });
      },
    },
    lan: {
      listPeers: () => [{
        userId: 'user-2',
        deviceId: 'device-2',
        deviceName: 'Laptop',
        trusted: true,
        source: 'mdns',
        lastSeenMs: 1,
      }],
      sendChat: async (userId, message) => {
        state.lanSends.push({ userId, roomId: message.roomId, text: message.text });
      },
    },
    navigation: {
      currentModule: () => 'messages',
      setModule: () => undefined,
      currentPanel: () => null,
      setPanel: () => undefined,
    },
    events: { subscribeChat: () => () => undefined },
    workbench: { useConnected: () => false },
  };
  return {
    ...base,
    ...overrides,
    chat: { ...base.chat, ...overrides.chat },
    rooms: { ...base.rooms, ...overrides.rooms },
    users: { ...base.users, ...overrides.users },
    files: { ...base.files, ...overrides.files },
    lan: { ...base.lan, ...overrides.lan },
    navigation: { ...base.navigation, ...overrides.navigation },
    events: { ...base.events, ...overrides.events },
    workbench: { ...base.workbench, ...overrides.workbench },
  };
}

test('注入 Host 后仍先校验权限，并拒绝未加入房间的历史和发送', async () => {
  const target = host({
    rooms: {
      list: () => [],
      isMember: () => false,
      typeOf: () => null,
      memberIds: () => [],
    },
  });
  const gate = new PermissionGate();
  const bus = new CapabilityBus(gate);
  gate.setGrant({ appId, granted: ['chat:history', 'chat:write'] });
  registerHostCapabilities(bus, target);
  await assert.rejects(() => bus.call('chat.history', { rid: 'other-room' }, context()), /无权读取/);
  await assert.rejects(() => bus.call('chat.postMessage', { rid: 'other-room', text: 'hi' }, context()), /只能向已加入/);
  await assert.rejects(
    () => bus.call('chat.current', undefined, context()),
    /未获得 chat:read/,
  );
});

test('Host capability 保留消息快照、房间列表、用户和发送参数', async () => {
  const target = host();
  const gate = new PermissionGate();
  const bus = new CapabilityBus(gate);
  gate.setGrant({ appId, granted: [...manifest.permissions] });
  registerHostCapabilities(bus, target);
  const current = await bus.call('chat.current', undefined, context()) as { messages: unknown[] };
  assert.equal(current.messages.length, 1);
  const history = await bus.call('chat.history', { rid: 'room-1', count: 1 }, context()) as unknown[];
  assert.equal(history.length, 1);
  assert.deepEqual(await bus.call('rooms.list', undefined, context()), [
    { rid: 'room-1', name: 'Room 1', type: 'c', unread: 2 },
  ]);
  assert.deepEqual(await bus.call('users.read', undefined, context()), [
    { _id: 'user-2', username: 'two', name: 'Two', status: 'online' },
  ]);
  assert.deepEqual(
    await bus.call('chat.postMessage', { rid: 'room-1', text: 'hi', tmid: 'thread-1' }, context()),
    { ok: true },
  );
});

test('文件读取只允许当前服务器路径并保留 10 MB 上限', async () => {
  assert.equal(isCurrentServerFilePath('/file-upload/a', 'https://rc.example'), true);
  assert.equal(isCurrentServerFilePath('https://rc.example/file-upload/a', 'https://rc.example'), true);
  assert.equal(isCurrentServerFilePath('https://evil.example/file-upload/a', 'https://rc.example'), false);

  const target = host();
  const gate = new PermissionGate();
  const bus = new CapabilityBus(gate);
  gate.setGrant({ appId, granted: ['files:read'] });
  registerHostCapabilities(bus, target, { serverBase: () => 'https://rc.example' });
  await assert.rejects(
    () => bus.call('files.read', { path: 'https://evil.example/file-upload/a' }, context()),
    /当前 Rocket\.Chat 服务器/,
  );
  const small = await bus.call('files.read', { path: '/file-upload/a' }, context()) as { size: number; base64: string };
  assert.equal(small.size, 2);
  assert.equal(small.base64, 'b2s=');

  const oversized = host({ files: {
    list: async () => [],
    read: async () => new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]),
  } });
  const oversizedGate = new PermissionGate();
  const oversizedBus = new CapabilityBus(oversizedGate);
  oversizedGate.setGrant({ appId, granted: ['files:read'] });
  registerHostCapabilities(oversizedBus, oversized, { serverBase: () => 'https://rc.example' });
  await assert.rejects(
    () => oversizedBus.call('files.read', { path: '/file-upload/large' }, context()),
    /10 MB/,
  );
});

test('LAN 能力保留房间归属、成员校验和消息大小限制', async () => {
  const target = host();
  const gate = new PermissionGate();
  const bus = new CapabilityBus(gate);
  gate.setGrant({ appId, granted: ['lan:discover', 'lan:transfer'] });
  registerHostCapabilities(bus, target, { now: () => 123, createMessageId: () => 'generated-id' });
  assert.deepEqual(await bus.call('lan.peers', undefined, context()), [{
    userId: 'user-2',
    deviceId: 'device-2',
    deviceName: 'Laptop',
    trusted: true,
    source: 'mdns',
    lastSeenMs: 1,
  }]);
  assert.deepEqual(
    await bus.call('lan.send', { roomId: 'room-1', userId: 'user-2', text: 'hi' }, context()),
    { ok: true, messageId: 'generated-id' },
  );
  await assert.rejects(
    () => bus.call('lan.send', { roomId: 'room-1', userId: 'unknown', text: 'hi' }, context()),
    /当前会话成员/,
  );
  await assert.rejects(
    () => bus.call('lan.send', { roomId: 'room-1', userId: 'user-2', text: 'x'.repeat(48 * 1024 + 1) }, context()),
    /48 KiB/,
  );
});

test('聊天桥接事件通过 Host event port 注入', async () => {
  const runtime = await (await import('node:fs/promises')).readFile(
    new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /host\.events\.subscribeChat\(/);
  assert.doesNotMatch(runtime, /useChat\.subscribe\(/);
  assert.doesNotMatch(runtime, /useWorkbench\(/);
});

test('Kernel 初始化失败会清理部分注册，允许下一轮重试', async () => {
  const runtime = await (await import('node:fs/promises')).readFile(
    new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /\.catch\(async \(error\) => \{[\s\S]*?await teardownKernel\(\)\.catch/);
  assert.match(runtime, /bridgeEventsStarted = false/);
  assert.match(runtime, /capabilityBus\.clear\(\)/);
  assert.match(runtime, /kernelRegistry\.clear\(\)/);
});
