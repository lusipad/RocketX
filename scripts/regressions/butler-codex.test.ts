import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_APP_SERVER_VERSION,
  type CodexTransport,
} from '../../apps/web/src/agent/protocol';
import {
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
} from '../../apps/web/src/lib/butlerBrain';
import {
  setButlerProfileStorage,
  setPersona,
  type ButlerProfileStorage,
} from '../../apps/web/src/lib/butlerProfile';
import {
  askButlerCodex,
  resetButlerCodexRuntime,
  setButlerCodexTransportFactory,
  setButlerCodexWorkspaceResolver,
} from '../../apps/web/src/stores/butlerCodex';

class FakeTransport implements CodexTransport {
  writes: Record<string, unknown>[] = [];
  handlers?: Parameters<CodexTransport['start']>[0];
  stopped = false;

  async start(handlers: Parameters<CodexTransport['start']>[0]) {
    this.handlers = handlers;
    return { processId: 'butler-test-process', version: CODEX_APP_SERVER_VERSION };
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

class MemoryStorage implements ButlerProfileStorage {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function transportAt(transports: FakeTransport[], index: number): Promise<FakeTransport> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const transport = transports[index];
    if (transport) return transport;
    await tick();
  }
  throw new Error(`未创建第 ${index + 1} 个假 Codex transport`);
}

async function initialize(transport: FakeTransport): Promise<void> {
  await tick();
  const request = transport.writes.find((message) => message.method === 'initialize');
  assert.ok(request);
  transport.line({
    id: request.id,
    result: {
      userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} (Windows)`,
      codexHome: 'C:/Users/test/.codex',
      platformFamily: 'windows',
      platformOs: 'windows',
    },
  });
  await tick();
}

async function startThread(transport: FakeTransport, id = 'butler-thread'): Promise<Record<string, unknown>> {
  const request = transport.writes.find((message) => message.method === 'thread/start');
  assert.ok(request);
  transport.line({ id: request.id, result: { thread: { id, cliVersion: CODEX_APP_SERVER_VERSION } } });
  await tick();
  return request;
}

async function startTurn(transport: FakeTransport, id = 'butler-turn'): Promise<Record<string, unknown>> {
  const request = transport.writes.find((message) => message.method === 'turn/start');
  assert.ok(request);
  transport.line({ id: request.id, result: { turn: { id } } });
  await tick();
  return request;
}

async function completeTurn(transport: FakeTransport, threadId = 'butler-thread', turnId = 'butler-turn', text = '完成。'): Promise<void> {
  transport.line({ method: 'item/agentMessage/delta', params: { threadId, turnId, delta: text } });
  transport.line({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  await tick();
}

function testRuntime(transports: FakeTransport[]) {
  const restoreTransport = setButlerCodexTransportFactory(() => {
    const transport = new FakeTransport();
    transports.push(transport);
    return transport;
  });
  const restoreWorkspace = setButlerCodexWorkspaceResolver(async () => 'C:/RocketX/AppData/butler');
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  setCodexBrainUnavailableReason(undefined);
  return async () => {
    await resetButlerCodexRuntime();
    setCodexBrainUnavailableReason(undefined);
    restorePlatform();
    restoreWorkspace();
    restoreTransport();
  };
}

test('常驻管家线程使用只读沙箱、无仓库 roots、dynamicTools 和 medium 推理档', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  const events: string[] = [];
  try {
    const asking = askButlerCodex({
      text: '看一下待办',
      context: { rid: 'room-1', roomName: '产品讨论' },
      now: new Date(2026, 0, 5, 8, 30).getTime(),
      onEvent: (event) => events.push(event.type),
    });
    const transport = await transportAt(transports, 0);
    await initialize(transport);
    const threadStart = await startThread(transport);
    const threadParams = threadStart.params as Record<string, unknown>;
    assert.equal(threadParams.cwd, 'C:/RocketX/AppData/butler');
    assert.equal(threadParams.sandbox, 'read-only');
    assert.equal('runtimeWorkspaceRoots' in threadParams, false);
    assert.match(String(threadParams.baseInstructions), /当前时间：2026-01-05 08:30 周一/);
    assert.deepEqual(
      (threadParams.dynamicTools as Array<Record<string, unknown>>).map((tool) => tool.name),
      ['search_messages', 'search_people_rooms', 'list_todos', 'list_calendar', 'list_work_items', 'list_pull_requests', 'list_builds', 'load_skill', 'remember', 'draft_routine'],
    );

    const turnStart = await startTurn(transport);
    const turnParams = turnStart.params as Record<string, unknown>;
    assert.equal(turnParams.effort, 'medium');
    assert.equal('runtimeWorkspaceRoots' in turnParams, false);
    assert.match(String((turnParams.input as Array<Record<string, unknown>>)[0].text), /用户当前所在房间：产品讨论/);
    await completeTurn(transport);

    assert.deepEqual(await asking, { text: '完成。' });
    assert.deepEqual(events, ['content']);
  } finally {
    await restore();
  }
});

test('动态工具仅执行当前线程已注册工具，并按 Spike D 格式应答', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  const events: Array<{ type: string; value?: string }> = [];
  try {
    const asking = askButlerCodex({
      text: '查待办',
      onEvent: (event) => events.push({ type: event.type, value: event.type === 'tool-call' ? event.toolCall.name : undefined }),
    });
    const transport = await transportAt(transports, 0);
    await initialize(transport);
    await startThread(transport);
    await startTurn(transport);

    transport.line({
      id: 71,
      method: 'item/tool/call',
      params: { threadId: 'butler-thread', turnId: 'butler-turn', callId: 'call-1', namespace: null, tool: 'list_todos', arguments: {} },
    });
    transport.line({
      id: 72,
      method: 'item/tool/call',
      params: { threadId: 'butler-thread', turnId: 'butler-turn', callId: 'call-2', namespace: null, tool: 'not_registered', arguments: {} },
    });
    transport.line({
      id: 73,
      method: 'item/tool/call',
      params: { threadId: 'other-thread', turnId: 'butler-turn', callId: 'call-3', namespace: null, tool: 'list_todos', arguments: {} },
    });
    transport.line({ id: 74, method: 'execCommandApproval', params: { threadId: 'butler-thread' } });
    // 无参调用允许缺省 arguments 字段。
    transport.line({
      id: 75,
      method: 'item/tool/call',
      params: { threadId: 'butler-thread', turnId: 'butler-turn', callId: 'call-4', namespace: null, tool: 'list_todos' },
    });
    await tick();

    assert.deepEqual(transport.writes.find((message) => message.id === 71), {
      id: 71,
      result: { contentItems: [{ type: 'inputText', text: '[]' }], success: true },
    });
    assert.match(String((transport.writes.find((message) => message.id === 72)?.error as { message?: string }).message), /未注册/);
    assert.match(String((transport.writes.find((message) => message.id === 73)?.error as { message?: string }).message), /不属于当前/);
    assert.match(String((transport.writes.find((message) => message.id === 74)?.error as { message?: string }).message), /无执行权限/);
    assert.deepEqual(transport.writes.find((message) => message.id === 75), {
      id: 75,
      result: { contentItems: [{ type: 'inputText', text: '[]' }], success: true },
    });
    // 两个调用在同一 tick 到达：tool-call 事件先于异步执行完成的 tool-result。
    assert.deepEqual(events.map((event) => event.type), ['tool-call', 'tool-call', 'tool-result', 'tool-result']);

    await completeTurn(transport);
    await asking;
  } finally {
    await restore();
  }
});

test('人设或记忆提示变化会停止旧线程，并在下一问前重建', async () => {
  const transports: FakeTransport[] = [];
  const restoreRuntime = testRuntime(transports);
  const restoreProfile = setButlerProfileStorage(new MemoryStorage());
  try {
    const first = askButlerCodex({ text: '第一问' });
    const firstTransport = await transportAt(transports, 0);
    await initialize(firstTransport);
    await startThread(firstTransport);
    await startTurn(firstTransport);
    await completeTurn(firstTransport);
    await first;

    setPersona('新的管家人设。');
    const second = askButlerCodex({ text: '第二问' });
    assert.equal(firstTransport.stopped, true);
    const secondTransport = await transportAt(transports, 1);
    await initialize(secondTransport);
    await startThread(secondTransport, 'rebuilt-thread');
    await startTurn(secondTransport, 'rebuilt-turn');
    await completeTurn(secondTransport, 'rebuilt-thread', 'rebuilt-turn');
    await second;
    assert.equal(transports.length, 2);
  } finally {
    restoreProfile();
    await restoreRuntime();
  }
});
