import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KernelRegistry, kernelRegistry } from '../../apps/web/src/kernel/registry';
import { parseManifest, type AppPermission } from '../../apps/web/src/kernel/manifest';
import { PermissionGate } from '../../apps/web/src/kernel/permission';
import { composerCommands, dispatchInput } from '../../apps/web/src/kernel/dispatch';
import { sandboxDocument } from '../../apps/web/src/kernel/sandbox/iframe';
import { CapabilityBus } from '../../apps/web/src/kernel/capabilities/bus';
import { BridgeHost } from '../../apps/web/src/kernel/bridge';
import { AppManager, isOfficialApp } from '../../apps/web/src/kernel/installed';
import { runButlerCommand } from '../../apps/web/src/kernel/butler';
import { createMemoryBackend, createRcxStore } from '../../packages/rcx-store/src/index';

const manifest = {
  id: 'com.example.hello',
  version: '1.0.0',
  name: 'Hello',
  publisher: 'Example',
  runtime: 'iframe' as const,
  entry: './index.html',
  permissions: ['chat:read', 'ui:notify'] as const,
};

test('扩展注册表拒绝跨应用重名并按 appId 完整卸载', () => {
  const registry = new KernelRegistry();
  registry.register('app.one', 'nav.module', { id: 'one', label: '一', render: () => null });
  registry.register('app.one', 'composer.command', {
    id: 'hello',
    name: 'hello',
    description: 'hello',
    run: () => {},
  });
  assert.throws(
    () => registry.register('app.two', 'nav.module', { id: 'one', label: '二', render: () => null }),
    /已由 app\.one 注册/,
  );
  registry.unregisterApp('app.one');
  assert.equal(registry.get('nav.module').length, 0);
  assert.equal(registry.get('composer.command').length, 0);
});

test('manifest 拒绝未知权限、缺少 netAllow、非法配置和远程进程权限', () => {
  assert.equal(parseManifest(manifest).id, 'com.example.hello');
  assert.throws(() => parseManifest({ ...manifest, permissions: ['unknown'] }), /未知权限/);
  assert.throws(() => parseManifest({ ...manifest, permissions: ['net:fetch'] }), /netAllow/);
  const configured = parseManifest({
    ...manifest,
    permissions: ['config:read'],
    config: { env: ['ROCKETX_API_URL'] },
  });
  assert.deepEqual(configured.config, { env: ['ROCKETX_API_URL'] });
  assert.throws(
    () => parseManifest({ ...manifest, config: { env: ['ROCKETX_API_URL'] } }),
    /config:read/,
  );
  assert.throws(
    () =>
      parseManifest({
        ...manifest,
        permissions: ['secrets:use'],
        config: { secrets: ['ROCKETX_API_TOKEN'] },
      }),
    /bundled native service/,
  );
  assert.throws(
    () =>
      parseManifest({
        ...manifest,
        permissions: ['config:read'],
        config: { env: ['1_INVALID'] },
      }),
    /非法环境变量名/,
  );
  assert.throws(
    () =>
      parseManifest({
        ...manifest,
        entry: 'https://example.com/app.html',
        permissions: ['process:spawn'],
      }),
    /process:spawn/,
  );
  assert.throws(
    () =>
      parseManifest({
        ...manifest,
        entry: 'https://example.com/app.html',
        permissions: ['agent:spawn'],
      }),
    /远程应用不能申请 agent:spawn/,
  );
});

test('权限闸门允许已授权能力、拒绝越权并完整写审计', async () => {
  const audit: Array<{ allowed: boolean; reason?: string }> = [];
  const gate = new PermissionGate((entry) => {
    audit.push(entry);
  });
  gate.setGrant({ appId: 'app', granted: ['chat:read'] });
  await gate.authorize('app', 'chat:read', 'chat.current');
  await assert.rejects(() => gate.authorize('app', 'chat:write', 'chat.postMessage'), /未获得 chat:write/);
  assert.deepEqual(audit.map((entry) => entry.allowed), [true, false]);
  assert.match(audit[1].reason ?? '', /缺少权限/);
});

test('统一派发器本地命令优先、未知命令仍被拦截且 trigger 保留线程上下文', async () => {
  kernelRegistry.unregisterApp('kernel-test');
  const calls: unknown[] = [];
  const cleanupCommand = kernelRegistry.register('kernel-test', 'composer.command', {
    id: 'local',
    name: 'hello',
    description: 'hello',
    run: (context) => calls.push(context),
  });
  const cleanupTrigger = kernelRegistry.register('kernel-test', 'composer.trigger', {
    id: 'codex',
    prefix: '$codex',
    run: (context) => calls.push(context),
  });
  try {
    const commands = composerCommands([{ command: 'help' }, { command: 'hello', description: 'server' }]);
    assert.equal(commands.find((command) => command.command === 'hello')?.description, 'hello');
    const serverCalls: string[] = [];
    const runSlash = async (command: string, params: string, tmid?: string) => {
      const local = kernelRegistry
        .get('composer.command')
        .find((candidate) => candidate.name === command);
      if (local) await local.run({ rid: 'room', params, ...(tmid ? { tmid } : {}) });
      else serverCalls.push(command);
    };
    const local = await dispatchInput('/hello world', { rid: 'room', runSlash, commands }, 'thread');
    assert.deepEqual(local, { handled: true, accepted: true, command: 'hello' });
    assert.deepEqual(calls[0], { rid: 'room', params: 'world', tmid: 'thread' });
    const unknown = await dispatchInput('/missing', { rid: 'room', runSlash, commands });
    assert.equal(unknown.handled, true);
    assert.equal(unknown.accepted, false);
    const trigger = await dispatchInput('$codex inspect', { rid: 'room', runSlash, commands }, 'thread');
    assert.equal(trigger.accepted, true);
    assert.deepEqual(calls[1], { rid: 'room', text: '$codex inspect', tmid: 'thread' });
  } finally {
    cleanupTrigger();
    cleanupCommand();
  }
});

test('trigger 可显式放行，让话题指令先成为普通 Rocket.Chat 消息', async () => {
  const cleanup = kernelRegistry.register('kernel-passthrough-test', 'composer.trigger', {
    id: 'shared-agent',
    prefix: '$agent',
    run: () => false,
  });
  try {
    const result = await dispatchInput('$agent inspect', {
      rid: 'room',
      runSlash: async () => undefined,
      commands: [],
    }, 'thread');
    assert.deepEqual(result, { handled: false });
  } finally {
    cleanup();
  }
});

test('/ai 命令注册到统一派发器，并把任务交给当前 AI 运行时', async () => {
  const [runtime, butler] = await Promise.all([
    readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/kernel/butler.ts', import.meta.url), 'utf8'),
  ]);

  assert.equal(typeof runButlerCommand, 'function');
  assert.match(runtime, /name: 'ai'/);
  assert.match(runtime, /description: '打开 AI 管家，可直接跟上问题'/);
  assert.match(runtime, /run: runButlerCommand/);
  assert.match(butler, /import \{ handoffToButlerTask \} from '\.\.\/lib\/butlerTaskHandoff';/);
  assert.match(butler, /useUI\.getState\(\)\.openButlerConversation\(\);/);
  assert.match(butler, /void handoffToButlerTask\(/);
  assert.doesNotMatch(butler, /useButler/);
});

test('能力总线在 handler 前执行权限判定', async () => {
  const gate = new PermissionGate();
  gate.setGrant({ appId: 'com.example.hello', granted: ['chat:read'] });
  const bus = new CapabilityBus(gate);
  bus.register('chat.current', 'chat:read', () => ({ ok: true }));
  bus.register('chat.postMessage', 'chat:write', () => ({ ok: true }));
  const context = { appId: 'com.example.hello', manifest: parseManifest(manifest) };
  assert.deepEqual(await bus.call('chat.current', undefined, context), { ok: true });
  await assert.rejects(() => bus.call('chat.postMessage', undefined, context), /未获得 chat:write/);
  await assert.rejects(() => bus.call('missing.method', undefined, context), /未知能力/);
});

test('app.info 纳入基础权限并仅暴露应用公开元数据', async () => {
  const [manifestSource, permissionSource] = await Promise.all([
    readFile(new URL('../../packages/app-sdk/src/manifest.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(manifestSource, /'app:info'/);
  assert.match(permissionSource, /capabilityBus\.register\('app\.info', 'app:info'/);
  assert.match(permissionSource, /permissions: \[\.\.\.app\.granted\]/);
  assert.doesNotMatch(permissionSource, /entry: app\.manifest\.entry/);
  assert.doesNotMatch(permissionSource, /config: app\.manifest\.config/);
});

test('iframe 文档注入独立 CSP 且不授予同源能力', () => {
  const parsed = parseManifest({
    ...manifest,
    entry: 'https://apps.example.com/index.html',
    permissions: ['net:fetch'],
    netAllow: ['https://api.example.com'],
  });
  const html = sandboxDocument(parsed, '<html><head></head><body>Hello</body></html>');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /connect-src https:\/\/api\.example\.com/);
  assert.match(html, /base-uri https:\/\/apps\.example\.com/);
  assert.match(html, /base href="https:\/\/apps\.example\.com\/index\.html"/);
  assert.match(html, /__RCX_BRIDGE__/);
  assert.doesNotMatch(html, /allow-same-origin/);
});

test('MessageChannel 在 iframe 就绪前保留事件并承载受控 RPC', async () => {
  const gate = new PermissionGate();
  gate.setGrant({ appId: manifest.id, granted: ['chat:read'] });
  const bus = new CapabilityBus(gate);
  bus.register('chat.current', 'chat:read', () => ({ rid: 'room-1' }));
  const host = new BridgeHost(bus);
  let appPort: MessagePort | undefined;
  const source = {
    postMessage(message: unknown, origin: string, transfer: Transferable[]) {
      assert.deepEqual(message, { jsonrpc: '2.0', method: 'rcx/connect' });
      assert.equal(origin, '*');
      appPort = transfer[0] as MessagePort;
    },
  } as unknown as Window;

  host.emit(manifest.id, 'composer.command', { params: 'first' });
  const cleanup = host.registerFrame(manifest.id, parseManifest(manifest), source);
  assert.ok(appPort);
  const nextMessage = () =>
    new Promise<unknown>((resolve) =>
      appPort!.addEventListener('message', (event) => resolve(event.data), { once: true }),
    );
  try {
    const queued = nextMessage();
    appPort.start();
    assert.deepEqual(await queued, {
      jsonrpc: '2.0',
      method: 'rcx/event',
      params: { event: 'composer.command', payload: { params: 'first' } },
    });

    const response = nextMessage();
    appPort.postMessage({
      jsonrpc: '2.0',
      id: 'rpc-1',
      method: 'rcx/call',
      params: { method: 'chat.current' },
    });
    assert.deepEqual(await response, { jsonrpc: '2.0', id: 'rpc-1', result: { rid: 'room-1' } });
  } finally {
    cleanup();
    appPort.close();
  }
});

function appFiles(version: string, permissions: AppPermission[] = []): File[] {
  const manifestFile = new File(
    [JSON.stringify({ ...manifest, version, permissions })],
    'rcx.app.json',
    { type: 'application/json' },
  );
  const entryFile = new File(['<!doctype html><h1>Hello</h1>'], 'index.html', { type: 'text/html' });
  Object.defineProperty(manifestFile, 'webkitRelativePath', { value: 'hello/rcx.app.json' });
  Object.defineProperty(entryFile, 'webkitRelativePath', { value: 'hello/index.html' });
  return [manifestFile, entryFile];
}

function disabledAppFiles(): File[] {
  const manifestFile = new File(
    [JSON.stringify({ ...manifest, enabledByDefault: false })],
    'rcx.app.json',
    { type: 'application/json' },
  );
  const entryFile = new File(['<!doctype html><h1>Hello</h1>'], 'index.html', { type: 'text/html' });
  Object.defineProperty(manifestFile, 'webkitRelativePath', { value: 'hello/rcx.app.json' });
  Object.defineProperty(entryFile, 'webkitRelativePath', { value: 'hello/index.html' });
  return [manifestFile, entryFile];
}

async function intranetLinkFiles(entryOverride?: string): Promise<File[]> {
  const [manifestText, officialEntry] = await Promise.all([
    readFile(new URL('../../plugins/intranet-link/rcx.app.json', import.meta.url), 'utf8'),
    readFile(new URL('../../plugins/intranet-link/index.html', import.meta.url), 'utf8'),
  ]);
  const manifestFile = new File([manifestText], 'rcx.app.json', { type: 'application/json' });
  const entryFile = new File([entryOverride ?? officialEntry], 'index.html', { type: 'text/html' });
  Object.defineProperty(manifestFile, 'webkitRelativePath', { value: 'intranet-link/rcx.app.json' });
  Object.defineProperty(entryFile, 'webkitRelativePath', { value: 'intranet-link/index.html' });
  return [manifestFile, entryFile];
}

async function intranetLinkPackage(): Promise<{ manifestText: string; entryContent: string }> {
  const [manifestText, entryContent] = await Promise.all([
    readFile(new URL('../../plugins/intranet-link/rcx.app.json', import.meta.url), 'utf8'),
    readFile(new URL('../../plugins/intranet-link/index.html', import.meta.url), 'utf8'),
  ]);
  return { manifestText, entryContent };
}

test('官方插件身份由宿主校验，第三方不能仅靠相同 ID 获得特权', async () => {
  const manager = new AppManager(createRcxStore({ backend: createMemoryBackend() }));
  await assert.rejects(
    manager.installDirectory(await intranetLinkFiles('<!doctype html><script>/* spoof */</script>')),
    /native service 只允许.*内置应用/,
  );
  assert.equal(manager.get('dev.rocketx.intranet-link'), undefined);
  await manager.hydrate([await intranetLinkPackage()]);
  const installed = manager.get('dev.rocketx.intranet-link');
  assert.ok(installed);
  assert.equal(isOfficialApp(installed), true);
});
