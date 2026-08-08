import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppServerClient,
  CODEX_APP_SERVER_VERSION,
  codexVersionFromUserAgent,
  type CodexProcessInfo,
  type CodexTransport,
} from '../../apps/web/src/agent/protocol';

class FakeTransport implements CodexTransport {
  writes: Record<string, unknown>[] = [];
  handlers?: Parameters<CodexTransport['start']>[0];
  stopped = false;
  starts = 0;

  constructor(
    private readonly version = CODEX_APP_SERVER_VERSION,
    private readonly runtimeSource: CodexProcessInfo['runtimeSource'] = 'bundled',
  ) {}

  async start(handlers: Parameters<CodexTransport['start']>[0]) {
    this.starts += 1;
    this.handlers = handlers;
    return { processId: 'test-process', version: this.version, runtimeSource: this.runtimeSource };
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
  return (await startClientWithProcess(transport, client, userAgentVersion)).client;
}

async function startClientWithProcess(
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
  const process = await started;
  return { client, process };
}

test('启动返回并缓存实际 Codex 进程来源，手动运行时类型不丢失', async () => {
  const transport = new FakeTransport(CODEX_APP_SERVER_VERSION, 'manual');
  const { client, process } = await startClientWithProcess(transport);
  assert.deepEqual(process, {
    processId: 'test-process',
    version: CODEX_APP_SERVER_VERSION,
    runtimeSource: 'manual',
  });
  assert.deepEqual(await client.start(), process);
  assert.equal(transport.starts, 1);
  assert.deepEqual(transport.writes.map((message) => message.method), ['initialize', 'initialized']);
});

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

test('turn/steer 按协议要求返回 turnId', async () => {
  const transport = new FakeTransport();
  const client = await startClient(transport);

  const response = client.request('turn/steer', {
    threadId: 'thread',
    expectedTurnId: 'turn-1',
    input: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const request = transport.writes.at(-1)!;
  transport.line({ id: request.id, result: { turnId: 'turn-2' } });
  assert.deepEqual(await response, { turnId: 'turn-2' });
});

test('原生 Skill、Goal 与 MCP 方法按协议返回结构校验', async () => {
  const transport = new FakeTransport();
  const client = await startClient(transport);

  const skills = client.request('skills/list', { cwds: ['C:/workspace'] });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({ id: transport.writes.at(-1)!.id, result: { data: [] } });
  assert.deepEqual(await skills, { data: [] });

  const skillConfig = client.request('skills/config/write', {
    path: 'C:/workspace/.agents/skills/example/SKILL.md',
    enabled: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: { effectiveEnabled: false },
  });
  assert.deepEqual(await skillConfig, { effectiveEnabled: false });

  const goal = client.request('thread/goal/set', {
    threadId: 'thread',
    objective: '完成迁移',
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: {
      goal: {
        threadId: 'thread',
        objective: '完成迁移',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  });
  assert.equal((await goal).goal.threadId, 'thread');

  const cleared = client.request('thread/goal/clear', { threadId: 'thread' });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({ id: transport.writes.at(-1)!.id, result: { cleared: true } });
  assert.deepEqual(await cleared, { cleared: true });

  const mcpServers = client.request('mcpServerStatus/list', {
    threadId: 'thread',
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: { data: [], nextCursor: null },
  });
  assert.deepEqual(await mcpServers, { data: [], nextCursor: null });

  const mcpCall = client.request('mcpServer/tool/call', {
    threadId: 'thread',
    server: 'rocketx',
    tool: 'ping',
    arguments: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: { content: [{ type: 'text', text: 'pong' }], isError: false },
  });
  assert.deepEqual(await mcpCall, {
    content: [{ type: 'text', text: 'pong' }],
    isError: false,
  });
});

test('原生 Marketplace 与 Plugin 方法按协议返回结构校验', async () => {
  const transport = new FakeTransport();
  const client = await startClient(transport);

  const marketplace = client.request('marketplace/add', {
    source: 'https://github.com/example/skills',
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: {
      marketplaceName: 'example',
      installedRoot: 'C:/Users/test/.codex/marketplaces/example',
      alreadyAdded: false,
    },
  });
  assert.equal((await marketplace).marketplaceName, 'example');

  const marketplaceRemoval = client.request('marketplace/remove', {
    marketplaceName: 'example',
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: {
      marketplaceName: 'example',
      installedRoot: 'C:/Users/test/.codex/marketplaces/example',
    },
  });
  assert.equal((await marketplaceRemoval).marketplaceName, 'example');

  const plugins = client.request('plugin/list', { cwds: ['C:/workspace'] });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
  });
  assert.deepEqual(await plugins, {
    marketplaces: [],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  });

  const installed = client.request('plugin/installed', { cwds: ['C:/workspace'] });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: { marketplaces: [], marketplaceLoadErrors: [] },
  });
  assert.deepEqual(await installed, { marketplaces: [], marketplaceLoadErrors: [] });

  const detail = client.request('plugin/read', {
    remoteMarketplaceName: 'official',
    pluginName: 'example',
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: { plugin: { summary: { name: 'example' } } },
  });
  assert.equal((await detail).plugin.summary.name, 'example');

  const skill = client.request('plugin/skill/read', {
    remoteMarketplaceName: 'official',
    remotePluginId: 'example',
    skillName: 'example-skill',
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: { contents: '---\nname: example-skill\n---\n' },
  });
  assert.match((await skill).contents ?? '', /example-skill/);

  const install = client.request('plugin/install', {
    remoteMarketplaceName: 'official',
    pluginName: 'example',
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({
    id: transport.writes.at(-1)!.id,
    result: { authPolicy: 'ON_USE', appsNeedingAuth: [] },
  });
  assert.deepEqual(await install, { authPolicy: 'ON_USE', appsNeedingAuth: [] });

  const uninstall = client.request('plugin/uninstall', { pluginId: 'official@example' });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({ id: transport.writes.at(-1)!.id, result: {} });
  assert.deepEqual(await uninstall, {});
});

test('只对实际调用的方法做响应结构与 method not found 能力校验', async () => {
  const transport = new FakeTransport('0.144.5');
  const client = await startClient(transport, new AppServerClient(transport), '0.144.5');

  const invalid = client.request('thread/start', {});
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({ id: transport.writes.at(-1)!.id, result: { thread: {} } });
  await assert.rejects(() => invalid, /thread\/start.*thread\.id/);

  const invalidSteer = client.request('turn/steer', {
    threadId: 'thread',
    expectedTurnId: 'turn-1',
    input: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.line({ id: transport.writes.at(-1)!.id, result: {} });
  await assert.rejects(() => invalidSteer, /turn\/steer.*turnId/);

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
