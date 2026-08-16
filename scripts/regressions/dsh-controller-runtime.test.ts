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

interface StartResult {
  processId: string;
  leaseId?: string;
  readyUrl?: string;
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
  const starts: Array<ReturnType<typeof deferred<StartResult>>> = [];
  const queuedStarts: Array<StartResult | undefined> = [];
  const listeners = new Map<EventName, Set<(event: { payload: unknown }) => void>>();
  const stops: string[] = [];
  const stopArgs: Array<Record<string, unknown> | undefined> = [];
  const startArgs: Array<Record<string, unknown> | undefined> = [];
  const writes: Array<Record<string, unknown>> = [];

  function emit<K extends EventName>(event: K, payload: RuntimeEventMap[K]) {
    for (const handler of listeners.get(event) ?? []) handler({ payload });
  }

  return {
    stops,
    stopArgs,
    startArgs,
    writes,
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (command === 'dsh_bridge_start') {
        const index = startArgs.length;
        const start = deferred<StartResult>();
        starts.push(start);
        startArgs.push(args);
        const queued = queuedStarts[index];
        if (queued) {
          start.resolve(queued);
          queuedStarts[index] = undefined;
        }
        return start.promise as Promise<T>;
      }
      if (command === 'dsh_bridge_stop') {
        stopArgs.push(args);
        stops.push(String(args?.processId ?? ''));
        return undefined as T;
      }
      if (command === 'dsh_bridge_write') {
        const payload = args ?? {};
        writes.push(payload);
        const processId = String(payload.processId ?? '');
        const message = (payload.message ?? {}) as Record<string, unknown>;
        const id = String(message.id ?? 'missing-id');
        const op = message.kind === 'respond' ? 'respond' : 'call';
        queueMicrotask(() => {
          const response = op === 'respond'
            ? { accepted: true }
            : {
              type: 'server-response',
              rpcId: id,
              result: { ok: true, value: { method: message.method ?? null } },
            };
          emit('dsh-bridge-output', {
            processId,
            stream: 'stdout',
            line: JSON.stringify({ kind: 'response', id, op, response }),
          });
        });
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
    emit,
    resolveStart(index: number, result: StartResult) {
      const start = starts[index];
      if (!start) {
        queuedStarts[index] = result;
        return;
      }
      start.resolve(result);
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

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs = 50,
): Promise<{ status: 'fulfilled'; value: T } | { status: 'pending' }> {
  return await new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      resolve({ status: 'pending' as const });
    }, timeoutMs);
    void promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve({ status: 'fulfilled' as const, value });
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitFor(check: () => boolean, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition did not pass within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('DSH controller stops a bridge that resolves after the caller already closed it', async () => {
  const runtime = createRuntime();
  const errors: Error[] = [];
  const exits: Array<number | null> = [];
  const controller = new DshController('D:/Repos/rocketchatx', handlers(errors, exits), runtime);

  const starting = controller.start();
  await waitFor(() => runtime.startArgs.length === 1);

  const stopping = controller.stop();
  runtime.resolveStart(0, { processId: 'process-late', leaseId: 'lease-late' });

  await assert.rejects(starting, /DSH 连接已关闭/);
  await stopping;

  assert.deepEqual(runtime.stops, ['process-late']);
  assert.deepEqual(errors, []);
  assert.deepEqual(exits, []);
});

test('DSH controller ignores buffered events from other processes before its own process id is known', async () => {
  const runtime = createRuntime();
  const errors: Error[] = [];
  const exits: Array<number | null> = [];
  const controller = new DshController('D:/Repos/rocketchatx', handlers(errors, exits), runtime);

  const starting = controller.start();
  await waitFor(() => runtime.startArgs.length === 1);

  runtime.emit('dsh-bridge-output', {
    processId: 'other-process',
    stream: 'stdout',
    line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:4123' }),
  });
  runtime.emit('dsh-bridge-exit', {
    processId: 'other-process',
    code: 9,
  });

  runtime.resolveStart(0, { processId: 'process-live', leaseId: 'lease-live' });
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
    url: 'http://127.0.0.1:5123/',
  });
});

test('DSH controller web mode returns the strict localhost URL and preserves the logical web lease mode', async () => {
  const runtime = createRuntime();
  const controller = new DshController(
    'D:/Repos/rocketchatx',
    handlers([], []),
    runtime,
    { connectionId: 'butler-web', mode: 'web' },
  );

  const starting = controller.start();
  await waitFor(() => runtime.startArgs.length === 1);
  runtime.resolveStart(0, { processId: 'process-web', leaseId: 'lease-web' });
  runtime.emit('dsh-bridge-output', {
    processId: 'process-web',
    stream: 'stdout',
    line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:6123/' }),
  });

  assert.equal(await starting, 'http://127.0.0.1:6123/');
  assert.deepEqual(runtime.startArgs, [{
    connectionId: 'butler-web',
    workspaceRoot: 'D:/Repos/rocketchatx',
    mode: 'web',
  }]);

  await controller.stop();
});

test('DSH controller controller mode rejects invalid ready URLs', async () => {
  const errors: Error[] = [];
  const runtime = createRuntime();
  const controller = new DshController('D:/Repos/rocketchatx', handlers(errors, []), runtime);

  const starting = controller.start();
  await waitFor(() => runtime.startArgs.length === 1);
  runtime.resolveStart(0, { processId: 'process-invalid', leaseId: 'lease-invalid' });
  runtime.emit('dsh-bridge-output', {
    processId: 'process-invalid',
    stream: 'stdout',
    line: JSON.stringify({ kind: 'ready', url: 'http://0.0.0.0:6123/' }),
  });

  await assert.rejects(starting, /DSH bridge 返回了无效 ready URL/);
  assert.equal(errors.at(-1)?.message, 'DSH bridge 返回了无效 ready URL');
  assert.deepEqual(runtime.stops, ['process-invalid']);
});

test('DSH controller web mode blocks call and respond misuse', async () => {
  const runtime = createRuntime();
  const controller = new DshController(
    'D:/Repos/rocketchatx',
    handlers([], []),
    runtime,
    { mode: 'web' },
  );

  const starting = controller.start();
  await waitFor(() => runtime.startArgs.length === 1);
  runtime.resolveStart(0, { processId: 'process-web', leaseId: 'lease-web' });
  runtime.emit('dsh-bridge-output', {
    processId: 'process-web',
    stream: 'stdout',
    line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:7123/' }),
  });
  await starting;

  await assert.rejects(() => controller.call('host.describe'), /web 模式不支持 call/);
  await assert.rejects(
    () => controller.respond({ type: 'client-response', rpcId: 'x', result: { ok: true, value: {} } }),
    /web 模式不支持 respond/,
  );
  assert.deepEqual(runtime.writes, []);

  await controller.stop();
});

test('DSH controllers reuse one shared bridge across connection leases, keep per-lease stop, and namespace request ids', async () => {
  const runtime = createRuntime();
  const first = new DshController(
    'D:/Repos/rocketchatx',
    handlers([], []),
    runtime,
    { connectionId: 'conn-alpha' },
  );
  const second = new DshController(
    'D:/Repos/rocketchatx',
    handlers([], []),
    runtime,
    { connectionId: 'conn-beta' },
  );
  try {
    const firstStart = first.start();
    await waitFor(() => runtime.startArgs.length === 1);
    runtime.resolveStart(0, { processId: 'process-shared', leaseId: 'lease-alpha' });
    runtime.emit('dsh-bridge-output', {
      processId: 'process-shared',
      stream: 'stdout',
      line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:8123/' }),
    });
    assert.equal(await firstStart, 'http://127.0.0.1:8123/');
    const secondStart = second.start();
    await waitFor(() => runtime.startArgs.length === 2);
    runtime.resolveStart(1, {
      processId: 'process-shared',
      leaseId: 'lease-beta',
      readyUrl: 'http://127.0.0.1:8123/',
    });
    const secondOutcome = await settleWithin(secondStart);
    if (secondOutcome.status === 'pending') {
      runtime.emit('dsh-bridge-output', {
        processId: 'process-shared',
        stream: 'stdout',
        line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:8123/' }),
      });
      await secondStart;
    }
    assert.deepEqual(secondOutcome, {
      status: 'fulfilled',
      value: 'http://127.0.0.1:8123/',
    });

    await first.call('host.describe');
    await second.call('session.create');
    assert.match(String(runtime.writes[0]?.message?.id ?? ''), /conn-alpha/);
    assert.match(String(runtime.writes[1]?.message?.id ?? ''), /conn-beta/);

    await first.stop();
    assert.deepEqual(runtime.stopArgs[0], {
      processId: 'process-shared',
      leaseId: 'lease-alpha',
    });

    await second.call('session.history');
    await second.stop();
    assert.deepEqual(runtime.stopArgs[1], {
      processId: 'process-shared',
      leaseId: 'lease-beta',
    });
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
  }
});

test('DSH controllers with the same connection id release only their own lease ids', async () => {
  const runtime = createRuntime();
  const first = new DshController(
    'D:/Repos/rocketchatx',
    handlers([], []),
    runtime,
    { connectionId: 'strict-room' },
  );
  const second = new DshController(
    'D:/Repos/rocketchatx',
    handlers([], []),
    runtime,
    { connectionId: 'strict-room' },
  );
  try {
    const firstStart = first.start();
    await waitFor(() => runtime.startArgs.length === 1);
    runtime.resolveStart(0, { processId: 'process-shared', leaseId: 'lease-old' });
    runtime.emit('dsh-bridge-output', {
      processId: 'process-shared',
      stream: 'stdout',
      line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:9123/' }),
    });
    assert.equal(await firstStart, 'http://127.0.0.1:9123/');
    const secondStart = second.start();
    await waitFor(() => runtime.startArgs.length === 2);
    runtime.resolveStart(1, {
      processId: 'process-shared',
      leaseId: 'lease-new',
      readyUrl: 'http://127.0.0.1:9123/',
    });
    const secondOutcome = await settleWithin(secondStart);
    if (secondOutcome.status === 'pending') {
      runtime.emit('dsh-bridge-output', {
        processId: 'process-shared',
        stream: 'stdout',
        line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:9123/' }),
      });
      await secondStart;
    }
    assert.deepEqual(secondOutcome, {
      status: 'fulfilled',
      value: 'http://127.0.0.1:9123/',
    });

    await first.stop();
    assert.deepEqual(runtime.stopArgs[0], {
      processId: 'process-shared',
      leaseId: 'lease-old',
    });

    await second.call('host.describe');
    await second.stop();
    assert.deepEqual(runtime.stopArgs[1], {
      processId: 'process-shared',
      leaseId: 'lease-new',
    });
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
  }
});
