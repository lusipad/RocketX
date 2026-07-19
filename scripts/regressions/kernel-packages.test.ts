import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  APP_PERMISSIONS,
  BridgeDestroyedError,
  BridgeRpcError,
  BridgeTimeoutError,
  EXTENSION_POINTS,
  createBridgeClient,
  parseManifest,
  type BridgeMessageEvent,
} from '../../packages/app-sdk/src/index';
import { createMemoryBackend, createRcxStore } from '../../packages/rcx-store/src/index';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('app-sdk 暴露 manifest 单一契约并保留既有校验语义', () => {
  assert.ok(APP_PERMISSIONS.includes('chat:read'));
  assert.ok(EXTENSION_POINTS.includes('message.action'));
  assert.equal(parseManifest({
    id: 'com.example.hello',
    version: '1.0.0',
    name: 'Hello',
    publisher: 'Example',
    runtime: 'iframe',
    entry: './index.html',
    permissions: ['chat:read'],
    contributes: { 'message.action': [{ id: 'hello' }] },
  }).id, 'com.example.hello');
  assert.throws(() => parseManifest({
    id: 'com.example.invalid',
    version: '1.0.0',
    name: 'Invalid',
    publisher: 'Example',
    runtime: 'iframe',
    entry: './index.html',
    permissions: ['unknown'],
  }), /未知权限/);
});

test('app-sdk npm 包只发布可执行 ESM、类型声明和开源说明', async () => {
  const packageDir = join(repoRoot, 'packages/app-sdk');
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    private?: boolean;
    version?: string;
    license?: string;
    main?: string;
    types?: string;
    exports?: Record<string, unknown>;
    files?: string[];
    publishConfig?: { access?: string };
  };
  assert.notEqual(packageJson.private, true);
  assert.equal(packageJson.version, '0.24.2');
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.main, './dist/index.js');
  assert.equal(packageJson.types, './dist/index.d.ts');
  assert.deepEqual(packageJson.files, ['dist', 'README.md', 'LICENSE']);
  assert.equal(packageJson.publishConfig?.access, 'public');
  assert.deepEqual(packageJson.exports?.['.'], {
    types: './dist/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js',
  });

  const destination = await mkdtemp(join(tmpdir(), 'rocketx-app-sdk-pack-'));
  try {
    const packed = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', [
          '/d',
          '/c',
          'pnpm',
          '--dir',
          packageDir,
          'pack',
          '--pack-destination',
          destination,
        ], { encoding: 'utf8' })
      : spawnSync('pnpm', ['--dir', packageDir, 'pack', '--pack-destination', destination], {
          encoding: 'utf8',
        });
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const archive = (await readdir(destination)).find((file) => file.endsWith('.tgz'));
    assert.ok(archive, 'pnpm pack 应生成 tgz');
    const listed = spawnSync('tar', ['-tf', join(destination, archive)], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    const files = listed.stdout.split(/\r?\n/).filter(Boolean);
    assert.ok(files.includes('package/dist/index.js'));
    assert.ok(files.includes('package/dist/index.d.ts'));
    assert.ok(files.includes('package/dist/manifest.js'));
    assert.ok(files.includes('package/dist/manifest.d.ts'));
    assert.ok(files.includes('package/README.md'));
    assert.ok(files.includes('package/LICENSE'));
    assert.ok(files.includes('package/package.json'));
    assert.equal(files.some((file) => file.startsWith('package/src/')), false);
    assert.equal(files.some((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')), false);

    const extracted = spawnSync('tar', ['-xf', join(destination, archive), '-C', destination], {
      encoding: 'utf8',
    });
    assert.equal(extracted.status, 0, extracted.stderr);
    const published = await import(pathToFileURL(join(destination, 'package/dist/index.js')).href) as {
      parseManifest(value: unknown): { id: string };
    };
    assert.equal(published.parseManifest({
      id: 'com.example.packed',
      version: '1.0.0',
      name: 'Packed',
      publisher: 'Example',
      runtime: 'worker',
      entry: './worker.js',
      permissions: [],
    }).id, 'com.example.packed');
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

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
