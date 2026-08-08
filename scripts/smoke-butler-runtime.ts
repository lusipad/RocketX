import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppServerClient, type ServerRequestPolicy } from '../apps/web/src/agent/protocol';
import type { DispatchSpec } from '../apps/web/src/agent/dispatchSpec';
import type { ToolRequestUserInputResponse } from '../apps/web/src/agent/protocol/generated/v2/ToolRequestUserInputResponse';
import { createMemoryBackend, createRcxStore } from '../packages/rcx-store/src';
import {
  codexInvocation,
  codexRuntimeSourceFromArgs,
  NodeCodexTransport,
  removeSpikeTempRoot,
  type CodexInvocation,
} from './lib/codex-app-server-spike';

type JsonRecord = Record<string, unknown>;

type SmokeStepResult = {
  result: 'PASS' | 'FAIL' | 'SKIP';
  evidence: JsonRecord;
};

type SmokeReport = {
  smoke: 'butler-runtime';
  result: 'PASS' | 'FAIL';
  runtime: {
    source: string;
    version: string;
    path: string;
  };
  assumptions: string[];
  persistentErrand: SmokeStepResult;
  ephemeralSkill: SmokeStepResult;
  cleanup: SmokeStepResult;
  notes: {
    mainlineAdaptation: string[];
  };
};

type ButlerErrandModules = Awaited<typeof import('../apps/web/src/stores/butlerErrandRuns')>;
type ButlerCodexModules = Awaited<typeof import('../apps/web/src/stores/butlerCodex')>;
type ButlerBrainModules = Awaited<typeof import('../apps/web/src/lib/butlerBrain')>;
type ButlerProfileModules = Awaited<typeof import('../apps/web/src/lib/butlerProfile')>;
type RoutinesModules = Awaited<typeof import('../apps/web/src/stores/routines')>;
type AgentEnvironmentModules = Awaited<typeof import('../apps/web/src/stores/agentEnvironments')>;
type AuthModules = Awaited<typeof import('../apps/web/src/stores/auth')>;
type ButlerStoreModules = Awaited<typeof import('../apps/web/src/stores/butler')>;

type LoadedModules = {
  errands: ButlerErrandModules;
  codex: ButlerCodexModules;
  brain: ButlerBrainModules;
  profile: ButlerProfileModules;
  routines: RoutinesModules;
  environments: AgentEnvironmentModules;
  auth: AuthModules;
  butler: ButlerStoreModules;
};

type ClientRecord = {
  sessionId: string;
  workspaceRoot: string;
  client: AppServerClient;
  transport: NodeCodexTransport;
  notifications: Array<{ method: string; params: unknown }>;
  serverRequests: Array<{ method: string; policy: ServerRequestPolicy | 'unknown'; params: unknown }>;
  interruptions: string[];
  collaborationModes: unknown[];
  forcedPlanTurns: number;
};

type RuntimeHarness = {
  modules: LoadedModules;
  restoreLocalStorage: () => void;
  restoreButlerBrainStorage: () => void;
  restoreButlerBrainTauri: () => void;
  restoreProfileStorage: () => void;
  restoreRoutineStorage: () => void;
  restoreRoutineCodexRunner: () => void;
  restoreButlerPersistence: () => void;
  restoreAuth: () => void;
  restoreErrandFactory: () => void;
  restoreCodexTransportFactory: () => void;
  restoreCodexWorkspaceResolver: () => void;
  clientRecords: ClientRecord[];
  memoryStorage: MemoryStorage;
  routineErrors: string[];
  setErrandPlanMode: (value: boolean) => void;
  setRoutineWorkspaceRoot: (value: string) => void;
};

type PendingInput = {
  inputId: string;
  itemId: string;
  turnId?: string;
  threadId?: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
};

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  get(key: string): string | null {
    return this.getItem(key);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  set(key: string, value: string): void {
    this.setItem(key, value);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function excerpt(value: unknown, limit = 240): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : JSON.stringify(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return !!entry && pathToFileURL(resolve(entry)).href === import.meta.url;
}

function installLocalStorageShim(storage: MemoryStorage): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
  if (typeof candidate.unref === 'function') candidate.unref();
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  predicate: () => T | undefined | Promise<T | undefined>,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((resolveNext) => {
      const timer = setTimeout(resolveNext, intervalMs);
      unrefTimer(timer);
    });
  }
  throw new Error(`等待超时：${label}`);
}

async function safeArchiveThread(
  invocation: CodexInvocation,
  workspaceRoot: string,
  threadId: string | undefined,
): Promise<boolean> {
  if (!threadId) return false;
  const client = new AppServerClient(new NodeCodexTransport(workspaceRoot, invocation));
  try {
    await client.start();
    await client.request('thread/archive', { threadId });
    return true;
  } catch {
    return false;
  } finally {
    await client.stop().catch(() => undefined);
  }
}

function pendingInputFromRun(run: unknown): PendingInput | undefined {
  const inputs = Array.isArray(asRecord(run).inputs)
    ? asRecord(run).inputs as unknown[]
    : [];
  const first = inputs.find((candidate) => candidate && typeof candidate === 'object');
  if (!first) return undefined;
  const record = asRecord(first);
  const params = asRecord(record.params);
  const source = Object.keys(params).length > 0 ? params : record;
  const rawQuestions = Array.isArray(source.questions) ? source.questions : [];
  const questions = rawQuestions.map((candidate) => {
    const question = asRecord(candidate);
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    return {
      id: asString(question.id) ?? '',
      header: asString(question.header) ?? '',
      question: asString(question.question) ?? '',
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options: rawOptions.map((option) => {
        const value = asRecord(option);
        return {
          label: asString(value.label) ?? '',
          ...(asString(value.description) ? { description: asString(value.description) } : {}),
        };
      }).filter((option) => option.label),
    };
  }).filter((question) => question.id || question.question);
  const inputId = asString(record.id)
    ?? asString(source.inputId)
    ?? asString(source.itemId);
  const itemId = asString(source.itemId) ?? inputId;
  if (!inputId || !itemId) return undefined;
  return {
    inputId,
    itemId,
    ...(asString(source.turnId) ? { turnId: asString(source.turnId) } : {}),
    ...(asString(source.threadId) ? { threadId: asString(source.threadId) } : {}),
    questions,
  };
}

function chooseInputAnswer(input: PendingInput): { response: ToolRequestUserInputResponse; chosenLabel: string } {
  const choices = input.questions.map((question) => {
    const option = question.options[1] ?? question.options[0];
    return [question.id, option?.label ?? '默认答案'] as const;
  });
  const chosenLabel = choices[0]?.[1] ?? '默认答案';
  return {
    response: {
      answers: Object.fromEntries(choices.map(([questionId, answer]) => [
        questionId,
        { answers: [answer] },
      ])),
    },
    chosenLabel,
  };
}

async function loadModules(): Promise<LoadedModules> {
  const [errands, codex, brain, profile, routines, environments, auth, butler] = await Promise.all([
    import('../apps/web/src/stores/butlerErrandRuns'),
    import('../apps/web/src/stores/butlerCodex'),
    import('../apps/web/src/lib/butlerBrain'),
    import('../apps/web/src/lib/butlerProfile'),
    import('../apps/web/src/stores/routines'),
    import('../apps/web/src/stores/agentEnvironments'),
    import('../apps/web/src/stores/auth'),
    import('../apps/web/src/stores/butler'),
  ]);
  return { errands, codex, brain, profile, routines, environments, auth, butler };
}

async function createHarness(invocation: CodexInvocation): Promise<RuntimeHarness> {
  const memoryStorage = new MemoryStorage();
  const restoreLocalStorage = installLocalStorageShim(memoryStorage);
  const modules = await loadModules();
  const restoreButlerBrainStorage = modules.brain.setButlerBrainStorage(memoryStorage);
  const restoreButlerBrainTauri = modules.brain.setButlerBrainTauriProvider(() => true);
  const restoreProfileStorage = modules.profile.setButlerProfileStorage(memoryStorage);
  const restoreRoutineStorage = modules.routines.setRoutineStorage(memoryStorage);
  const routineErrors: string[] = [];
  const restoreRoutineCodexRunner = modules.routines.setRoutineCodexRunner(async (options) => {
    try {
      return await modules.codex.runButlerCodexEphemeral(options);
    } catch (error) {
      routineErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));
      throw error;
    }
  });
  const restoreButlerPersistence = modules.butler.setButlerPersistence(
    createRcxStore({ backend: createMemoryBackend() }).appData,
  );
  const previousAuth = modules.auth.useAuth.getState();
  modules.auth.useAuth.setState({
    status: 'authed',
    user: { _id: 'smoke-user', username: 'smoke-user', name: 'Smoke User' } as never,
    error: null,
  });
  const restoreAuth = () => modules.auth.useAuth.setState({
    status: previousAuth.status,
    user: previousAuth.user,
    error: previousAuth.error,
  });
  modules.brain.setCodexBrainUnavailableReason(undefined);

  const clientRecords: ClientRecord[] = [];
  let forcePlanErrands = false;
  const restoreErrandFactory = modules.errands.setButlerErrandClientFactory(async (sessionId, workspaceRoot, options) => {
    const forcePlan = forcePlanErrands;
    const notifications: ClientRecord['notifications'] = [];
    const serverRequests: ClientRecord['serverRequests'] = [];
    const interruptions: string[] = [];
    const transport = new NodeCodexTransport(workspaceRoot, invocation);
    const client = new AppServerClient(transport, {
      onNotification: (method, params) => {
        notifications.push({ method, params });
        options.onNotification?.(method, params);
      },
      onServerRequest: async (request) => {
        serverRequests.push({
          method: request.method,
          policy: request.policy,
          params: request.params,
        });
        if (!options.onServerRequest) {
          throw new Error(`缺少宿主请求处理器：${request.method}`);
        }
        return options.onServerRequest(request);
      },
      onInterrupted: (error) => {
        interruptions.push(error.message);
        options.onInterrupted?.(error);
      },
    });
    await client.start();
    const collaborationModes = await client.request('collaborationMode/list', {}).then(
      (response) => response.data,
      () => [],
    );
    let threadModel = '';
    let forcedPlanTurns = 0;
    const wrappedClient = {
      request: async (method: string, params: JsonRecord) => {
        if (method === 'thread/start') {
          const response = await client.request('thread/start', params);
          threadModel = response.model;
          return response;
        }
        if (method === 'turn/start') {
          if (!forcePlan) return client.request('turn/start', params as never);
          const planMode = collaborationModes.find((candidate) => asRecord(candidate).mode === 'plan');
          const planRecord = asRecord(planMode);
          const model = asString(planRecord.model) ?? threadModel;
          forcedPlanTurns += 1;
          return client.request('turn/start', {
            ...params,
            collaborationMode: {
              mode: 'plan',
              settings: {
                model,
                reasoning_effort: planRecord.reasoning_effort ?? null,
                developer_instructions: null,
              },
            },
          });
        }
        return client.request(method as never, params as never);
      },
      stop: () => client.stop(),
    } as unknown as AppServerClient;
    const record: ClientRecord = {
      sessionId,
      workspaceRoot,
      client,
      transport,
      notifications,
      serverRequests,
      interruptions,
      collaborationModes,
      forcedPlanTurns,
    };
    clientRecords.push(record);
    Object.defineProperty(record, 'forcedPlanTurns', {
      enumerable: true,
      get: () => forcedPlanTurns,
    });
    return wrappedClient;
  });

  let routineWorkspaceRoot = '';
  const restoreCodexWorkspaceResolver = modules.codex.setButlerCodexWorkspaceResolver(async () => routineWorkspaceRoot);
  const restoreCodexTransportFactory = modules.codex.setButlerCodexTransportFactory((_sessionId, workspaceRoot) =>
    new NodeCodexTransport(workspaceRoot, invocation));

  return {
    modules,
    restoreLocalStorage,
    restoreButlerBrainStorage,
    restoreButlerBrainTauri,
    restoreProfileStorage,
    restoreRoutineStorage,
    restoreRoutineCodexRunner,
    restoreButlerPersistence,
    restoreAuth,
    restoreErrandFactory,
    restoreCodexTransportFactory,
    restoreCodexWorkspaceResolver,
    clientRecords,
    memoryStorage,
    routineErrors,
    setErrandPlanMode(value: boolean) {
      forcePlanErrands = value;
    },
    setRoutineWorkspaceRoot(value: string) {
      routineWorkspaceRoot = value;
    },
  };
}

async function prepareWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function writeHostInputAgentsFile(workspaceRoot: string): Promise<void> {
  const agents = [
    '# Butler Runtime Smoke',
    '',
    '必须回复中文。',
    '这是 RocketX 管家真实运行时 smoke 的临时工作区。',
    '不要访问网络、不要改文件、不要调用与 request_user_input 无关的工具。',
    '第一步必须调用 request_user_input，且只提 1 个单选问题。',
    '问题 id 必须是 smoke_choice，header 必须是 饮料，选项必须包含 乌龙茶 与 冷萃咖啡。',
    '在拿到宿主回答前，不要输出最终结果。',
    '拿到回答后继续同一任务，最终回复必须包含唯一标记 RCX_BUTLER_RUNTIME_INPUT_OK 和所选答案，格式：RCX_BUTLER_RUNTIME_INPUT_OK answer=<答案>。',
  ].join('\n');
  await writeFile(join(workspaceRoot, 'AGENTS.md'), agents);
}

async function writeDefaultCompletionAgentsFile(workspaceRoot: string): Promise<void> {
  const agents = [
    '# Butler Runtime Smoke',
    '',
    '必须回复中文。',
    '这是 RocketX 管家真实运行时 smoke 的临时工作区。',
    '不要访问网络、不要读写文件、不要请求用户输入、不要请求审批。',
    '直接完成目标，最终回复必须包含唯一标记 RCX_BUTLER_RUNTIME_DONE_OK。',
    '先使用 update_goal 把当前 Goal 标记为 complete，再输出包含唯一标记 RCX_BUTLER_RUNTIME_DONE_OK 的最终回复。',
  ].join('\n');
  await writeFile(join(workspaceRoot, 'AGENTS.md'), agents);
}

async function copyRoomDigestSkill(workspaceRoot: string): Promise<string> {
  const source = join(process.cwd(), 'apps', 'web', 'src', 'butler', 'skills', 'core', 'room-digest', 'SKILL.md');
  const targetDir = join(workspaceRoot, '.agents', 'skills', 'room-digest');
  const target = join(targetDir, 'SKILL.md');
  await mkdir(targetDir, { recursive: true });
  await writeFile(target, await readFile(source, 'utf8'));
  return target;
}

async function runHostInputProtocolSmoke(
  harness: RuntimeHarness,
  persistentWorkspace: string,
): Promise<SmokeStepResult> {
  const store = harness.modules.errands.useButlerErrandRuns;
  const state = store.getState() as typeof store.getState extends () => infer T ? T : never;
  const augmented = state as typeof state & {
    resolveInput?: (runId: string, inputId: string, response: ToolRequestUserInputResponse) => Promise<void>;
  };

  if (typeof augmented.resolveInput !== 'function') {
    return {
      result: 'FAIL',
      evidence: {
        reason: 'missingCapability',
        expected: 'useButlerErrandRuns.resolveInput(runId, inputId, response)',
        observedKeys: Object.keys(state).sort(),
        mainlineAdaptation: '主线需先接入 resolveInput / ButlerErrandRun.inputs，再执行真实持久委托 smoke。',
      },
    };
  }

  const spec: DispatchSpec = {
    title: '管家 request_user_input smoke',
    goal: '通过真实持久委托验证 request_user_input 会进入待回答状态；宿主提交回答后，同一任务继续并输出包含所选答案的明确 marker。',
    acceptance: [
      '必须先发起 request_user_input，而不是直接文本提问。',
      '宿主提交回答后，最终回复包含 RCX_BUTLER_RUNTIME_INPUT_OK 与所选答案。',
      '全程只使用临时工作区，不访问网络、不修改文件。',
    ],
    boundaries: [
      '不要访问真实业务系统。',
      '不要写入工作区文件。',
      '不要请求审批。',
    ],
    evidence: [],
  };

  const run = await augmented.dispatchErrand(spec, {
    name: 'smoke-persistent-workspace',
    path: persistentWorkspace,
    pending: true,
  }, {
    readOnly: true,
  });

  let requested: { current: unknown; pendingInput: PendingInput | undefined };
  try {
    requested = await waitFor('派活出现待输入请求', 35_000, () => {
      const current = store.getState().runs.find((candidate) => candidate.id === run.id);
      if (!current) throw new Error('派活记录已丢失');
      const pendingInput = pendingInputFromRun(current);
      if (pendingInput) return { current, pendingInput };
      if (current.status === 'failed' || current.status === 'replied') {
        return { current, pendingInput: undefined };
      }
      return undefined;
    });
  } catch (error) {
    const current = store.getState().runs.find((candidate) => candidate.id === run.id);
    return {
      result: 'FAIL',
      evidence: {
        reason: 'inputWaitFailed',
        error: error instanceof Error ? error.message : String(error),
        run: current ?? null,
        serverRequests: harness.clientRecords.flatMap((record) => record.serverRequests),
        collaborationModes: harness.clientRecords.flatMap((record) => record.collaborationModes),
        forcedPlanTurns: harness.clientRecords.reduce((total, record) => total + record.forcedPlanTurns, 0),
        notificationMethods: harness.clientRecords.flatMap((record) => record.notifications.map((item) => item.method)),
      },
    };
  }

  const threadIdBeforeResolve = asString(asRecord(requested.current).threadId) ?? '';
  const requestRecord = [...harness.clientRecords]
    .flatMap((record) => record.serverRequests)
    .find((record) => record.method === 'item/tool/requestUserInput');

  if (!requested.pendingInput) {
    return {
      result: 'FAIL',
      evidence: {
        reason: 'inputNotObserved',
        runId: run.id,
        status: asString(asRecord(requested.current).status) ?? 'unknown',
        threadId: threadIdBeforeResolve,
        error: asString(asRecord(requested.current).error),
        reply: excerpt(asRecord(requested.current).reply),
        requestUserInputObserved: !!requestRecord,
        requestRecord: requestRecord ?? null,
      },
    };
  }

  const selection = chooseInputAnswer(requested.pendingInput);
  const clientRecord = harness.clientRecords.find((record) =>
    record.serverRequests.some((request) =>
      request.method === 'item/tool/requestUserInput'
      && asString(asRecord(request.params).threadId) === threadIdBeforeResolve));
  const notificationStart = clientRecord?.notifications.length ?? 0;
  await augmented.resolveInput(run.id, requested.pendingInput.inputId, selection.response);

  let lifecycle: {
    current: unknown;
    inputRemoved: boolean;
    resolvedNotification: { method: string; params: unknown };
    completedNotification: { method: string; params: unknown };
  };
  try {
    lifecycle = await waitFor('回答回传后原 turn 完成', 35_000, () => {
      const current = store.getState().runs.find((candidate) => candidate.id === run.id);
      if (!current) throw new Error('派活记录已丢失');
      const notifications = clientRecord?.notifications.slice(notificationStart) ?? [];
      const resolvedNotification = notifications.find((notification) =>
        notification.method === 'serverRequest/resolved'
        && asString(asRecord(notification.params).threadId) === threadIdBeforeResolve);
      const completedNotification = notifications.find((notification) => {
        const params = asRecord(notification.params);
        return notification.method === 'turn/completed'
          && asString(params.threadId) === threadIdBeforeResolve
          && asString(asRecord(params.turn).id) === requested.pendingInput?.turnId;
      });
      const inputRemoved = !pendingInputFromRun(current);
      if (resolvedNotification && completedNotification && inputRemoved) {
        return { current, inputRemoved, resolvedNotification, completedNotification };
      }
      return undefined;
    });
  } catch (error) {
    const current = store.getState().runs.find((candidate) => candidate.id === run.id);
    return {
      result: 'FAIL',
      evidence: {
        reason: 'inputContinuationFailed',
        error: error instanceof Error ? error.message : String(error),
        run: current ?? null,
        selectedAnswer: selection.chosenLabel,
        turnId: requested.pendingInput.turnId ?? null,
        notificationsAfterResolve: clientRecord?.notifications.slice(notificationStart).map((item) => item.method) ?? [],
      },
    };
  }

  const completedTurn = asRecord(asRecord(lifecycle.completedNotification.params).turn);
  const threadIdAfterResolve = asString(asRecord(lifecycle.current).threadId) ?? '';
  const passed = lifecycle.inputRemoved
    && asString(completedTurn.id) === requested.pendingInput.turnId
    && asString(completedTurn.status) === 'completed'
    && threadIdBeforeResolve === threadIdAfterResolve;

  return {
    result: passed ? 'PASS' : 'FAIL',
    evidence: {
      runId: run.id,
      threadIdBeforeResolve,
      threadIdAfterResolve,
      status: asString(asRecord(lifecycle.current).status) ?? 'unknown',
      chosenAnswer: selection.chosenLabel,
      pendingInput: requested.pendingInput,
      inputRemoved: lifecycle.inputRemoved,
      requestUserInputObserved: !!requestRecord,
      requestRecord: requestRecord ?? null,
      serverRequestResolved: lifecycle.resolvedNotification.params,
      completedTurn,
      transportServerRequests: harness.clientRecords.flatMap((record) => record.serverRequests.map((request) => ({
        sessionId: record.sessionId,
        method: request.method,
        policy: request.policy,
      }))),
      collaborationModes: harness.clientRecords.flatMap((record) => record.collaborationModes),
      forcedPlanTurns: harness.clientRecords.reduce((total, record) => total + record.forcedPlanTurns, 0),
      failures: passed ? [] : [
        !lifecycle.inputRemoved ? 'inputNotRemoved' : '',
        asString(completedTurn.id) !== requested.pendingInput.turnId ? 'turnChanged' : '',
        asString(completedTurn.status) !== 'completed' ? 'turnNotCompleted' : '',
        threadIdBeforeResolve !== threadIdAfterResolve ? 'threadChanged' : '',
      ].filter(Boolean),
    },
  };
}

async function runDefaultPersistentCompletionSmoke(
  harness: RuntimeHarness,
  persistentWorkspace: string,
): Promise<SmokeStepResult> {
  const store = harness.modules.errands.useButlerErrandRuns;
  const recordStart = harness.clientRecords.length;
  const spec: DispatchSpec = {
    title: '管家默认委托完成 smoke',
    goal: '在真实默认 Codex 模式中完成一个无副作用的短任务，输出 RCX_BUTLER_RUNTIME_DONE_OK，并把当前 Goal 标记为 complete。',
    acceptance: [
      '最终回复包含 RCX_BUTLER_RUNTIME_DONE_OK。',
      '当前 Goal 状态为 complete。',
      '不访问网络、不读写文件。',
    ],
    boundaries: [
      '不要请求用户输入或审批。',
      '不要访问真实业务系统。',
    ],
    evidence: [],
  };
  const environment = harness.modules.environments.useAgentEnvironments.getState().environments
    .find((candidate) => candidate.path === persistentWorkspace);
  if (!environment) throw new Error('host-input smoke 未留下可复用的工作区注册');
  const run = await store.getState().dispatchErrand(spec, {
    id: environment.id,
    name: environment.name,
    path: environment.path,
  }, {
    readOnly: true,
  });

  let completed: unknown;
  try {
    completed = await waitFor('默认委托完成并回收结果', 45_000, () => {
      const current = store.getState().runs.find((candidate) => candidate.id === run.id);
      if (!current) throw new Error('派活记录已丢失');
      const status = asString(asRecord(current).status);
      return status === 'replied' || status === 'failed' ? current : undefined;
    });
  } catch (error) {
    const current = store.getState().runs.find((candidate) => candidate.id === run.id);
    return {
      result: 'FAIL',
      evidence: {
        reason: 'defaultCompletionTimedOut',
        error: error instanceof Error ? error.message : String(error),
        run: current ?? null,
        notificationMethods: harness.clientRecords.slice(recordStart)
          .flatMap((record) => record.notifications.map((item) => item.method)),
      },
    };
  }

  const reply = asString(asRecord(completed).reply) ?? '';
  const threadId = asString(asRecord(completed).threadId) ?? '';
  const records = harness.clientRecords.slice(recordStart);
  const goalCompletedObserved = records.some((record) => record.notifications.some((notification) => {
    const params = asRecord(notification.params);
    return notification.method === 'thread/goal/updated'
      && asString(params.threadId) === threadId
      && asString(asRecord(params.goal).status) === 'complete';
  }));
  const passed = asString(asRecord(completed).status) === 'replied'
    && reply.includes('RCX_BUTLER_RUNTIME_DONE_OK')
    && goalCompletedObserved
    && records.every((record) => record.forcedPlanTurns === 0);

  return {
    result: passed ? 'PASS' : 'FAIL',
    evidence: {
      runId: run.id,
      threadId,
      status: asString(asRecord(completed).status) ?? 'unknown',
      goalCompletedObserved,
      replyExcerpt: excerpt(reply, 320),
      forcedPlanTurns: records.reduce((total, record) => total + record.forcedPlanTurns, 0),
      serverRequests: records.flatMap((record) => record.serverRequests.map((request) => ({
        method: request.method,
        policy: request.policy,
      }))),
      notificationMethods: records.flatMap((record) => record.notifications.map((item) => item.method)),
    },
  };
}

async function runPersistentErrandSmoke(
  harness: RuntimeHarness,
  persistentWorkspace: string,
): Promise<SmokeStepResult> {
  await writeHostInputAgentsFile(persistentWorkspace);
  harness.setErrandPlanMode(true);
  const hostInput = await runHostInputProtocolSmoke(harness, persistentWorkspace).catch((error) => ({
    result: 'FAIL' as const,
    evidence: { error: error instanceof Error ? error.message : String(error) },
  }));

  const store = harness.modules.errands.useButlerErrandRuns;
  const activeRuns = store.getState().runs.filter((run) =>
    run.status === 'running' || run.status === 'awaiting-approval' || run.status === 'paused');
  for (const run of activeRuns) {
    await store.getState().stopErrand(run.id).catch(() => undefined);
  }

  harness.setErrandPlanMode(false);
  await writeDefaultCompletionAgentsFile(persistentWorkspace);
  const defaultCompletion = await runDefaultPersistentCompletionSmoke(harness, persistentWorkspace).catch((error) => ({
    result: 'FAIL' as const,
    evidence: { error: error instanceof Error ? error.message : String(error) },
  }));

  return {
    result: hostInput.result === 'PASS' && defaultCompletion.result === 'PASS' ? 'PASS' : 'FAIL',
    evidence: {
      hostInput,
      defaultCompletion,
    },
  };
}

async function runEphemeralSkillSmoke(
  harness: RuntimeHarness,
  routineWorkspace: string,
): Promise<SmokeStepResult> {
  harness.setRoutineWorkspaceRoot(routineWorkspace);
  const skillPath = await copyRoomDigestSkill(routineWorkspace);
  const routineStore = harness.modules.routines.useRoutines;
  const now = Date.now();
  harness.modules.profile.setSkillEnabled('room-digest', true);
  const skillEnabled = harness.modules.profile.isButlerSkillEnabled('room-digest');
  let workflowAdmission: JsonRecord;
  try {
    const value = await harness.modules.butler.runButlerWorkflowTask({
      key: `smoke:workflow-admission:${now}`,
      kind: 'routine',
      goal: '验证定时 Skill workflow 可以进入 execute。',
      triggerReason: 'smoke-admission',
      execute: async () => ({ value: 'admitted', summary: 'workflow admission smoke 已完成。' }),
    });
    workflowAdmission = { admitted: value === 'admitted', value };
  } catch (error) {
    workflowAdmission = {
      admitted: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
  routineStore.setState({
    routines: [],
    eventCards: [],
    seenKeys: [],
    unloadedTemplateIds: [],
    runningIds: [],
    hydrated: true,
  });
  const routineId = `smoke-room-digest-${now}`;
  routineStore.getState().addRoutine({
    id: routineId,
    name: 'Smoke room-digest',
    trigger: { kind: 'interval', everyMinutes: 15 },
    delivery: 'today',
    enabled: true,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    skillName: 'room-digest',
    precheck: 'none',
    runs: [],
  });

  const dueBeforeTick = harness.modules.routines.dueRoutines(routineStore.getState().routines, now)
    .map((routine) => routine.id);
  await routineStore.getState().tick(now);
  let routine = routineStore.getState().routines.find((candidate) => candidate.id === routineId);
  const scheduledRunObserved = (routine?.runs.length ?? 0) > 0;
  if (!scheduledRunObserved) {
    await routineStore.getState().runNow(routineId, { triggerReason: 'manual-smoke-diagnostic' });
    routine = routineStore.getState().routines.find((candidate) => candidate.id === routineId);
  }
  const latestRun = routine?.runs[0];
  const passed = skillEnabled
    && dueBeforeTick.includes(routineId)
    && scheduledRunObserved
    && !!latestRun
    && latestRun.status === 'ok'
    && !!latestRun.text.trim();

  return {
    result: passed ? 'PASS' : 'FAIL',
    evidence: {
      routineId,
      trigger: { kind: 'interval', everyMinutes: 15 },
      skillPath,
      skillEnabled,
      workflowAdmission,
      dueBeforeTick,
      scheduledRunObserved,
      manualDiagnosticInvoked: !scheduledRunObserved,
      routineFound: !!routine,
      runCount: routine?.runs.length ?? 0,
      runningIdsAfterTick: routineStore.getState().runningIds,
      lastFiredDate: routine?.lastFiredDate ?? null,
      latestRun: latestRun ?? null,
      resultExcerpt: excerpt(latestRun?.text, 320),
      runtimeErrors: harness.routineErrors.map((error) => excerpt(error, 1_000)),
      note: '本场景故意不传 rooms，让复制到临时工作区的 room-digest Skill 直接因缺少范围而返回非空结果，从而避免访问真实业务系统。',
    },
  };
}

async function cleanupHarness(
  harness: RuntimeHarness,
  invocation: CodexInvocation,
  tempRoot: string,
): Promise<SmokeStepResult> {
  const runs = harness.modules.errands.useButlerErrandRuns.getState().runs;
  const archived: Array<{ threadId: string; archived: boolean }> = [];
  for (const run of runs) {
    const threadId = asString(asRecord(run).threadId);
    if (!threadId) continue;
    const workspaceRoot = asString(asRecord(run).workspaceRoot) ?? tempRoot;
    archived.push({
      threadId,
      archived: await safeArchiveThread(invocation, workspaceRoot, threadId),
    });
  }

  await harness.modules.errands.useButlerErrandRuns.getState().reset().catch(() => undefined);
  harness.modules.environments.useAgentEnvironments.setState({
    version: 1,
    environments: [],
    bindings: [],
    lastEnvironmentByProject: {},
    lastDispatchEnvironmentId: undefined,
  });
  harness.modules.routines.useRoutines.setState({
    routines: [],
    eventCards: [],
    seenKeys: [],
    unloadedTemplateIds: [],
    runningIds: [],
    hydrated: false,
  });

  harness.restoreErrandFactory();
  harness.restoreCodexTransportFactory();
  harness.restoreCodexWorkspaceResolver();
  harness.restoreRoutineCodexRunner();
  harness.restoreButlerPersistence();
  harness.restoreRoutineStorage();
  harness.restoreProfileStorage();
  harness.restoreAuth();
  harness.restoreButlerBrainTauri();
  harness.restoreButlerBrainStorage();
  harness.restoreLocalStorage();
  harness.modules.brain.setCodexBrainUnavailableReason(undefined);
  await Promise.all(harness.clientRecords.map((record) => record.client.stop().catch(() => undefined)));
  await removeSpikeTempRoot(tempRoot, 'rocketx-butler-runtime-');

  return {
    result: archived.every((item) => item.archived) || archived.length === 0 ? 'PASS' : 'FAIL',
    evidence: {
      archivedThreads: archived,
      stoppedClients: harness.clientRecords.length,
      tempRootRemoved: true,
      localStorageEntries: harness.memoryStorage.length,
    },
  };
}

async function main(): Promise<void> {
  const invocation = codexInvocation(codexRuntimeSourceFromArgs());
  const tempRoot = await mkdtemp(join(tmpdir(), 'rocketx-butler-runtime-'));
  const persistentWorkspace = join(tempRoot, 'persistent-workspace');
  const routineWorkspace = join(tempRoot, 'routine-workspace');
  await Promise.all([prepareWorkspace(persistentWorkspace), prepareWorkspace(routineWorkspace)]);

  const assumptions = [
    'host-input 使用真实 Codex Plan 模式触发 request_user_input，以 serverRequest/resolved 与同一 turn/completed 作为协议完成证据。',
    '普通持久委托另用默认模式验证最终消息与 Goal complete，避免把 Plan 输出误当作普通 agentMessage。',
    '例行 Skill 使用系统最短的 15 分钟 interval，并利用首次运行立即到期语义触发；复制仓库内 room-digest 到临时工作区且不传 rooms，以避免访问真实业务系统。',
  ];

  const harness = await createHarness(invocation);
  let persistentErrand: SmokeStepResult = { result: 'SKIP', evidence: { reason: 'not-run' } };
  let ephemeralSkill: SmokeStepResult = { result: 'SKIP', evidence: { reason: 'not-run' } };
  let cleanup: SmokeStepResult = { result: 'SKIP', evidence: { reason: 'not-run' } };

  try {
    ephemeralSkill = await runEphemeralSkillSmoke(harness, routineWorkspace).catch((error) => ({
      result: 'FAIL' as const,
      evidence: { error: error instanceof Error ? error.message : String(error) },
    }));
    persistentErrand = await runPersistentErrandSmoke(harness, persistentWorkspace).catch((error) => ({
      result: 'FAIL' as const,
      evidence: { error: error instanceof Error ? error.message : String(error) },
    }));
  } finally {
    cleanup = await cleanupHarness(harness, invocation, tempRoot).catch((error) => ({
      result: 'FAIL' as const,
      evidence: {
        error: error instanceof Error ? error.message : String(error),
        tempRoot,
      },
    }));
  }

  const mainlineAdaptation: string[] = [];
  mainlineAdaptation.push('如果 host-input 的 inputId 不等于 itemId，这个脚本要跟随主线实际字段名同步 pendingInputFromRun() 的提取逻辑。');

  const report: SmokeReport = {
    smoke: 'butler-runtime',
    result: persistentErrand.result === 'PASS' && ephemeralSkill.result === 'PASS' && cleanup.result === 'PASS'
      ? 'PASS'
      : 'FAIL',
    runtime: {
      source: invocation.source,
      version: invocation.version,
      path: invocation.displayPath,
    },
    assumptions,
    persistentErrand,
    ephemeralSkill,
    cleanup,
    notes: {
      mainlineAdaptation,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASS' ? 0 : 1;
}

if (isDirectExecution()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
