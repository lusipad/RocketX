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
    reacted: [] as Array<{ messageId: string; emoji: string; shouldReact?: boolean }>,
    rawSent: [] as Array<{ rid: string; msg?: string; tmid?: string; attachments?: unknown[] }>,
    threadReads: [] as string[],
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
      react: async (messageId, emoji, shouldReact) => {
        state.reacted.push({ messageId, emoji, ...(shouldReact === undefined ? {} : { shouldReact }) });
      },
      send: async (input) => {
        state.rawSent.push(input);
        return { _id: 'new-1', rid: input.rid, msg: input.msg ?? '', tmid: input.tmid, u: { _id: 'user-1', username: 'one' } } as never;
      },
      thread: async (tmid) => {
        state.threadReads.push(tmid);
        return [{ _id: 't1', rid: 'room-1', tmid, msg: 'event', u: { _id: 'user-1', username: 'one' } } as never];
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
  await assert.rejects(
    () => bus.call('users.read', { rid: 'other-room' }, context()),
    /只能读取已加入/,
  );
  assert.deepEqual(
    await bus.call('chat.postMessage', { rid: 'room-1', text: 'hi', tmid: 'thread-1' }, context()),
    { ok: true },
  );
});

test('表情回应/富消息/话题读取：权限、边界与参数透传', async () => {
  const target = host();
  const gate = new PermissionGate();
  const bus = new CapabilityBus(gate);
  gate.setGrant({ appId, granted: ['chat:write', 'chat:history'] });
  registerHostCapabilities(bus, target);

  // react：合法短名透传；格式不对拒收；缺 chat:write 拒收
  await bus.call('chat.react', { messageId: 'm1', emoji: ':one:' }, context());
  await bus.call('chat.react', { messageId: 'm1', emoji: ':one:', shouldReact: false }, context());
  const readOnlyGate = new PermissionGate();
  const readOnlyBus = new CapabilityBus(readOnlyGate);
  readOnlyGate.setGrant({ appId, granted: ['chat:read'] });
  registerHostCapabilities(readOnlyBus, target);
  await assert.rejects(
    () => readOnlyBus.call('chat.react', { messageId: 'm1', emoji: ':one:' }, context()),
    /未获得 chat:write/,
  );
  await assert.rejects(
    () => bus.call('chat.react', { messageId: 'm1', emoji: 'one' }, context()),
    /:name: 短名/,
  );

  // send：非成员房间拒收；tmid + attachments 透传给端口；空消息与非法附件拒收
  await assert.rejects(
    () => bus.call('chat.send', { rid: 'other-room', msg: 'hi' }, context()),
    /只能向已加入/,
  );
  const sent = await bus.call(
    'chat.send',
    { rid: 'room-1', msg: '📋 新卡片', tmid: 'root-1', attachments: [{ type: 'rcx-kanban', text: '', ev: { op: 'create', cardId: 'c1', title: '新卡片', column: 'todo' } }] },
    context(),
  ) as { _id: string; rid: string; tmid?: string };
  assert.equal(sent._id, 'new-1');
  assert.equal(sent.tmid, 'root-1');
  await assert.rejects(
    () => bus.call('chat.send', { rid: 'room-1' }, context()),
    /消息不能为空/,
  );
  await assert.rejects(
    () => bus.call('chat.send', { rid: 'room-1', attachments: 'not-array' }, context()),
    /attachments 必须是数组/,
  );

  // threads：读取话题需要 chat:history，缺参数拒收
  const threads = await bus.call('chat.threads', { tmid: 'root-1' }, context()) as { messages: unknown[] };
  assert.equal(threads.messages.length, 1);
  await assert.rejects(
    () => bus.call('chat.threads', {}, context()),
    /需要 tmid/,
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

test('LAN 能力仅提供已脱敏的设备发现', async () => {
  const target = host();
  const gate = new PermissionGate();
  const bus = new CapabilityBus(gate);
  gate.setGrant({ appId, granted: ['lan:discover'] });
  registerHostCapabilities(bus, target);
  assert.deepEqual(await bus.call('lan.peers', undefined, context()), [{
    userId: 'user-2',
    deviceId: 'device-2',
    deviceName: 'Laptop',
    trusted: true,
    source: 'mdns',
    lastSeenMs: 1,
  }]);
  await assert.rejects(() => bus.call('lan.send', undefined, context()), /未知能力|未注册|unknown/i);
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

test('消息事件必须按 chat:read 授权分发，且带更新事件通道', async () => {
  const runtime = await (await import('node:fs/promises')).readFile(
    new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url),
    'utf8',
  );
  // 门控是权限模型的一部分：消息内容不允许 emitAll（零权限应用也能收）
  assert.match(runtime, /emitWhere\('message\.received', plainMessage\(received\), canReadChat\)/);
  assert.match(runtime, /emitWhere\('message\.updated'/);
  assert.doesNotMatch(runtime, /emitAll\('message\.received'/);
  // 差分是纯函数且可单测（更新事件 = 回应/编辑通道）
  assert.match(runtime, /diffChatMessages\(state, previous\)/);
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
