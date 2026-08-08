import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppServerClient, AppServerClientOptions } from '../../apps/web/src/agent/protocol';
import { setBusinessMcpLaunchConfigProvider } from '../../apps/web/src/agent/businessMcp';
import { useAgentEnvironments } from '../../apps/web/src/stores/agentEnvironments';
import { useButler } from '../../apps/web/src/stores/butler';
import {
  setButlerErrandClientFactory,
  useButlerErrandRuns,
} from '../../apps/web/src/stores/butlerErrandRuns';

const storageEntries = new Map<string, string>();
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storageEntries.get(key) ?? null,
    setItem: (key: string, value: string) => storageEntries.set(key, String(value)),
    removeItem: (key: string) => storageEntries.delete(key),
  },
});

const restoreBusinessMcp = setBusinessMcpLaunchConfigProvider(async () => undefined);

interface FakeClient {
  options: AppServerClientOptions;
  threadId: string;
  turnId: string;
}

function installFakeClients(): { clients: FakeClient[]; restore: () => void } {
  const clients: FakeClient[] = [];
  const restore = setButlerErrandClientFactory(async (_sessionId, _workspaceRoot, options) => {
    const index = clients.length + 1;
    const fake = { options, threadId: `host-input-thread-${index}`, turnId: `host-input-turn-${index}` };
    clients.push(fake);
    return {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === 'thread/start') return { thread: { id: fake.threadId, cliVersion: 'test' } };
        if (method === 'turn/start') return { turn: { id: fake.turnId } };
        if (method === 'thread/goal/get' || method === 'thread/goal/set') {
          return {
            goal: {
              threadId: fake.threadId,
              objective: String(params.objective ?? '测试人工输入'),
              status: params.status === 'paused' ? 'paused' : 'active',
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        return {};
      },
      stop: async () => undefined,
    } as unknown as AppServerClient;
  });
  return { clients, restore };
}

function resetEnvironments(): void {
  useAgentEnvironments.setState({
    environments: [],
    bindings: [],
    lastDispatchEnvironmentId: undefined,
  } as never);
}

async function dispatch(title: string) {
  const environment = useAgentEnvironments.getState().environments[0]
    ?? useAgentEnvironments.getState().addEnvironment({
      name: '人工输入测试区',
      path: 'D:/Repos/rocketchatx',
      adoProjects: [],
      defaultBaseBranch: '',
      branchPrefix: '',
    });
  return useButlerErrandRuns.getState().dispatchErrand(
    { title, goal: '验证同一轮能够在回答后继续', acceptance: [], boundaries: [], evidence: [] },
    { id: environment.id, name: environment.name, path: environment.path },
    { readOnly: true },
  );
}

test.beforeEach(async () => {
  storageEntries.clear();
  await useButlerErrandRuns.getState().reset();
  resetEnvironments();
});

test.after(async () => {
  await useButlerErrandRuns.getState().reset();
  resetEnvironments();
  restoreBusinessMcp();
  if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

test('request_user_input 挂起真实委托请求，回答只回给所属任务且不持久化敏感值', async () => {
  const codex = installFakeClients();
  try {
    const first = await dispatch('回答发布方式');
    const second = await dispatch('回答验证口令');
    const firstHandler = codex.clients[0]?.options.onServerRequest;
    const secondHandler = codex.clients[1]?.options.onServerRequest;
    assert.ok(firstHandler && secondHandler);

    const firstResponse = firstHandler({
      method: 'item/tool/requestUserInput',
      policy: 'host-input',
      params: {
        threadId: first.threadId,
        turnId: 'host-input-turn-1',
        itemId: 'question-1',
        autoResolutionMs: null,
        questions: [{
          id: 'release_mode',
          header: '发布方式',
          question: '选择本次发布方式',
          isOther: false,
          isSecret: false,
          options: [
            { label: '候选版', description: '先验证再发布' },
            { label: '正式版', description: '直接正式发布' },
          ],
        }],
      },
    });
    const secondResponse = secondHandler({
      method: 'item/tool/requestUserInput',
      policy: 'host-input',
      params: {
        threadId: second.threadId,
        turnId: 'host-input-turn-2',
        itemId: 'question-2',
        autoResolutionMs: null,
        questions: [{
          id: 'token',
          header: '临时口令',
          question: '输入只用于本轮的验证口令',
          isOther: true,
          isSecret: true,
          options: null,
        }],
      },
    });

    const runs = useButlerErrandRuns.getState().runs;
    assert.equal(runs.find((run) => run.id === first.id)?.inputs?.length, 1);
    assert.equal(runs.find((run) => run.id === second.id)?.inputs?.length, 1);
    assert.equal(runs.find((run) => run.id === first.id)?.status, 'awaiting-approval');
    const firstInputId = runs.find((run) => run.id === first.id)?.inputs?.[0]?.id;
    const secondInputId = runs.find((run) => run.id === second.id)?.inputs?.[0]?.id;
    assert.ok(firstInputId && secondInputId);

    await useButler.getState().resolveErrandInput(second.id, secondInputId, {
      answers: { token: { answers: ['  smoke-secret-42  '] } },
    });
    assert.deepEqual(await secondResponse, {
      answers: { token: { answers: ['smoke-secret-42'] } },
    });
    assert.equal(useButlerErrandRuns.getState().runs.find((run) => run.id === first.id)?.inputs?.length, 1);
    assert.equal(useButlerErrandRuns.getState().runs.find((run) => run.id === second.id)?.inputs?.length, 0);

    await useButler.getState().resolveErrandInput(first.id, firstInputId, {
      answers: { release_mode: { answers: ['候选版'] } },
    });
    assert.deepEqual(await firstResponse, {
      answers: { release_mode: { answers: ['候选版'] } },
    });
    assert.equal(useButlerErrandRuns.getState().runs.find((run) => run.id === first.id)?.status, 'running');
    assert.doesNotMatch(storageEntries.get('rcx-butler-errand-runs') ?? '', /smoke-secret-42/);
  } finally {
    codex.restore();
  }
});

test('MCP 标准表单校验并回传结构化内容，不支持的表单仍可安全拒绝', async () => {
  const codex = installFakeClients();
  try {
    const formRun = await dispatch('填写发布参数');
    const formHandler = codex.clients[0]?.options.onServerRequest;
    assert.ok(formHandler);
    const formResponse = formHandler({
      method: 'mcpServer/elicitation/request',
      policy: 'host-input',
      params: {
        threadId: formRun.threadId,
        turnId: 'host-input-turn-1',
        serverName: 'release-helper',
        mode: 'form',
        _meta: null,
        message: '补充候选版参数',
        requestedSchema: {
          type: 'object',
          required: ['channel', 'retries'],
          properties: {
            channel: { type: 'string', enum: ['canary', 'stable'] },
            retries: { type: 'integer', minimum: 0, maximum: 3 },
            notify: { type: 'boolean' },
          },
        },
      },
    });
    const formInputId = useButlerErrandRuns.getState().runs.find((run) => run.id === formRun.id)?.inputs?.[0]?.id;
    assert.ok(formInputId);
    await assert.rejects(
      useButlerErrandRuns.getState().resolveInput(formRun.id, formInputId, {
        action: 'accept',
        content: { channel: 'unknown', retries: 9 },
        _meta: null,
      }),
      /可选范围|最大值/,
    );
    assert.equal(useButlerErrandRuns.getState().runs.find((run) => run.id === formRun.id)?.inputs?.length, 1);
    await useButlerErrandRuns.getState().resolveInput(formRun.id, formInputId, {
      action: 'accept',
      content: { channel: 'canary', retries: 2, notify: false },
      _meta: { ignored: true },
    });
    assert.deepEqual(await formResponse, {
      action: 'accept',
      content: { channel: 'canary', retries: 2, notify: false },
      _meta: null,
    });

    const unsupportedRun = await dispatch('拒绝未知表单');
    const unsupportedHandler = codex.clients[1]?.options.onServerRequest;
    assert.ok(unsupportedHandler);
    const unsupportedResponse = unsupportedHandler({
      method: 'mcpServer/elicitation/request',
      policy: 'host-input',
      params: {
        threadId: unsupportedRun.threadId,
        turnId: 'host-input-turn-2',
        serverName: 'custom-form',
        mode: 'openai/form',
        _meta: null,
        message: '需要客户端专属表单',
        requestedSchema: {},
      },
    });
    const unsupportedInputId = useButlerErrandRuns.getState().runs.find((run) => run.id === unsupportedRun.id)?.inputs?.[0]?.id;
    assert.ok(unsupportedInputId);
    await useButlerErrandRuns.getState().resolveInput(unsupportedRun.id, unsupportedInputId, {
      action: 'decline',
      content: { shouldBeRemoved: true },
      _meta: { shouldBeRemoved: true },
    });
    assert.deepEqual(await unsupportedResponse, { action: 'decline', content: null, _meta: null });
  } finally {
    codex.restore();
  }
});
