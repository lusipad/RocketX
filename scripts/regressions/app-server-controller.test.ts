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

class FakeTransport implements CodexTransport {
  writes: Record<string, unknown>[] = [];
  handlers?: Parameters<CodexTransport['start']>[0];

  async start(handlers: Parameters<CodexTransport['start']>[0]) {
    this.handlers = handlers;
    return {
      processId: 'controller-test',
      version: CODEX_APP_SERVER_VERSION,
      runtimeSource: 'bundled' as const,
      managedSkillRoots: ['D:/rocketx-skills'],
    };
  }

  async write(message: Record<string, unknown>) {
    this.writes.push(message);
  }

  async stop() {}

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
): Promise<void> {
  const connecting = controller.connect('session-1', 'D:/workspace');
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
    'skills/list': { data: [{ cwd: 'D:/workspace', skills: [], errors: [] }] },
  };
  const optionalResponses: Record<string, unknown> = {
    'app/list': { data: [], nextCursor: null },
    'plugin/list': { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
  };
  for (const [method, result] of Object.entries(requiredResponses)) {
    const request = transport.writes.find((entry) => entry.method === method && 'id' in entry);
    assert.ok(request, `缺少 ${method} 请求`);
    transport.line({ id: request.id, result });
  }
  await tick();
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
