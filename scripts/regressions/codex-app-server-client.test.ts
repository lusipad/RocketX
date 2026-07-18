import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppServerClient,
  CODEX_APP_SERVER_VERSION,
  codexVersionFromUserAgent,
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

async function startClient(
  transport: FakeTransport,
  client = new AppServerClient(transport),
  userAgentVersion = CODEX_APP_SERVER_VERSION,
) {
  const started = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.writes[0].method, 'initialize');
  transport.line({
    id: transport.writes[0].id,
    result: {
      userAgent: `Codex Desktop/${userAgentVersion} (Windows)`,
      codexHome: 'C:/Users/test/.codex',
      platformFamily: 'windows',
      platformOs: 'windows',
    },
  });
  await started;
  return client;
}

test('初始化按握手能力校验，不因协议内容相同的 CLI 补丁版本而拒绝', async () => {
  const transport = new FakeTransport();
  await startClient(transport);
  assert.deepEqual(transport.writes.map((message) => message.method), ['initialize', 'initialized']);

  const patchVersion = new FakeTransport('0.144.5');
  await startClient(patchVersion, new AppServerClient(patchVersion), '0.144.5');
  assert.equal(patchVersion.stopped, false);

  const inconsistent = new FakeTransport('0.144.5');
  await assert.rejects(
    () => startClient(inconsistent, new AppServerClient(inconsistent), '0.144.4'),
    /握手版本不一致/,
  );
  assert.equal(inconsistent.stopped, true);
});

test('兼容性检查接受已验证的 Linux Runner userAgent', () => {
  assert.equal(
    codexVersionFromUserAgent(`rocketx/${CODEX_APP_SERVER_VERSION} (Debian 12.0.0; x86_64)`),
    CODEX_APP_SERVER_VERSION,
  );
  assert.equal(codexVersionFromUserAgent(`other/${CODEX_APP_SERVER_VERSION} (Linux)`), null);
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

test('只对实际调用的方法做响应结构与 method not found 能力校验', async () => {
  const transport = new FakeTransport('0.144.5');
  const client = await startClient(transport, new AppServerClient(transport), '0.144.5');

  const invalid = client.request('thread/start', {});
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({ id: transport.writes.at(-1)!.id, result: { thread: {} } });
  await assert.rejects(() => invalid, /thread\/start.*thread\.id/);

  const missing = client.request('thread/resume', { threadId: 'thread' });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({ id: transport.writes.at(-1)!.id, error: { code: -32601, message: 'Method not found' } });
  await assert.rejects(() => missing, /不支持 RocketX 所需方法：thread\/resume/);
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
