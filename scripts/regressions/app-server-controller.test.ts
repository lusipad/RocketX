import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppServerController,
  permissionSettings,
} from '../../apps/web/src/agent/AppServerController';
import {
  CODEX_APP_SERVER_VERSION,
  type CodexTransport,
} from '../../apps/web/src/agent/protocol';
import { registerScheduledTaskAdapter } from '../../apps/web/src/agent/scheduledTaskBridge';
import { useTodos } from '../../apps/web/src/stores/todos';

class FakeTransport implements CodexTransport {
  writes: Record<string, unknown>[] = [];
  handlers?: Parameters<CodexTransport['start']>[0];
  starts = 0;
  stops = 0;

  constructor(private readonly runtimeWorkspaceRoot?: string) {}

  async start(handlers: Parameters<CodexTransport['start']>[0]) {
    this.starts += 1;
    this.handlers = handlers;
    return {
      processId: 'controller-test',
      version: CODEX_APP_SERVER_VERSION,
      runtimeSource: 'bundled' as const,
      managedSkillRoots: ['D:/rocketx-skills'],
      ...(this.runtimeWorkspaceRoot ? { runtimeWorkspaceRoot: this.runtimeWorkspaceRoot } : {}),
    };
  }

  async write(message: Record<string, unknown>) {
    this.writes.push(message);
  }

  async stop() {
    this.stops += 1;
  }

  line(message: Record<string, unknown>) {
    this.handlers?.onLine(JSON.stringify(message));
  }
}

const MODEL = {
  id: 'gpt-test',
  model: 'gpt-test',
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: 'GPT Test',
  description: 'test',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'balanced' }],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text'],
  supportsPersonality: false,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault: true,
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function answerLatest(transport: FakeTransport, method: string, result: unknown): Promise<Record<string, unknown>> {
  await tick();
  const request = [...transport.writes].reverse().find((entry) => entry.method === method && 'id' in entry);
  assert.ok(request, `缺少 ${method} 请求`);
  transport.line({ id: request.id, result });
  return request;
}

async function connectController(
  controller: AppServerController,
  transport: FakeTransport,
  catalogFailures = new Set<string>(),
  requestedWorkspaceRoot = 'D:/workspace',
  runtimeWorkspaceRoot = requestedWorkspaceRoot,
): Promise<void> {
  const connecting = controller.connect('session-1', requestedWorkspaceRoot);
  await answerLatest(transport, 'initialize', {
    userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} (Windows)`,
    codexHome: 'C:/Users/test/.codex',
    platformFamily: 'windows',
    platformOs: 'windows',
  });
  const rootsRequest = await answerLatest(transport, 'skills/extraRoots/set', {});
  assert.deepEqual(rootsRequest.params, { extraRoots: ['D:/rocketx-skills'] });
  await tick();
  const requiredResponses: Record<string, unknown> = {
    'model/list': { data: [MODEL], nextCursor: null },
    'permissionProfile/list': {
      data: [
        { id: ':workspace', description: null, allowed: true },
        { id: ':danger-full-access', description: null, allowed: true },
      ],
      nextCursor: null,
    },
    'skills/list': { data: [{ cwd: runtimeWorkspaceRoot, skills: [], errors: [] }] },
  };
  const optionalResponses: Record<string, unknown> = {
    'app/list': { data: [], nextCursor: null },
    'plugin/list': { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
  };
  for (const method of Object.keys(optionalResponses)) {
    assert.ok(
      transport.writes.find((entry) => entry.method === method && 'id' in entry),
      `${method} 应与核心目录请求同时发出，不能形成串行瀑布`,
    );
  }
  for (const [method, result] of Object.entries(requiredResponses)) {
    const request = transport.writes.find((entry) => entry.method === method && 'id' in entry);
    assert.ok(request, `缺少 ${method} 请求`);
    transport.line({ id: request.id, result });
  }
  for (const [method, result] of Object.entries(optionalResponses)) {
    const request = transport.writes.find((entry) => entry.method === method && 'id' in entry);
    assert.ok(request, `缺少 ${method} 请求`);
    transport.line(catalogFailures.has(method)
      ? {
          id: request.id,
          error: {
            code: -32000,
            message: 'failed to list apps: Request failed with status 403 Forbidden: <html>blocked</html>',
          },
        }
      : { id: request.id, result });
  }
  await connecting;
}

test('三档权限精确映射 Codex permission profile，不发送旧 sandbox 字段', () => {
  assert.deepEqual(permissionSettings('ask'), {
    permissions: ':workspace',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  });
  assert.deepEqual(permissionSettings('auto'), {
    permissions: ':workspace',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'guardian_subagent',
  });
  assert.deepEqual(permissionSettings('full'), {
    permissions: ':danger-full-access',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
  });
});

test('projectless 任务使用桌面端返回的真实本地目录，不把波浪号传给 Codex', async () => {
  const runtimeRoot = 'C:/Users/test/AppData/Local/RocketX/codex-projectless';
  const transport = new FakeTransport(runtimeRoot);
  const controller = new AppServerController({ transportFactory: () => transport });
  await connectController(controller, transport, new Set(), '~', runtimeRoot);
  assert.equal(controller.currentWorkspaceRoot, runtimeRoot);

  const starting = controller.startThread({ model: 'gpt-test', effort: 'medium', permissionPreset: 'auto' });
  const request = await answerLatest(transport, 'thread/start', { thread: { id: 'thread-projectless' } });
  assert.equal((request.params as Record<string, unknown>).cwd, runtimeRoot);
  await answerLatest(transport, 'thread/memoryMode/set', {});
  await answerLatest(transport, 'thread/settings/update', {});
  await starting;
});

test('已连接 Runtime 可直接切换房间工作区，不重启 app-server', async () => {
  const transport = new FakeTransport();
  const controller = new AppServerController({ transportFactory: () => transport });
  await connectController(controller, transport);

  assert.equal(controller.switchWorkspaceRoot('D:/room-workspace'), true);
  assert.equal(controller.currentWorkspaceRoot, 'D:/room-workspace');
  assert.equal(transport.starts, 1);
  assert.equal(transport.stops, 0);

  const resuming = controller.resumeThread(
    'room-thread',
    { model: 'gpt-test', effort: 'medium', permissionPreset: 'auto' },
  );
  const request = await answerLatest(transport, 'thread/resume', { thread: { id: 'room-thread' } });
  assert.equal((request.params as Record<string, unknown>).cwd, 'D:/room-workspace');
  await answerLatest(transport, 'thread/memoryMode/set', {});
  await answerLatest(transport, 'thread/settings/update', {});
  await resuming;
});

test('新任务先启用原生 Memory，再更新设置和开始 Turn', async () => {
  const transport = new FakeTransport();
  const controller = new AppServerController({ transportFactory: () => transport });
  await connectController(controller, transport);

  const starting = controller.startThread({ model: 'gpt-test', effort: 'medium', permissionPreset: 'auto' }, '真实任务');
  const startRequest = await answerLatest(transport, 'thread/start', { thread: { id: 'thread-1' } });
  const startParams = startRequest.params as Record<string, unknown>;
  assert.equal(startParams.permissions, ':workspace');
  assert.equal(startParams.approvalPolicy, 'on-request');
  assert.equal(startParams.approvalsReviewer, 'guardian_subagent');
  assert.equal('sandbox' in startParams, false);
  assert.equal('sandboxPolicy' in startParams, false);
  assert.deepEqual(
    (startParams.dynamicTools as Array<{ name?: string }>).map((tool) => tool.name),
    [
      'list_mentions',
      'list_todos',
      'list_calendar',
      'list_scheduled_tasks',
      'create_scheduled_task',
      'update_scheduled_task',
      'delete_scheduled_task',
      'run_scheduled_task',
    ],
  );

  const memoryRequest = await answerLatest(transport, 'thread/memoryMode/set', {});
  assert.deepEqual(memoryRequest.params, { threadId: 'thread-1', mode: 'enabled' });
  await answerLatest(transport, 'thread/settings/update', {});
  await answerLatest(transport, 'thread/name/set', {});
  await starting;

  const turn = controller.startTurn(
    'thread-1',
    [{ type: 'text', text: '检查真实链路', text_elements: [] }],
    { model: 'gpt-test', effort: 'medium', permissionPreset: 'auto' },
    { runtimeWorkspaceRoots: ['C:/runtime-attachments', 'D:/workspace', ''] },
  );
  const turnRequest = await answerLatest(transport, 'turn/start', { turn: { id: 'turn-1' } });
  const turnParams = turnRequest.params as Record<string, unknown>;
  assert.equal(turnParams.permissions, ':workspace');
  assert.equal(turnParams.approvalsReviewer, 'guardian_subagent');
  assert.deepEqual(turnParams.runtimeWorkspaceRoots, ['D:/workspace', 'C:/runtime-attachments']);
  assert.equal('sandbox' in turnParams, false);
  assert.equal(await turn, 'turn-1');
});

test('外部线程可通过原生 fork 继承历史、权限和 Memory 后继续', async () => {
  const transport = new FakeTransport();
  const controller = new AppServerController({ transportFactory: () => transport });
  await connectController(controller, transport);

  const forking = controller.forkThread(
    'thread-owned-by-codex',
    { model: 'gpt-test', effort: 'medium', permissionPreset: 'auto' },
    '原任务 · RocketX 继续',
  );
  const forkRequest = await answerLatest(transport, 'thread/fork', { thread: { id: 'thread-fork' } });
  assert.deepEqual(forkRequest.params, {
    threadId: 'thread-owned-by-codex',
    model: 'gpt-test',
    cwd: 'D:/workspace',
    runtimeWorkspaceRoots: ['D:/workspace'],
    permissions: ':workspace',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'guardian_subagent',
    excludeTurns: true,
    config: { features: { memories: true } },
  });
  const memoryRequest = await answerLatest(transport, 'thread/memoryMode/set', {});
  assert.deepEqual(memoryRequest.params, { threadId: 'thread-fork', mode: 'enabled' });
  await answerLatest(transport, 'thread/settings/update', {});
  const nameRequest = await answerLatest(transport, 'thread/name/set', {});
  assert.deepEqual(nameRequest.params, { threadId: 'thread-fork', name: '原任务 · RocketX 继续' });

  assert.equal((await forking).id, 'thread-fork');
});

test('原生 Memory 方法失败会阻止任务启动，不静默降级', async () => {
  const transport = new FakeTransport();
  const controller = new AppServerController({ transportFactory: () => transport });
  await connectController(controller, transport);

  const starting = controller.startThread({ model: 'gpt-test', effort: 'medium', permissionPreset: 'ask' });
  await answerLatest(transport, 'thread/start', { thread: { id: 'thread-memory-fail' } });
  await tick();
  const memoryRequest = [...transport.writes].reverse().find((entry) => entry.method === 'thread/memoryMode/set');
  assert.ok(memoryRequest);
  transport.line({ id: memoryRequest.id, error: { code: -32601, message: 'method not found' } });
  await assert.rejects(starting, /thread\/memoryMode\/set/);
  assert.equal(transport.writes.some((entry) => entry.method === 'turn/start'), false);
});

test('Apps 目录失败只隔离该目录，不拖垮模型、Skills、插件和任务连接', async () => {
  const transport = new FakeTransport();
  const controller = new AppServerController({ transportFactory: () => transport });
  await connectController(controller, transport, new Set(['app/list']));

  assert.equal(controller.currentCatalog?.models.length, 1);
  assert.deepEqual(controller.currentCatalog?.apps, []);
  assert.deepEqual(controller.currentCatalog?.plugins.marketplaces, []);
  assert.equal(
    controller.currentCatalog?.catalogErrors.apps,
    'Request failed with status 403 Forbidden',
  );
  assert.doesNotMatch(controller.currentCatalog?.catalogErrors.apps ?? '', /<html>/);
});

test('宿主动态工具把 RocketX 本地待办交给 Codex，而不是让调用方拒绝工具请求', async () => {
  const transport = new FakeTransport();
  const controller = new AppServerController({ transportFactory: () => transport });
  await connectController(controller, transport);
  useTodos.setState({
    todos: [{ id: 'todo-1', note: '回复发布评审', due: '2026-08-10', done: false, createdAt: 1 }],
  });

  try {
    transport.line({
      id: 'dynamic-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'list_todos',
        arguments: {},
      },
    });
    await tick();

    const reply = transport.writes.find((entry) => entry.id === 'dynamic-1');
    assert.ok(reply && 'result' in reply);
    const result = reply.result as {
      success: boolean;
      contentItems: Array<{ type: string; text: string }>;
    };
    assert.equal(result.success, true);
    assert.equal(JSON.parse(result.contentItems[0].text).items[0].text, '回复发布评审');
  } finally {
    useTodos.setState({ todos: [] });
    await controller.stop();
  }
});

test('变更已安排任务必须等待当前用户显式审批后才执行', async () => {
  const transport = new FakeTransport();
  let resolveApproval!: (value: unknown) => void;
  let createCalls = 0;
  const approvals: Array<{ method: string; policy: string; params: unknown }> = [];
  const controller = new AppServerController({
    transportFactory: () => transport,
    onServerRequest: (request) => {
      approvals.push(request);
      return new Promise((resolve) => { resolveApproval = resolve; });
    },
  });
  const restoreAdapter = registerScheduledTaskAdapter({
    list: () => ({ tasks: [] }),
    create: (input) => {
      createCalls += 1;
      return { status: 'created', task: input };
    },
    update: () => ({ status: 'updated' }),
    remove: () => ({ status: 'deleted' }),
    run: async () => ({ status: 'completed' }),
  });
  await connectController(controller, transport);

  try {
    transport.line({
      id: 'dynamic-schedule-create',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-schedule-create',
        namespace: null,
        tool: 'create_scheduled_task',
        arguments: {
          name: '发布检查',
          prompt: '检查候选版本',
          rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        },
      },
    });
    await tick();

    assert.equal(createCalls, 0);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.policy, 'host-approval');
    assert.match(String((approvals[0]?.params as Record<string, unknown>).reason), /创建已安排任务/);

    resolveApproval({ decision: 'accept' });
    await tick();

    assert.equal(createCalls, 1);
    const reply = transport.writes.find((entry) => entry.id === 'dynamic-schedule-create');
    assert.ok(reply && 'result' in reply);
  } finally {
    restoreAdapter();
    await controller.stop();
  }
});
