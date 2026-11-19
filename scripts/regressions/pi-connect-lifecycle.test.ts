import assert from 'node:assert/strict';
import test from 'node:test';
import { AppServerController, type CodexCatalog } from '../../apps/web/src/agent/AppServerController';
import { CODEX_APP_SERVER_VERSION, type CodexTransport } from '../../apps/web/src/agent/protocol';
import {
  resetCodexWorkspaceForTests,
  setCodexWorkspaceControllerFactory,
  useCodexWorkspace,
} from '../../apps/web/src/stores/codexWorkspace';

const storageValues = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { storageValues.set(key, String(value)); },
    removeItem: (key: string) => { storageValues.delete(key); },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function catalog(model: string): CodexCatalog {
  return {
    models: [{
      id: model,
      model,
      displayName: model,
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'balanced' }],
    } as CodexCatalog['models'][number]],
    permissionProfiles: [
      { id: ':workspace', description: null, allowed: true },
      { id: ':danger-full-access', description: null, allowed: true },
    ],
    skills: [],
    apps: [],
    plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
    catalogErrors: {},
  };
}

function prepareWorkspace() {
  useCodexWorkspace.setState({
    scope: 'pi-connect-lifecycle-test',
    defaultWorkspaceRoot: 'D:/test-default',
    butlerWorkspaceRoot: 'D:/test-butler',
    workspaceRoot: 'D:/test-butler',
    workspaceRoots: ['D:/test-default', 'D:/test-butler'],
  });
}

class StartingTransport implements CodexTransport {
  readonly started = deferred<void>();
  readonly release = deferred<void>();
  stops = 0;
  private handlers?: Parameters<CodexTransport['start']>[0];

  async start(handlers: Parameters<CodexTransport['start']>[0]) {
    this.handlers = handlers;
    this.started.resolve();
    await this.release.promise;
    return {
      processId: 'pi-starting-test',
      version: CODEX_APP_SERVER_VERSION,
      runtimeSource: 'bundled' as const,
      managedSkillRoots: ['D:/test-skills'],
    };
  }

  async write(message: Record<string, unknown>) {
    if (!('id' in message)) return;
    const values: Record<string, unknown> = {
      initialize: {
        userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} (Windows)`,
        codexHome: 'D:/test-codex',
        platformFamily: 'windows',
        platformOs: 'windows',
      },
      'skills/extraRoots/set': {},
      'model/list': { data: catalog('old-model').models, nextCursor: null },
      'permissionProfile/list': { data: catalog('old-model').permissionProfiles, nextCursor: null },
      'skills/list': { data: [{ cwd: 'D:/test-butler', skills: [], errors: [] }] },
      'app/list': { data: [], nextCursor: null },
      'plugin/list': catalog('old-model').plugins,
    };
    queueMicrotask(() => this.handlers?.onLine(JSON.stringify({ id: message.id, result: values[String(message.method)] })));
  }

  async stop() { this.stops += 1; }
}

test('Pi 启动尚未返回时停止 Controller，也会停止正在启动的 Transport', async () => {
  const transport = new StartingTransport();
  const controller = new AppServerController({ transportFactory: () => transport });
  const connecting = controller.connect('pending-start', 'D:/test-butler').catch(() => undefined);
  try {
    await transport.started.promise;
    await controller.stop();
    assert.equal(transport.stops, 1, '正在启动的 client 必须归 Controller 管理，停止不能漏过它');
  } finally {
    transport.release.resolve();
    await connecting;
    await controller.stop();
  }
});

test('保存配置触发重连时，新连接不会复用尚未结束的旧 connectRequest', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {} } });
  const oldCatalog = deferred<CodexCatalog>();
  let factoryCalls = 0;
  const restoreFactory = setCodexWorkspaceControllerFactory(() => {
    factoryCalls += 1;
    const current = factoryCalls;
    return {
      connect: async () => current === 1 ? oldCatalog.promise : catalog('new-model'),
      listThreads: async () => [],
      stop: async () => undefined,
    } as never;
  });
  let first: Promise<unknown> | undefined;
  let reconnecting: Promise<unknown> | undefined;
  try {
    await resetCodexWorkspaceForTests();
    prepareWorkspace();
    first = useCodexWorkspace.getState().connect({ refreshThreads: false }).catch(() => undefined);
    await tick();
    reconnecting = useCodexWorkspace.getState().reconnectRuntime().catch(() => undefined);
    await tick();
    assert.equal(factoryCalls, 2, '重连必须建立新 Controller，不能等待旧配置下的 Promise');
    oldCatalog.resolve(catalog('old-model'));
    await Promise.all([first, reconnecting]);
    assert.equal(useCodexWorkspace.getState().selectedModel, 'new-model');
    assert.equal(useCodexWorkspace.getState().status, 'ready');
  } finally {
    oldCatalog.resolve(catalog('old-model'));
    await Promise.all([first, reconnecting]);
    await resetCodexWorkspaceForTests();
    restoreFactory();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('关闭运行时以后，旧连接晚完成不会把工作区重新写成 ready', async () => {
  const oldCatalog = deferred<CodexCatalog>();
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => oldCatalog.promise,
    listThreads: async () => [],
    stop: async () => undefined,
  } as never));
  let connecting: Promise<unknown> | undefined;
  try {
    await resetCodexWorkspaceForTests();
    prepareWorkspace();
    connecting = useCodexWorkspace.getState().connect({ refreshThreads: false }).catch(() => undefined);
    await tick();
    await useCodexWorkspace.getState().shutdown();
    oldCatalog.resolve(catalog('old-model'));
    await connecting;
    assert.equal(useCodexWorkspace.getState().status, 'idle');
    assert.equal(useCodexWorkspace.getState().models.length, 0);
  } finally {
    oldCatalog.resolve(catalog('old-model'));
    await connecting;
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('连接已失败但清理尚未返回时，界面立即退出 connecting 并显示原始错误', async () => {
  const stopStarted = deferred<void>();
  const finishStop = deferred<void>();
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => { throw new Error('Pi initialize failed'); },
    stop: async () => { stopStarted.resolve(); await finishStop.promise; },
  } as never));
  let connecting: Promise<unknown> | undefined;
  try {
    await resetCodexWorkspaceForTests();
    prepareWorkspace();
    connecting = useCodexWorkspace.getState().connect({ refreshThreads: false }).catch(() => undefined);
    await stopStarted.promise;
    assert.equal(useCodexWorkspace.getState().status, 'unavailable');
    assert.equal(useCodexWorkspace.getState().error, 'Pi initialize failed');
  } finally {
    finishStop.resolve();
    await connecting;
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('失败后的 stop 挂起不会延迟错误返回，也不阻塞下一次连接', async () => {
  const finishStop = deferred<void>();
  let calls = 0;
  const restoreFactory = setCodexWorkspaceControllerFactory(() => {
    const attempt = ++calls;
    return {
      connect: async () => {
        if (attempt === 1) throw new Error('Pi original startup error');
        return catalog('retry-model');
      },
      stop: async () => { if (attempt === 1) await finishStop.promise; },
    } as never;
  });
  try {
    await resetCodexWorkspaceForTests();
    prepareWorkspace();
    let outcome: unknown;
    const failed = useCodexWorkspace.getState().connect({ refreshThreads: false }).catch((error: unknown) => { outcome = error; });
    await tick();
    assert.ok(outcome instanceof Error, '错误必须在进程清理完成前返回调用方');
    assert.equal(outcome.message, 'Pi original startup error');
    await useCodexWorkspace.getState().connect({ refreshThreads: false });
    assert.equal(calls, 2);
    assert.equal(useCodexWorkspace.getState().selectedModel, 'retry-model');
    await failed;
  } finally {
    finishStop.resolve();
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('账号切换后旧连接晚完成不写回新账号的模型或状态', async () => {
  const oldCatalog = deferred<CodexCatalog>();
  let calls = 0;
  const restoreFactory = setCodexWorkspaceControllerFactory(() => {
    const attempt = ++calls;
    return {
      connect: async () => attempt === 1 ? oldCatalog.promise : catalog('account-b-model'),
      stop: async () => undefined,
    } as never;
  });
  let first: Promise<unknown> | undefined;
  try {
    await resetCodexWorkspaceForTests();
    prepareWorkspace();
    first = useCodexWorkspace.getState().connect({ refreshThreads: false });
    await tick();
    useCodexWorkspace.getState().hydrate('account-b');
    prepareWorkspace();
    useCodexWorkspace.setState({ scope: 'account-b' });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });
    oldCatalog.resolve(catalog('account-a-model'));
    await first;
    assert.equal(useCodexWorkspace.getState().scope, 'account-b');
    assert.equal(useCodexWorkspace.getState().selectedModel, 'account-b-model');
    assert.equal(useCodexWorkspace.getState().status, 'ready');
  } finally {
    oldCatalog.resolve(catalog('account-a-model'));
    await first;
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('正常刷新连接不会把正在运行或等待输入的会话标成 ready', async () => {
  const restoreFactory = setCodexWorkspaceControllerFactory(() => ({
    connect: async () => catalog('existing-model'),
    stop: async () => undefined,
  } as never));
  try {
    for (const status of ['running', 'waiting-input'] as const) {
      await resetCodexWorkspaceForTests();
      prepareWorkspace();
      useCodexWorkspace.setState({ activeThreadId: 'existing-thread', status, activeTurnId: 'existing-turn' });
      await useCodexWorkspace.getState().connect({ refreshThreads: false });
      assert.equal(useCodexWorkspace.getState().status, status);
      assert.equal(useCodexWorkspace.getState().activeTurnId, 'existing-turn');
    }
  } finally {
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('取消启动后晚返回的 transport 不会继续握手或复活 Controller', async () => {
  const transport = new StartingTransport();
  const controller = new AppServerController({ transportFactory: () => transport });
  let writes = 0;
  transport.write = async () => { writes += 1; };
  const connecting = controller.connect('cancelled-start', 'D:/test-butler');
  await transport.started.promise;
  await controller.stop();
  transport.release.resolve();
  await assert.rejects(connecting, /已停止|已取消/);
  assert.equal(writes, 0, '已取消的 transport.start 返回后不能发送 initialize');
  assert.equal(controller.currentCatalog, undefined);
  assert.equal(controller.currentSessionId, undefined);
  assert.ok(transport.stops >= 2, '晚返回的启动资源也必须清理');
});

test('旧连接晚完成不会清除新连接的在途请求，也不会改写连接状态', async () => {
  const firstCatalog = deferred<CodexCatalog>();
  const secondCatalog = deferred<CodexCatalog>();
  let calls = 0;
  const restoreFactory = setCodexWorkspaceControllerFactory(() => {
    const attempt = ++calls;
    return {
      connect: async () => attempt === 1 ? firstCatalog.promise : secondCatalog.promise,
      stop: async () => undefined,
    } as never;
  });
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  let duplicate: Promise<unknown> | undefined;
  try {
    await resetCodexWorkspaceForTests();
    prepareWorkspace();
    first = useCodexWorkspace.getState().connect({ refreshThreads: false });
    await tick();
    await useCodexWorkspace.getState().shutdown();
    second = useCodexWorkspace.getState().connect({ refreshThreads: false });
    await tick();
    firstCatalog.resolve(catalog('stale-model'));
    await first;
    assert.equal(useCodexWorkspace.getState().status, 'connecting');
    assert.equal(useCodexWorkspace.getState().models.length, 0);
    duplicate = useCodexWorkspace.getState().connect({ refreshThreads: false });
    await tick();
    assert.equal(calls, 2, '旧请求 finally 不能释放新连接的去重锁');
    secondCatalog.resolve(catalog('current-model'));
    await Promise.all([second, duplicate]);
    assert.equal(useCodexWorkspace.getState().selectedModel, 'current-model');
  } finally {
    firstCatalog.resolve(catalog('stale-model'));
    secondCatalog.resolve(catalog('current-model'));
    await Promise.all([first, second, duplicate]);
    await resetCodexWorkspaceForTests();
    restoreFactory();
  }
});

test('真实 Controller 握手失败后不等待挂起的 Transport.stop 才返回原始错误', async () => {
  const transport = new StartingTransport();
  const finishStop = deferred<void>();
  transport.write = async () => { throw new Error('Pi handshake write failed'); };
  transport.stop = async () => { transport.stops += 1; await finishStop.promise; };
  const controller = new AppServerController({ transportFactory: () => transport });
  let outcome: unknown;
  const connecting = controller.connect('failed-handshake', 'D:/test-butler').catch((error: unknown) => { outcome = error; });
  try {
    await transport.started.promise;
    transport.release.resolve();
    await tick();
    assert.ok(outcome instanceof Error);
    assert.equal(outcome.message, 'Pi handshake write failed');
    assert.equal(controller.currentCatalog, undefined);
  } finally {
    finishStop.resolve();
    transport.release.resolve();
    await connecting;
    await controller.stop();
  }
});
