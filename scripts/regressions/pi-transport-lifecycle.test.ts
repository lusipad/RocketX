import assert from 'node:assert/strict';
import test from 'node:test';
import { TauriPiTransport } from '../../apps/web/src/agent/protocol/tauriTransport';
import { CODEX_APP_SERVER_VERSION } from '../../apps/web/src/agent/protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const processInfo = (processId: string) => ({
  processId,
  version: CODEX_APP_SERVER_VERSION,
  runtimeSource: 'bundled' as const,
  managedSkillRoots: ['D:/test-skills'],
});
const handlers = { onLine: (_line: string) => undefined, onExit: (_code: number | null) => undefined };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function installBridge(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const callbacks = new Map<number, unknown>();
  const removed: number[] = [];
  let nextId = 1;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback: (callback: unknown) => {
          const id = nextId++;
          callbacks.set(id, callback);
          return id;
        },
        invoke,
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (_event: string, id: number) => { removed.push(id); callbacks.delete(id); },
      },
    },
  });
  return {
    callbacks,
    removed,
    restore: () => {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

test('Pi 的第二个事件监听注册失败时也移除第一个监听，不启动子进程', async () => {
  const commands: string[] = [];
  let firstListener = 0;
  const bridge = installBridge(async (command, args) => {
    commands.push(command);
    if (command === 'plugin:event|listen') {
      if (args.event === 'pi-app-server-exit') throw new Error('exit listener failed');
      firstListener = Number(args.handler);
      return firstListener;
    }
  });
  try {
    const transport = new TauriPiTransport('listener-failure', 'D:/test');
    await assert.rejects(transport.start(handlers), /exit listener failed/);
    assert.deepEqual(bridge.removed, [firstListener]);
    assert.equal(commands.includes('pi_app_server_start'), false);
  } finally {
    bridge.restore();
  }
});

test('Pi 启动 IPC 晚返回时只终止该启动返回的进程，不复活连接或遗留监听', async () => {
  const started = deferred<void>();
  const lateProcess = deferred<ReturnType<typeof processInfo>>();
  const stopped: unknown[] = [];
  const bridge = installBridge(async (command, args) => {
    if (command === 'plugin:event|listen') return args.handler;
    if (command === 'pi_app_server_start') { started.resolve(); return lateProcess.promise; }
    if (command === 'pi_app_server_stop') stopped.push(args.processId);
  });
  try {
    const transport = new TauriPiTransport('cancelled-start', 'D:/test');
    const starting = transport.start(handlers);
    await started.promise;
    await transport.stop();
    assert.equal(bridge.callbacks.size, 0);
    assert.deepEqual(stopped, [], '没有启动回执时不能凭 sessionId 或其他进程 ID 停进程');
    lateProcess.resolve(processInfo('own-late-process'));
    await assert.rejects(starting, /已取消/);
    await tick();
    assert.deepEqual(stopped, ['own-late-process']);
    assert.equal(bridge.callbacks.size, 0);
    await assert.rejects(transport.write({ method: 'initialize' }), /not active/);
  } finally {
    lateProcess.resolve(processInfo('own-late-process'));
    bridge.restore();
  }
});

test('监听注册尚未返回时取消，晚注册的监听立即移除且不启动 Pi', async () => {
  const listening = deferred<void>();
  const releaseListener = deferred<number>();
  const commands: string[] = [];
  let listenerId = 0;
  const bridge = installBridge(async (command, args) => {
    commands.push(command);
    if (command === 'plugin:event|listen') {
      listenerId = Number(args.handler);
      listening.resolve();
      return releaseListener.promise;
    }
  });
  try {
    const transport = new TauriPiTransport('late-listener', 'D:/test');
    const starting = transport.start(handlers);
    await listening.promise;
    await transport.stop();
    releaseListener.resolve(listenerId);
    await assert.rejects(starting, /已取消/);
    assert.deepEqual(bridge.removed, [listenerId]);
    assert.equal(commands.filter((command) => command === 'plugin:event|listen').length, 1);
    assert.equal(commands.includes('pi_app_server_start'), false);
  } finally {
    releaseListener.resolve(listenerId);
    bridge.restore();
  }
});

test('旧 Pi 启动的迟到回执不能停止同一 Transport 的新连接', async () => {
  const started = deferred<void>();
  const oldProcess = deferred<ReturnType<typeof processInfo>>();
  const stopped: unknown[] = [];
  const writes: unknown[] = [];
  let starts = 0;
  const bridge = installBridge(async (command, args) => {
    if (command === 'plugin:event|listen') return args.handler;
    if (command === 'pi_app_server_start') {
      if (++starts === 1) { started.resolve(); return oldProcess.promise; }
      return processInfo('new-process');
    }
    if (command === 'pi_app_server_stop') stopped.push(args.processId);
    if (command === 'pi_app_server_write') writes.push(args.processId);
  });
  try {
    const transport = new TauriPiTransport('restarted', 'D:/test');
    const oldStart = transport.start(handlers);
    await started.promise;
    await transport.stop();
    await transport.start(handlers);
    oldProcess.resolve(processInfo('old-process'));
    await assert.rejects(oldStart, /已取消/);
    await transport.write({ method: 'initialized' });
    assert.deepEqual(stopped, ['old-process']);
    assert.deepEqual(writes, ['new-process']);
    assert.equal(bridge.callbacks.size, 2);
    await transport.stop();
    assert.deepEqual(stopped, ['old-process', 'new-process']);
    assert.equal(bridge.callbacks.size, 0);
  } finally {
    oldProcess.resolve(processInfo('old-process'));
    bridge.restore();
  }
});
