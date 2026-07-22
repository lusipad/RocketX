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
import { useButler } from '../../apps/web/src/stores/butler';
import { useChat } from '../../apps/web/src/stores/chat';

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

test('manifest 拒绝未知权限、缺少 netAllow 和远程进程权限', () => {
  assert.equal(parseManifest(manifest).id, 'com.example.hello');
  assert.throws(() => parseManifest({ ...manifest, permissions: ['unknown'] }), /未知权限/);
  assert.throws(() => parseManifest({ ...manifest, permissions: ['net:fetch'] }), /netAllow/);
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

test('/ai 在统一派发器中打开管家并携带房间上下文，不会走服务端命令', async () => {
  const originalChat = useChat.getState();
  const originalAsk = useButler.getState().ask;
  const asked: Array<{ text: string; context?: { rid: string; roomName: string } }> = [];
  const cleanup = kernelRegistry.register('butler-command-test', 'composer.command', {
    id: 'butler',
    name: 'ai',
    description: '打开 AI，可直接跟上问题',
    run: runButlerCommand,
  });
  useChat.setState({
    activeRid: 'room-1',
    rightPanel: null,
    subscriptions: { ...originalChat.subscriptions, 'room-1': { fname: '产品讨论' } as never },
  });
  useButler.setState({
    ask: async (text, context) => {
      asked.push({ text, context });
    },
  });

  try {
    const commands = composerCommands([]);
    assert.equal(commands.find((command) => command.command === 'ai')?.description, '打开 AI，可直接跟上问题');
    const serverCalls: string[] = [];
    const runSlash = async (command: string, params: string, tmid?: string) => {
      const local = kernelRegistry
        .get('composer.command')
        .find((candidate) => candidate.name === command);
      if (local) await local.run({ rid: 'room-1', params, ...(tmid ? { tmid } : {}) });
      else serverCalls.push(command);
    };

    const withQuestion = await dispatchInput('/ai 上周的方案在哪', { rid: 'room-1', runSlash, commands }, 'thread-1');
    assert.deepEqual(withQuestion, { handled: true, accepted: true, command: 'ai' });
    assert.deepEqual(useChat.getState().rightPanel, { kind: 'butler' });
    assert.deepEqual(asked, [{ text: '上周的方案在哪', context: { rid: 'room-1', roomName: '产品讨论' } }]);
    assert.deepEqual(serverCalls, []);

    useChat.getState().setPanel(null);
    await dispatchInput('/ai', { rid: 'room-1', runSlash, commands });
    assert.deepEqual(useChat.getState().rightPanel, { kind: 'butler' });
    assert.equal(asked.length, 1);
  } finally {
    cleanup();
    useButler.setState({ ask: originalAsk });
    useChat.setState({
      activeRid: originalChat.activeRid,
      rightPanel: originalChat.rightPanel,
      subscriptions: originalChat.subscriptions,
    });
  }
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
  assert.equal(isOfficialApp(installed, 'dev.rocketx.intranet-link'), true);
  assert.equal(installed.enabled, false);
});

test('内置内网通首次保持关闭，升级保留开关且不能卸载', async () => {
  const store = createRcxStore({ backend: createMemoryBackend() });
  const bundled = await intranetLinkPackage();
  const firstLifecycle: string[] = [];
  const firstManager = new AppManager(store);
  firstManager.setActivator(() => {
    firstLifecycle.push('activate');
    return () => firstLifecycle.push('cleanup');
  });

  await firstManager.hydrate([bundled]);
  const installed = firstManager.get('dev.rocketx.intranet-link');
  assert.equal(installed?.source.kind, 'bundled');
  assert.equal(installed?.enabled, false);
  assert.equal(installed?.official, true);
  assert.deepEqual(installed?.granted, ['native:service', 'storage:local', 'files:read', 'ui:notify']);
  assert.deepEqual(firstLifecycle, [], '默认关闭时不能激活插件运行时');
  await assert.rejects(
    firstManager.uninstall('dev.rocketx.intranet-link'),
    /内置应用不能卸载/,
  );

  await firstManager.setEnabled('dev.rocketx.intranet-link', true);
  assert.deepEqual(firstLifecycle, ['activate']);

  const upgradeLifecycle: string[] = [];
  const upgradeManager = new AppManager(store);
  upgradeManager.setActivator(() => {
    upgradeLifecycle.push('activate');
  });
  await upgradeManager.hydrate([bundled]);
  assert.equal(upgradeManager.get('dev.rocketx.intranet-link')?.enabled, true);
  assert.deepEqual(upgradeLifecycle, ['activate'], '升级必须保留用户已启用状态');

  await firstManager.setEnabled('dev.rocketx.intranet-link', false);
  const disabledManager = new AppManager(store);
  let disabledActivated = false;
  disabledManager.setActivator(() => {
    disabledActivated = true;
  });
  await disabledManager.hydrate([bundled]);
  assert.equal(disabledManager.get('dev.rocketx.intranet-link')?.enabled, false);
  assert.equal(disabledActivated, false, '关闭状态升级后仍不能激活运行时');
});

test('内置插件升级会移除旧权限并授权新声明的签名侧车能力', async () => {
  const store = createRcxStore({ backend: createMemoryBackend() });
  const legacyManifest = parseManifest({
    id: 'dev.rocketx.intranet-link',
    version: '1.2.0',
    name: '内网通',
    publisher: 'RocketX',
    enabledByDefault: false,
    runtime: 'iframe',
    entry: 'index.html',
    permissions: ['lan:discover', 'lan:transfer', 'ui:notify'],
  });
  await store.apps.set(legacyManifest.id, {
    manifest: legacyManifest,
    granted: ['lan:discover', 'lan:transfer', 'ui:notify'],
    enabled: true,
    official: true,
    source: { kind: 'bundled', location: 'RocketX' },
    entryContent: '<!doctype html>',
    bundleHash: 'legacy',
    installedAt: 1,
  });

  const manager = new AppManager(store);
  await manager.hydrate([await intranetLinkPackage()]);

  const upgraded = manager.get(legacyManifest.id);
  assert.equal(upgraded?.manifest.version, '1.3.0');
  assert.equal(upgraded?.enabled, true);
  assert.deepEqual(upgraded?.granted, [
    'native:service',
    'storage:local',
    'files:read',
    'ui:notify',
  ]);
});

test('manifest 可声明默认禁用，且应用禁用和卸载会等待运行时清理完成', async () => {
  assert.equal(parseManifest({ ...manifest, enabledByDefault: false }).enabledByDefault, false);
  assert.throws(
    () => parseManifest({ ...manifest, enabledByDefault: 'false' }),
    /enabledByDefault/,
  );

  const store = createRcxStore({ backend: createMemoryBackend() });
  const manager = new AppManager(store);
  const lifecycle: string[] = [];
  let releaseCleanup: (() => void) | undefined;
  manager.setActivator(() => {
    lifecycle.push('activate');
    return () => new Promise<void>((resolve) => {
      lifecycle.push('cleanup:start');
      releaseCleanup = () => {
        lifecycle.push('cleanup:done');
        resolve();
      };
    });
  });

  const installed = await manager.installDirectory(disabledAppFiles());
  assert.equal(installed.enabled, false);
  assert.deepEqual(lifecycle, []);

  await manager.setEnabled(manifest.id, true);
  assert.deepEqual(lifecycle, ['activate']);

  let disabled = false;
  const disabling = manager.setEnabled(manifest.id, false).then(() => {
    disabled = true;
  });
  await Promise.resolve();
  assert.equal(disabled, false);
  assert.deepEqual(lifecycle, ['activate', 'cleanup:start']);
  releaseCleanup?.();
  await disabling;
  assert.equal(disabled, true);

  await manager.setEnabled(manifest.id, true);
  let uninstalled = false;
  const uninstalling = manager.uninstall(manifest.id).then(() => {
    uninstalled = true;
  });
  await Promise.resolve();
  assert.equal(uninstalled, false);
  releaseCleanup?.();
  await uninstalling;
  assert.equal(uninstalled, true);
  assert.equal(manager.get(manifest.id), undefined);

  const upgradeManager = new AppManager(createRcxStore({ backend: createMemoryBackend() }));
  await upgradeManager.installDirectory(disabledAppFiles());
  await upgradeManager.setEnabled(manifest.id, true);
  const upgraded = await upgradeManager.installDirectory(disabledAppFiles());
  assert.equal(upgraded.enabled, true, '升级不能重置用户已经启用的插件');
});

test('应用升级失败时恢复旧记录，卸载同时清理账号分区数据', async () => {
  const store = createRcxStore({ backend: createMemoryBackend() });
  const manager = new AppManager(store);
  await manager.installDirectory(appFiles('1.0.0', ['chat:write']), {
    sensitiveGrants: ['chat:write'],
  });
  assert.deepEqual(manager.get(manifest.id)?.granted, ['chat:write']);
  await manager.setSensitiveGrants(manifest.id, []);
  assert.deepEqual(manager.get(manifest.id)?.granted, []);
  manager.setActivator((app) => {
    if (app.manifest.version === '2.0.0') throw new Error('activation failed');
  });

  await assert.rejects(manager.installDirectory(appFiles('2.0.0')), /activation failed/);
  assert.equal(manager.get(manifest.id)?.manifest.version, '1.0.0');
  assert.equal((await store.apps.get<{ manifest: { version: string } }>(manifest.id))?.manifest.version, '1.0.0');

  await store.appData.set(manifest.id, 'legacy', true);
  await store.appData.set(`account@server:${manifest.id}`, 'scoped', true);
  await store.appData.set(`other@server:${manifest.id}`, 'other', true);
  await manager.uninstall(manifest.id);
  assert.equal(await store.apps.get(manifest.id), undefined);
  assert.equal(await store.appData.get(manifest.id, 'legacy'), undefined);
  assert.equal(await store.appData.get(`account@server:${manifest.id}`, 'scoped'), undefined);
  assert.equal(await store.appData.get(`other@server:${manifest.id}`, 'other'), undefined);
});

test('桌面端 CSP、文件系统、HTTP 与自动更新边界写入配置', async () => {
  const capability = JSON.parse(
    await readFile(new URL('../../apps/desktop/src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
  ) as { permissions: Array<string | { identifier?: string; allow?: unknown[] }> };
  const tauriConfig = JSON.parse(
    await readFile(new URL('../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as {
    app: { security: { csp: string | null } };
    bundle: { createUpdaterArtifacts?: boolean };
    plugins?: { updater?: { pubkey?: string; endpoints?: string[] } };
  };
  const fsScope = capability.permissions.find(
    (permission) => typeof permission === 'object' && permission.identifier === 'fs:scope',
  );
  assert.deepEqual(fsScope, {
    identifier: 'fs:scope',
    allow: ['$APPDATA/butler/**', '$APPDATA/attachment-archive/**'],
  });
  assert.ok(capability.permissions.includes('fs:allow-write-file'));
  assert.ok(capability.permissions.includes('fs:allow-remove'));
  assert.equal(
    capability.permissions.some(
      (permission) =>
        typeof permission === 'object' &&
        (permission.identifier === 'fs:allow-write-file' || permission.identifier === 'fs:allow-remove'),
    ),
    false,
  );
  assert.equal(
    capability.permissions.some(
      (permission) =>
        (typeof permission === 'string' && permission === 'http:default') ||
        (typeof permission === 'object' && permission.identifier === 'http:default'),
    ),
    false,
  );
  assert.ok(capability.permissions.includes('updater:default'));
  assert.ok(capability.permissions.includes('process:allow-restart'));
  assert.equal(typeof tauriConfig.app.security.csp, 'string');
  assert.match(tauriConfig.app.security.csp ?? '', /object-src 'none'/);
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
  assert.match(tauriConfig.plugins?.updater?.pubkey ?? '', /^[A-Za-z0-9+/=]+$/);
  assert.deepEqual(tauriConfig.plugins?.updater?.endpoints, [
    'https://github.com/lusipad/RocketX/releases/latest/download/latest.json',
  ]);

  const mainRs = await readFile(new URL('../../apps/desktop/src-tauri/src/main.rs', import.meta.url), 'utf8');
  const httpTs = await readFile(new URL('../../apps/web/src/lib/http.ts', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  assert.match(mainRs, /fn allow_http_origin/);
  assert.match(mainRs, /permission_scoped\([\s\S]*?"http:default"/);
  assert.match(httpTs, /invoke(?:<string>)?\('allow_http_origin'/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
});
