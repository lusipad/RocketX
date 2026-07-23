import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_APP_SERVER_VERSION,
  type CodexTransport,
} from '../../apps/web/src/agent/protocol';
import {
  setButlerBrainStorage,
  setButlerCodexSettings,
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
} from '../../apps/web/src/lib/butlerBrain';
import {
  setButlerProfileStorage,
  setPersona,
  type ButlerProfileStorage,
} from '../../apps/web/src/lib/butlerProfile';
import { parseButlerMemoryState } from '../../apps/web/src/lib/butlerMemory';
import type { ButlerToolCheckpoint } from '../../apps/web/src/lib/butlerToolRuntime';
import {
  askButlerCodex,
  hydrateResidentCodexThread,
  residentCodexThreadSnapshot,
  resetButlerCodexRuntime,
  runButlerCodexEphemeral,
  setButlerCodexImageMaterializer,
  setButlerCodexTransportFactory,
  setButlerCodexWorkspaceResolver,
  stopButlerCodexTurn,
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

async function resumeThread(transport: FakeTransport, id = 'butler-thread'): Promise<Record<string, unknown>> {
  const request = transport.writes.find((message) => message.method === 'thread/resume');
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
  const restoreBrainStorage = setButlerBrainStorage(new MemoryStorage());
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  setCodexBrainUnavailableReason(undefined);
  return async () => {
    await resetButlerCodexRuntime();
    setCodexBrainUnavailableReason(undefined);
    restorePlatform();
    restoreBrainStorage();
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
    assert.doesNotMatch(
      String(threadParams.baseInstructions),
      /当前时间：/,
      '动态时间不能稳定注入常驻线程 baseInstructions',
    );
    assert.deepEqual(
      (threadParams.dynamicTools as Array<Record<string, unknown>>).map((tool) => tool.name),
      [
        'search_messages',
        'list_mentions',
        'search_people_rooms',
        'list_todos',
        'list_calendar',
        'list_work_items',
        'list_pull_requests',
        'list_builds',
        'recall_memory',
        'load_skill',
        'remember',
        'revoke_memory',
        'restore_memory',
        'import_legacy_memory',
        'draft_routine',
      ],
    );

    const turnStart = await startTurn(transport);
    const turnParams = turnStart.params as Record<string, unknown>;
    assert.equal(turnParams.effort, 'medium');
    assert.equal('runtimeWorkspaceRoots' in turnParams, false);
    const turnInput = String((turnParams.input as Array<Record<string, unknown>>)[0].text);
    assert.match(turnInput, /当前时间：2026-01-05 08:30 周一/);
    assert.match(turnInput, /用户当前所在房间：产品讨论/);
    await completeTurn(transport);

    assert.deepEqual(await asking, { text: '完成。' });
    assert.deepEqual(events, ['content']);
  } finally {
    await restore();
  }
});

test('Codex 管家把用户图片写入当前会话并作为 localImage 输入', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  const materialized: Array<{ sessionId: string; names: string[] }> = [];
  const restoreImages = setButlerCodexImageMaterializer(async (sessionId, images) => {
    materialized.push({ sessionId, names: images.map((image) => image.name) });
    return ['C:/RocketX/AppData/butler/screenshot.png'];
  });
  try {
    const asking = askButlerCodex({
      text: '分析截图',
      images: [{
        name: 'screenshot.png',
        type: 'image/png',
        size: 5,
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
      }],
    });
    const transport = await transportAt(transports, 0);
    await initialize(transport);
    await startThread(transport);
    const turnStart = await startTurn(transport);
    const input = (turnStart.params as Record<string, unknown>).input as Array<Record<string, unknown>>;
    assert.equal(input[0].type, 'text');
    assert.match(String(input[0].text), /分析截图/);
    assert.deepEqual(input[0].text_elements, []);
    assert.deepEqual(input[1], {
      type: 'localImage',
      path: 'C:/RocketX/AppData/butler/screenshot.png',
    });
    assert.equal(materialized.length, 1);
    assert.deepEqual(materialized[0].names, ['screenshot.png']);
    assert.match(materialized[0].sessionId, /^butler-/);
    await completeTurn(transport);
    assert.deepEqual(await asking, { text: '完成。' });
  } finally {
    restoreImages();
    await restore();
  }
});

test('用户配置的 Codex 模型与推理强度进入管家线程', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  try {
    setButlerCodexSettings({ model: 'gpt-5.4', effort: 'high' });
    const asking = askButlerCodex({ text: '总结今天' });
    const transport = await transportAt(transports, 0);
    await initialize(transport);
    const threadStart = await startThread(transport);
    assert.equal((threadStart.params as Record<string, unknown>).model, 'gpt-5.4');
    const turnStart = await startTurn(transport);
    assert.equal((turnStart.params as Record<string, unknown>).effort, 'high');
    await completeTurn(transport);
    assert.deepEqual(await asking, { text: '完成。' });
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

test('Codex 动态 memory 工具暴露 typed 合同，写入前只生成审批 checkpoint', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  const profile = new MemoryStorage();
  const restoreProfile = setButlerProfileStorage(profile);
  const checkpoints = new Map<string, ButlerToolCheckpoint>();
  try {
    const asking = askButlerCodex({
      text: '记住我偏好简短回复',
      toolRuntimeContext: (toolCall) => ({
        taskId: 'task-codex-write',
        callId: toolCall.id,
        sessionId: 'session-codex-write',
        now: () => Date.UTC(2026, 6, 23, 9, 30),
        scope: {
          server: 'https://chat.example',
          account: 'alice',
        },
        loadCheckpoint: (id) => checkpoints.get(id),
        saveCheckpoint: (checkpoint) => checkpoints.set(checkpoint.id, checkpoint),
        requestApproval: () => undefined,
        writeAudit: () => undefined,
      }),
    });
    const transport = await transportAt(transports, 0);
    await initialize(transport);
    await startThread(transport);
    await startTurn(transport);

    transport.line({
      id: 81,
      method: 'item/tool/call',
      params: {
        threadId: 'butler-thread',
        turnId: 'butler-turn',
        callId: 'remember-1',
        namespace: null,
        tool: 'remember',
        arguments: {
          kind: 'preference',
          scope: 'account',
          subject: 'reply-style',
          value: '默认简短回复',
        },
      },
    });
    await tick();

    const response = transport.writes.find((message) => message.id === 81);
    assert.match(JSON.stringify(response), /approval-required.*尚未执行/);
    assert.deepEqual([...checkpoints.values()].map((checkpoint) => ({
      status: checkpoint.status,
      params: checkpoint.params,
    })), [{
      status: 'approval-required',
      params: {
        kind: 'preference',
        scope: 'account',
        subject: 'reply-style',
        value: '默认简短回复',
        trustedScope: {
          server: 'https://chat.example',
          account: 'alice',
        },
        capturedProvenance: {
          sessionId: 'session-codex-write',
          taskId: 'task-codex-write',
          callId: 'remember-1',
          butlerSource: 'butler:user-confirmed',
          summary: '用户在当前 Butler 会话中直接确认',
        },
        capturedAt: [...checkpoints.values()][0]?.createdAt,
      },
    }]);
    assert.equal(parseButlerMemoryState(profile.get('rcx-butler-v2:memory') ?? '').records.length, 0);

    await completeTurn(transport);
    await asking;
  } finally {
    restoreProfile();
    await restore();
  }
});

test('人设提示变化会停止旧线程，并在下一问前重建', async () => {
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

test('Codex 模型或推理强度变化会停止旧线程，并在下一问前重建', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  try {
    const first = askButlerCodex({ text: '第一问' });
    const firstTransport = await transportAt(transports, 0);
    await initialize(firstTransport);
    await startThread(firstTransport);
    await startTurn(firstTransport);
    await completeTurn(firstTransport);
    await first;

    setButlerCodexSettings({ model: 'gpt-5.4', effort: 'high' });
    const second = askButlerCodex({ text: '第二问' });
    assert.equal(firstTransport.stopped, true);
    const secondTransport = await transportAt(transports, 1);
    await initialize(secondTransport);
    const threadStart = await startThread(secondTransport, 'configured-thread');
    assert.equal((threadStart.params as Record<string, unknown>).model, 'gpt-5.4');
    const turnStart = await startTurn(secondTransport, 'configured-turn');
    assert.equal((turnStart.params as Record<string, unknown>).effort, 'high');
    await completeTurn(secondTransport, 'configured-thread', 'configured-turn');
    await second;
    assert.equal(transports.length, 2);
  } finally {
    await restore();
  }
});

test('resume 失败重建线程时，重建后首轮 turn input 带 fallbackTranscript，thread start 保持既有协议字段', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  let asking: Promise<{ text: string }> | undefined;
  try {
    const first = askButlerCodex({ text: '第一问' });
    const firstTransport = await transportAt(transports, 0);
    await initialize(firstTransport);
    await startThread(firstTransport, 'persisted-thread');
    await startTurn(firstTransport, 'persisted-turn');
    await completeTurn(firstTransport, 'persisted-thread', 'persisted-turn', '第一答');
    await first;

    const snapshot = residentCodexThreadSnapshot();
    assert.deepEqual(snapshot, { threadId: 'persisted-thread', promptHash: snapshot?.promptHash });

    await resetButlerCodexRuntime();
    hydrateResidentCodexThread(snapshot!.threadId, snapshot!.promptHash);

    asking = askButlerCodex({
      text: '第二问',
      fallbackTranscript: [
        { revision: 1, role: 'user', text: '第一问' },
        { revision: 2, role: 'assistant', text: '第一答' },
      ],
    });
    const secondTransport = await transportAt(transports, 1);
    await initialize(secondTransport);

    const resumeRequest = secondTransport.writes.find((message) => message.method === 'thread/resume');
    assert.ok(resumeRequest);
    secondTransport.line({
      id: resumeRequest.id,
      error: { code: -32000, message: 'resume failed' },
    });
    await tick();

    const rebuiltTransport = await transportAt(transports, 2);
    await initialize(rebuiltTransport);
    assert.equal(secondTransport.stopped, true);
    const threadStart = await startThread(rebuiltTransport, 'rebuilt-thread');
    const threadParams = threadStart.params as Record<string, unknown>;
    assert.equal('fallbackTranscript' in threadParams, false);
    assert.equal(threadParams.cwd, 'C:/RocketX/AppData/butler');
    assert.equal(threadParams.sandbox, 'read-only');

    const turnStart = await startTurn(rebuiltTransport, 'rebuilt-turn');
    const turnInput = String(((turnStart.params as Record<string, unknown>).input as Array<Record<string, unknown>>)[0].text);
    assert.match(turnInput, /第一问/);
    assert.match(turnInput, /第一答/);
    assert.match(turnInput, /第二问/);
    await completeTurn(rebuiltTransport, 'rebuilt-thread', 'rebuilt-turn');

    assert.deepEqual(await asking, { text: '完成。' });
  } finally {
    await Promise.allSettled(asking ? [asking] : []);
    await restore();
  }
});

test('新建线程的首轮 turn input 也带 fallbackTranscript，thread start 保持既有协议字段', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  let asking: Promise<{ text: string }> | undefined;
  try {
    asking = askButlerCodex({
      text: '现在的问题',
      fallbackTranscript: [
        { revision: 1, role: 'user', text: '历史问题' },
        { revision: 2, role: 'assistant', text: '历史回答' },
      ],
    });
    const transport = await transportAt(transports, 0);
    await initialize(transport);
    const threadStart = await startThread(transport);
    const threadParams = threadStart.params as Record<string, unknown>;
    assert.equal('fallbackTranscript' in threadParams, false);
    assert.equal(threadParams.cwd, 'C:/RocketX/AppData/butler');
    assert.equal(threadParams.sandbox, 'read-only');
    const turnStart = await startTurn(transport);
    const turnInput = String(((turnStart.params as Record<string, unknown>).input as Array<Record<string, unknown>>)[0].text);
    assert.match(turnInput, /历史问题/);
    assert.match(turnInput, /历史回答/);
    assert.match(turnInput, /现在的问题/);
    await completeTurn(transport);
    assert.deepEqual(await asking, { text: '完成。' });
  } finally {
    await Promise.allSettled(asking ? [asking] : []);
    await restore();
  }
});

test('thread start 或 resume 未完成且尚无 turnId 时，stop 仍让 ask 安静结束且不启动 turn', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  try {
    const asking = askButlerCodex({ text: '未启动 turn 的停止' });
    const transport = await transportAt(transports, 0);
    await initialize(transport);
    await stopButlerCodexTurn();
    transport.line({
      id: (transport.writes.find((message) => message.method === 'thread/start') as Record<string, unknown>).id,
      result: { thread: { id: 'late-thread', cliVersion: CODEX_APP_SERVER_VERSION } },
    });
    await tick();

    assert.equal(transport.writes.some((message) => message.method === 'turn/start'), false);
    assert.deepEqual(await Promise.race([
      asking,
      new Promise((_, reject) => setTimeout(() => reject(new Error('ask did not settle after stop before turn start')), 80)),
    ]), { text: '' });
  } finally {
    await restore();
  }
});

test('thread 已就绪但 turn/start 尚未发送时，stop 仍阻止迟到 turn', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  try {
    const asking = askButlerCodex({ text: '线程刚就绪时停止' });
    const transport = await transportAt(transports, 0);
    await initialize(transport);
    const threadStart = transport.writes.find((message) => message.method === 'thread/start');
    assert.ok(threadStart);
    transport.line({
      id: threadStart.id,
      result: { thread: { id: 'ready-thread', cliVersion: CODEX_APP_SERVER_VERSION } },
    });
    const stopping = new Promise<void>((resolve) => {
      queueMicrotask(() => void stopButlerCodexTurn().then(resolve));
    });
    await stopping;
    await tick();

    assert.equal(transport.writes.some((message) => message.method === 'turn/start'), false);
    assert.deepEqual(await Promise.race([
      asking,
      new Promise((_, reject) => setTimeout(() => reject(new Error('ask did not settle after stop before turn request')), 80)),
    ]), { text: '' });
  } finally {
    await restore();
  }
});

test('ephemeral workflow 收到暂停信号时中断当前 Codex turn 并停止 transport', async () => {
  const transports: FakeTransport[] = [];
  const restore = testRuntime(transports);
  const controller = new AbortController();

  try {
    const running = runButlerCodexEphemeral({
      text: '生成晨报',
      signal: controller.signal,
    });
    const transport = await transportAt(transports, 0);
    await initialize(transport);
    await startThread(transport, 'workflow-thread');
    await startTurn(transport, 'workflow-turn');

    controller.abort(new Error('用户暂停 workflow'));

    await assert.rejects(running, /用户暂停 workflow/);
    await tick();
    assert.deepEqual(
      transport.writes.find((message) => message.method === 'turn/interrupt')?.params,
      { threadId: 'workflow-thread', turnId: 'workflow-turn' },
    );
    assert.equal(transport.stopped, true);
  } finally {
    await restore();
  }
});
