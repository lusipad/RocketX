import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HostedDshController,
  type HostedDshControllerOptions,
} from '../../apps/web/src/agent/dsh/HostedDshController';
import type {
  DshControllerRuntime,
  DshServerRequest,
} from '../../apps/web/src/agent/dsh/DshController';
import type {
  DshPendingApproval,
  DshPendingQuestion,
  DshQuestionAnswer,
} from '../../apps/web/src/stores/dshWorkspace';

type EventName = 'dsh-bridge-output' | 'dsh-bridge-exit';

interface RuntimeEventMap {
  'dsh-bridge-output': { processId: string; stream: 'stdout' | 'stderr'; line: string };
  'dsh-bridge-exit': { processId: string; code: number | null };
}

interface RuntimeCall {
  kind: 'call' | 'respond';
  processId: string;
  message: Record<string, unknown>;
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

function okServerResponse(rpcId: string, value: unknown) {
  return {
    type: 'server-response',
    rpcId,
    result: { ok: true, value },
  };
}

function createRuntime() {
  const start = deferred<{ processId: string }>();
  const listeners = new Map<EventName, Set<(event: { payload: unknown }) => void>>();
  const stops: string[] = [];
  const calls: RuntimeCall[] = [];
  const startArgs: Array<Record<string, unknown> | undefined> = [];
  const responses = new Map<string, Array<(rpcId: string) => unknown>>([
    ['host.describe', [() => okServerResponse('ignored', {})]],
    ['credentials.describe', [() => okServerResponse('ignored', {
      credentials: {
        DEEPSEEK_API_KEY: { configured: true, writable: false },
      },
    })]],
    ['session.create', [() => okServerResponse('ignored', { sessionId: 'session-1' })]],
    ['session.history', [() => okServerResponse('ignored', { events: [], hasMore: false })]],
    ['session.prompt', [() => okServerResponse('ignored', { accepted: true })]],
    ['session.cancel', [() => okServerResponse('ignored', {})]],
  ]);

  const runtime: DshControllerRuntime & {
    start: typeof start;
    stops: string[];
    calls: RuntimeCall[];
    startArgs: Array<Record<string, unknown> | undefined>;
    emit<K extends EventName>(event: K, payload: RuntimeEventMap[K]): void;
    startBridge(processId?: string): void;
    emitMux(processId: string, request: DshServerRequest): void;
    emitHost(processId: string, request: DshServerRequest): void;
    setCallResponse(method: string, handlers: Array<(rpcId: string) => unknown>): void;
  } = {
    start,
    stops,
    calls,
    startArgs,
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (command === 'dsh_bridge_start') {
        startArgs.push(args);
        return start.promise as Promise<T>;
      }
      if (command === 'dsh_bridge_stop') {
        stops.push(String(args?.processId ?? ''));
        return undefined as T;
      }
      if (command === 'dsh_bridge_write') {
        const processId = String(args?.processId ?? '');
        const message = (args?.message ?? {}) as Record<string, unknown>;
        const kind = message.kind === 'respond' ? 'respond' : 'call';
        calls.push({ kind, processId, message });
        const id = String(message.id ?? 'missing-id');
        if (kind === 'respond') {
          queueMicrotask(() => {
            runtime.emit('dsh-bridge-output', {
              processId,
              stream: 'stdout',
              line: JSON.stringify({ kind: 'response', id, op: 'respond', response: { accepted: true } }),
            });
          });
          return undefined as T;
        }
        const method = String(message.method ?? '');
        const handler = responses.get(method)?.shift();
        if (!handler) throw new Error(`unexpected DSH call: ${method}`);
        queueMicrotask(() => {
          const response = handler(id);
          if (typeof response === 'object' && response !== null && 'rpcId' in response) {
            (response as { rpcId: string }).rpcId = id;
          }
          runtime.emit('dsh-bridge-output', {
            processId,
            stream: 'stdout',
            line: JSON.stringify({ kind: 'response', id, op: 'call', response }),
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
    emit<K extends EventName>(event: K, payload: RuntimeEventMap[K]) {
      for (const handler of listeners.get(event) ?? []) handler({ payload });
    },
    startBridge(processId = 'process-1') {
      start.resolve({ processId });
      queueMicrotask(() => {
        runtime.emit('dsh-bridge-output', {
          processId,
          stream: 'stdout',
          line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:4123' }),
        });
      });
    },
    emitMux(processId, request) {
      runtime.emit('dsh-bridge-output', {
        processId,
        stream: 'stdout',
        line: JSON.stringify({ kind: 'mux', envelope: request }),
      });
    },
    emitHost(processId, request) {
      runtime.emit('dsh-bridge-output', {
        processId,
        stream: 'stdout',
        line: JSON.stringify({ kind: 'host', envelope: request }),
      });
    },
    setCallResponse(method, handlers) {
      responses.set(method, [...handlers]);
    },
  };
  return runtime;
}

function options(runtime: DshControllerRuntime, sink: {
  approvals: DshPendingApproval[];
  questions: DshPendingQuestion[];
  traces: DshServerRequest[];
  interrupted: Error[];
  approvalResolved?: Array<[string, string]>;
  questionResolved?: Array<[string, string]>;
}): HostedDshControllerOptions {
  return {
    runtime,
    onApproval: (approval) => sink.approvals.push(approval),
    onApprovalResolved: (sessionId, approvalId) => sink.approvalResolved?.push([sessionId, approvalId]),
    onQuestion: (question) => sink.questions.push(question),
    onQuestionResolved: (sessionId, questionRpcId) => sink.questionResolved?.push([sessionId, questionRpcId]),
    onTrace: (request) => sink.traces.push(request),
    onInterrupted: (error) => sink.interrupted.push(error),
  };
}

test('hosted DSH controller connects, validates credentials, manages sessions, and waits for prompt completion', async () => {
  const runtime = createRuntime();
  const sink = {
    approvals: [] as DshPendingApproval[],
    questions: [] as DshPendingQuestion[],
    traces: [] as DshServerRequest[],
    interrupted: [] as Error[],
    approvalResolved: [] as Array<[string, string]>,
    questionResolved: [] as Array<[string, string]>,
  };
  const controller = new HostedDshController(
    'D:/Repos/rocketchatx',
    'hosted-room-7',
    options(runtime, sink),
  );

  const connecting = controller.connect();
  runtime.startBridge('process-hosted');
  await connecting;

  assert.equal(runtime.startArgs[0]?.connectionId, 'hosted-room-7');
  assert.equal(runtime.startArgs[0]?.workspaceRoot, 'D:/Repos/rocketchatx');

  const sessionId = await controller.createSession();
  assert.equal(sessionId, 'session-1');
  const createCall = runtime.calls.find((call) => call.message.method === 'session.create');
  assert.deepEqual(createCall?.message.payload, { cwd: 'D:/Repos/rocketchatx' });
  await controller.resumeSession(sessionId);

  const prompting = controller.prompt(sessionId, '请总结当前变更');
  await Promise.resolve();

  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'stale-turn-end',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: {
        type: 'turn/end',
        seq: 1,
        time: 1,
        data: { turn: 6, reason: { kind: 'done' } },
      },
    },
  });
  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'turn-start',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: {
        type: 'turn/start',
        seq: 2,
        time: 2,
        data: { turn: 7 },
      },
    },
  });
  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'trace-1',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: {
        type: 'assistant/chunk',
        seq: 3,
        time: 3,
        data: { turn: 7, step: 1, chunk: { type: 'text-delta', index: 0, text: '完成' } },
      },
    },
  });
  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'trace-2',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: {
        type: 'assistant/message',
        seq: 4,
        time: 4,
        data: {
          turn: 7,
          step: 1,
          message: {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: '完成答复' }],
            source: { kind: 'model' },
          },
        },
      },
    },
  });
  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'trace-3',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: {
        type: 'turn/end',
        seq: 5,
        time: 5,
        data: { turn: 7, reason: { kind: 'done' } },
      },
    },
  });

  assert.deepEqual(await prompting, { turnId: 'turn-7', text: '完成答复' });

  const traceCount = sink.traces.length;
  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'foreign-approval',
    method: 'approval/requested',
    payload: {
      type: 'approval/requested',
      sessionId: 'session-other',
      approvalId: 'foreign-1',
      toolName: 'shell',
    },
  });
  runtime.emitHost('process-hosted', {
    type: 'server-request',
    rpcId: 'foreign-error',
    method: 'host/agent-error',
    payload: {
      type: 'host/agent-error',
      sessionId: 'session-other',
      message: '不应影响当前会话',
    },
  });
  assert.equal(sink.approvals.length, 0);
  assert.equal(sink.traces.length, traceCount);
  assert.equal(sink.interrupted.length, 0);

  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'approval-rpc',
    method: 'approval/requested',
    payload: {
      type: 'approval/requested',
      sessionId,
      approvalId: 'approval-1',
      toolName: 'shell',
      reason: '需要执行命令',
    },
  });
  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'question-rpc',
    method: 'question/requested',
    payload: {
      type: 'question/requested',
      sessionId,
      questions: [{ id: 'q1', question: '继续吗？' }],
    },
  });

  assert.equal(sink.approvals[0]?.rpcId, 'approval-rpc');
  assert.equal(sink.questions[0]?.rpcId, 'question-rpc');

  await controller.respondApproval(sink.approvals[0]!, true);
  const answers: DshQuestionAnswer[] = [{ id: 'q1', selected: ['继续'] }];
  await controller.respondQuestion(sink.questions[0]!, answers);
  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'approval-resolved',
    method: 'approval/resolved',
    payload: { type: 'approval/resolved', sessionId, approvalId: 'approval-1' },
  });
  runtime.emitMux('process-hosted', {
    type: 'server-request',
    rpcId: 'question-resolved',
    method: 'question/resolved',
    payload: { type: 'question/resolved', sessionId, questionRpcId: 'question-rpc' },
  });
  assert.deepEqual(sink.approvalResolved, [[sessionId, 'approval-1']]);
  assert.deepEqual(sink.questionResolved, [[sessionId, 'question-rpc']]);
  await controller.cancel(sessionId);
  await controller.stop();

  const respondCalls = runtime.calls.filter((call) => call.kind === 'respond');
  assert.equal((respondCalls[0]?.message.response as { rpcId?: string }).rpcId, 'approval-rpc');
  assert.equal((respondCalls[1]?.message.response as { rpcId?: string }).rpcId, 'question-rpc');
  assert.ok(runtime.calls.some((call) => call.kind === 'call' && call.message.method === 'session.cancel'));
  assert.deepEqual(runtime.stops, ['process-hosted']);
  assert.ok(sink.traces.some((request) => request.method === 'session/event'));
  assert.deepEqual(sink.interrupted, []);
});

test('hosted DSH controller fails closed on host agent errors', async () => {
  const runtime = createRuntime();
  const sink = {
    approvals: [] as DshPendingApproval[],
    questions: [] as DshPendingQuestion[],
    traces: [] as DshServerRequest[],
    interrupted: [] as Error[],
  };
  const controller = new HostedDshController(
    'D:/Repos/rocketchatx',
    'hosted-room-8',
    options(runtime, sink),
  );

  const connecting = controller.connect();
  runtime.startBridge('process-hosted-error');
  await connecting;
  await controller.createSession();

  runtime.emitHost('process-hosted-error', {
    type: 'server-request',
    rpcId: 'host-error',
    method: 'host/agent-error',
    payload: {
      type: 'host/agent-error',
      sessionId: 'session-1',
      message: 'DeepSeek 执行失败',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sink.interrupted[0]?.message, 'DeepSeek 执行失败');
  await assert.rejects(() => controller.createSession(), /DeepSeek 执行失败/);
  assert.deepEqual(runtime.stops, ['process-hosted-error']);
});

test('hosted DSH controller rejects connect when DeepSeek credential is missing', async () => {
  const runtime = createRuntime();
  runtime.setCallResponse('credentials.describe', [(_rpcId) => okServerResponse('ignored', {
    credentials: {
      DEEPSEEK_API_KEY: { configured: false, writable: true },
    },
  })]);
  const controller = new HostedDshController(
    'D:/Repos/rocketchatx',
    'hosted-room-9',
    { runtime },
  );

  const connecting = controller.connect();
  runtime.startBridge('process-hosted-missing-key');

  await assert.rejects(connecting, /请先在管家 → DeepSeek 选择工作区并配置 DeepSeek API Key/);
  assert.deepEqual(runtime.stops, ['process-hosted-missing-key']);
});

test('hosted DSH controller rejects errored turns even if DSH streamed partial text and filters invalid question options', async () => {
  const runtime = createRuntime();
  const sink = {
    approvals: [] as DshPendingApproval[],
    questions: [] as DshPendingQuestion[],
    traces: [] as DshServerRequest[],
    interrupted: [] as Error[],
  };
  const controller = new HostedDshController(
    'D:/Repos/rocketchatx',
    'hosted-room-10',
    options(runtime, sink),
  );

  const connecting = controller.connect();
  runtime.startBridge('process-hosted-error-turn');
  await connecting;
  const sessionId = await controller.createSession();

  const prompting = controller.prompt(sessionId, '给我一个失败示例');
  await Promise.resolve();

  runtime.emitMux('process-hosted-error-turn', {
    type: 'server-request',
    rpcId: 'turn-start-error',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: {
        type: 'turn/start',
        seq: 1,
        time: 1,
        data: { turn: 9 },
      },
    },
  });
  runtime.emitMux('process-hosted-error-turn', {
    type: 'server-request',
    rpcId: 'partial-1',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: {
        type: 'assistant/chunk',
        seq: 2,
        time: 2,
        data: { turn: 9, step: 1, chunk: { type: 'text-delta', index: 0, text: '半截答案' } },
      },
    },
  });
  runtime.emitMux('process-hosted-error-turn', {
    type: 'server-request',
    rpcId: 'turn-error',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: {
        type: 'turn/end',
        seq: 3,
        time: 3,
        data: { turn: 9, reason: { kind: 'error', error: { message: '模型失败' } } },
      },
    },
  });

  await assert.rejects(prompting, /模型失败/);

  runtime.emitMux('process-hosted-error-turn', {
    type: 'server-request',
    rpcId: 'question-rpc-options',
    method: 'question/requested',
    payload: {
      type: 'question/requested',
      sessionId,
      questions: [{
        id: 'q2',
        question: '选一个',
        options: [
          { label: '允许', description: '继续执行' },
          { label: 42, description: '无效' },
          'bad-option',
        ],
      }],
    },
  });

  assert.deepEqual(sink.questions.at(-1)?.questions[0]?.options, [
    { label: '允许', description: '继续执行' },
  ]);
  await controller.stop();
});
