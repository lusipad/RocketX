import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DshController,
  parseDshBridgeLine,
  type DshControllerHandlers,
} from '../../apps/web/src/agent/dsh/DshController';

type EventName = 'dsh-bridge-output' | 'dsh-bridge-exit';

interface RuntimeEventMap {
  'dsh-bridge-output': { processId: string; stream: 'stdout' | 'stderr'; line: string };
  'dsh-bridge-exit': { processId: string; code: number | null };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createRuntime() {
  const start = deferred<{ processId: string }>();
  const listeners = new Map<EventName, Set<(event: { payload: unknown }) => void>>();
  const stops: string[] = [];

  return {
    start,
    stops,
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (command === 'dsh_bridge_start') return start.promise as Promise<T>;
      if (command === 'dsh_bridge_stop') {
        stops.push(String(args?.processId ?? ''));
        return undefined as T;
      }
      if (command === 'dsh_bridge_write') {
        return undefined as T;
      }
      throw new Error(`unexpected invoke: ${command}`);
    },
    async listen<T>(event: string, handler: (event: { payload: T }) => void) {
      const name = event as EventName;
      let bucket = listeners.get(name);
      if (!bucket) {
        bucket = new Set();
        listeners.set(name, bucket);
      }
      bucket.add(handler as (event: { payload: unknown }) => void);
      return () => {
        bucket?.delete(handler as (event: { payload: unknown }) => void);
      };
    },
    emit<K extends EventName>(event: K, payload: RuntimeEventMap[K]) {
      for (const handler of listeners.get(event) ?? []) handler({ payload });
    },
  };
}

function handlers(errors: Error[], exits: Array<number | null>): DshControllerHandlers {
  return {
    onMux: () => undefined,
    onHost: () => undefined,
    onError: (error) => errors.push(error),
    onExit: (code) => exits.push(code),
  };
}

test('DSH controller stops a bridge that resolves after the caller already closed it', async () => {
  const runtime = createRuntime();
  const errors: Error[] = [];
  const exits: Array<number | null> = [];
  const controller = new DshController('D:/Repos/rocketchatx', handlers(errors, exits), runtime);

  const starting = controller.start();
  await Promise.resolve();

  const stopping = controller.stop();
  runtime.start.resolve({ processId: 'process-late' });

  await assert.rejects(starting, /DSH 连接已关闭/);
  await stopping;

  assert.deepEqual(runtime.stops, ['process-late']);
  assert.equal(errors.at(-1)?.message, 'DSH 连接已关闭');
  assert.deepEqual(exits, []);
});

test('DSH controller ignores buffered events from other processes before its own process id is known', async () => {
  const runtime = createRuntime();
  const errors: Error[] = [];
  const exits: Array<number | null> = [];
  const controller = new DshController('D:/Repos/rocketchatx', handlers(errors, exits), runtime);

  const starting = controller.start();
  await Promise.resolve();

  runtime.emit('dsh-bridge-output', {
    processId: 'other-process',
    stream: 'stdout',
    line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:4123' }),
  });
  runtime.emit('dsh-bridge-exit', {
    processId: 'other-process',
    code: 9,
  });

  runtime.start.resolve({ processId: 'process-live' });
  runtime.emit('dsh-bridge-output', {
    processId: 'process-live',
    stream: 'stdout',
    line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:5123' }),
  });

  await starting;
  await controller.stop();

  assert.deepEqual(errors, []);
  assert.deepEqual(exits, []);
  assert.deepEqual(parseDshBridgeLine(JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:5123' })), {
    kind: 'ready',
    url: 'http://127.0.0.1:5123',
  });
});
