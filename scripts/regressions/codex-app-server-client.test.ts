import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppServerClient,
  CODEX_APP_SERVER_VERSION,
  type CodexTransport,
} from '../../apps/web/src/agent/protocol';

class FakeTransport implements CodexTransport {
  writes: Record<string, unknown>[] = [];
  handlers?: Parameters<CodexTransport['start']>[0];
  stopped = false;

  constructor(private readonly version = CODEX_APP_SERVER_VERSION) {}

  async start(handlers: Parameters<CodexTransport['start']>[0]) {
    this.handlers = handlers;
    return { processId: 'test-process', version: this.version };
  }

  async write(message: Record<string, unknown>) {
    this.writes.push(message);
  }

  async stop() {
    this.stopped = true;
  }

  line(message: Record<string, unknown>) {
    this.handlers?.onLine(JSON.stringify(message));
  }
}

async function startClient(transport: FakeTransport, client = new AppServerClient(transport)) {
  const started = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.writes[0].method, 'initialize');
  transport.line({
    id: transport.writes[0].id,
    result: {
      userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} (Windows)`,
      codexHome: 'C:/Users/test/.codex',
      platformFamily: 'windows',
      platformOs: 'windows',
    },
  });
  await started;
  return client;
}

test('初始化严格校验 CLI 和 userAgent 版本后才发送 initialized', async () => {
  const transport = new FakeTransport();
  await startClient(transport);
  assert.deepEqual(transport.writes.map((message) => message.method), ['initialize', 'initialized']);

  const incompatible = new FakeTransport('0.144.2');
  await assert.rejects(() => new AppServerClient(incompatible).start(), /CLI 版本不兼容/);
  assert.equal(incompatible.stopped, true);
});

test('客户端请求按 id 关联响应', async () => {
  const transport = new FakeTransport();
  const client = await startClient(transport);
  const response = client.request('turn/interrupt', { threadId: 'thread', turnId: 'turn' });
  await new Promise((resolve) => setImmediate(resolve));
  const request = transport.writes.at(-1)!;
  transport.line({ id: request.id, result: {} });
  assert.deepEqual(await response, {});
});

test('当前时间本地响应，未知和无 UI 的已知请求均安全拒绝', async () => {
  const transport = new FakeTransport();
  await startClient(transport);
  transport.line({ id: 90, method: 'currentTime/read', params: { threadId: 'thread' } });
  transport.line({ id: 91, method: 'future/dangerous/request', params: {} });
  transport.line({ id: 92, method: 'item/commandExecution/requestApproval', params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transport.writes.at(-3), {
    id: 90,
    result: { currentTimeAt: Math.floor(Date.now() / 1000) },
  });
  assert.deepEqual(transport.writes.at(-2), {
    id: 91,
    error: { code: -32601, message: 'Unsupported request: future/dangerous/request' },
  });
  assert.deepEqual(transport.writes.at(-1), {
    id: 92,
    error: {
      code: -32001,
      message: 'Request denied by RocketX: item/commandExecution/requestApproval',
    },
  });
});

test('进程退出会拒绝所有在途请求并标记中断', async () => {
  const transport = new FakeTransport();
  let interrupted = '';
  const client = await startClient(
    transport,
    new AppServerClient(transport, { onInterrupted: (error) => (interrupted = error.message) }),
  );
  const pending = client.request('turn/interrupt', { threadId: 'thread', turnId: 'turn' });
  transport.handlers?.onExit(137);
  await assert.rejects(() => pending, /已退出（137）/);
  assert.match(interrupted, /已退出（137）/);
});
