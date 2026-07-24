import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import { getServerBase, realtime, rest } from '../../apps/web/src/lib/client';
import { setButlerMentionProvider } from '../../apps/web/src/lib/butlerTools';
import { createButlerTools, type ButlerRoutineDraft } from '../../apps/web/src/lib/butlerTools';
import {
  formatButlerToolResult,
  type ButlerToolCheckpoint,
  type ButlerToolRuntimeContext,
} from '../../apps/web/src/lib/butlerToolRuntime';
import { useAuth } from '../../apps/web/src/stores/auth';
import {
  flushButlerPersist,
  resetButlerPersistenceForTests,
  setButlerLoopRunner,
  setButlerPersistence,
  useButler,
} from '../../apps/web/src/stores/butler';
import { useCalendar } from '../../apps/web/src/stores/calendar';
import { useChat } from '../../apps/web/src/stores/chat';
import { useRoutines } from '../../apps/web/src/stores/routines';
import { useTodos } from '../../apps/web/src/stores/todos';
import { useWorkbench } from '../../apps/web/src/stores/workbench';

const SERVER_KEY = 'rcx-server';
const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
const restorePersistence = setButlerPersistence(appData);
const storageShim = new Map<string, string>();
const localStorageShim = {
  getItem(key: string) {
    return storageShim.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    storageShim.set(key, String(value));
  },
  removeItem(key: string) {
    storageShim.delete(key);
  },
};

function ensureStorageApi(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageShim,
    configurable: true,
    writable: true,
  });
}

function storageSet(key: string, value: string): void {
  ensureStorageApi();
  localStorageShim.setItem(key, value);
}

function storageRemove(key: string): void {
  ensureStorageApi();
  localStorageShim.removeItem(key);
}

ensureStorageApi();

type ScenarioCompletion = 'complete' | 'partial' | 'gap';

interface ScenarioBaseline {
  completion: ScenarioCompletion;
  capabilityPreflight: string;
  sources: string[];
  errorAction: string;
  clarification: string;
  recovery: string;
}

type RoutineDraftWithCheckpoint = ButlerRoutineDraft & { checkpointId?: string };

interface RuntimeHarness {
  checkpoints: Map<string, ButlerToolCheckpoint>;
  approvals: ButlerToolCheckpoint[];
  context: ButlerToolRuntimeContext;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function tool(name: string) {
  const found = createButlerTools().find((item) => item.name === name);
  assert.ok(found, `缺少工具 ${name}`);
  return found;
}

function runtimeHarness(now = Date.UTC(2026, 6, 23, 9, 30)): RuntimeHarness {
  const checkpoints = new Map<string, ButlerToolCheckpoint>();
  const approvals: ButlerToolCheckpoint[] = [];
  const syncRuntimeCheckpoints = () => {
    useButler.setState({ runtimeCheckpoints: [...checkpoints.values()] });
  };
  return {
    checkpoints,
    approvals,
    context: {
      now: () => now,
      loadCheckpoint: async (id) => checkpoints.get(id),
      saveCheckpoint: async (checkpoint) => {
        checkpoints.set(checkpoint.id, checkpoint);
        syncRuntimeCheckpoints();
      },
      requestApproval: async (checkpoint) => {
        approvals.push(checkpoint);
        if (checkpoint.toolName !== 'draft_routine') return;
        const params = checkpoint.params as Record<string, unknown>;
        useButler.getState().setRoutineDraft({
          name: String(params.name ?? ''),
          time: String(params.time ?? ''),
          days: Array.isArray(params.days) ? params.days as number[] : undefined,
          skillName: String(params.skillName ?? ''),
          checkpointId: checkpoint.id,
        } as RoutineDraftWithCheckpoint);
      },
    },
  };
}

async function invokeTool(
  name: string,
  args: Record<string, unknown>,
  context: ButlerToolRuntimeContext = {},
): Promise<{ text: string; checkpoint?: ButlerToolCheckpoint; status: string }> {
  const result = await tool(name).invoke(args, context);
  return {
    text: formatButlerToolResult(result),
    checkpoint: result.checkpoint,
    status: result.status,
  };
}

function toolNames(): Set<string> {
  return new Set(createButlerTools().map((item) => item.name));
}

async function searchLoadedMessages(args: Record<string, unknown>): Promise<string> {
  const originalRealtimeCall = realtime.call;
  const originalRestSearchMessages = rest.searchMessages;
  realtime.call = (async (method: string) => {
    if (method === 'rocketchatSearch.getProvider') {
      return { settings: { GlobalSearchEnabled: true } };
    }
    if (method === 'rocketchatSearch.search') {
      return { message: { docs: [] } };
    }
    throw new Error(`测试未 stub 的 realtime 方法：${method}`);
  }) as typeof realtime.call;
  rest.searchMessages = async () => [];

  try {
    return (await invokeTool('search_messages', args)).text;
  } finally {
    realtime.call = originalRealtimeCall;
    rest.searchMessages = originalRestSearchMessages;
  }
}

function resetStores(): void {
  useButler.getState().reset();
  useRoutines.setState({ routines: [], eventCards: [], seenKeys: [], runningIds: [], hydrated: false });
  useWorkbench.setState({
    config: null,
    configRevision: 0,
    workItems: [],
    prs: [],
    builds: [],
    loading: false,
    error: null,
    lastRefresh: null,
  });
  useTodos.setState({ todos: [] });
  useCalendar.setState({
    events: [],
    view: 'month',
    cursor: '2026-07-22',
    selectedDate: '2026-07-22',
  });
  useChat.setState({
    subscriptions: {},
    rooms: {},
    messages: {},
    activeRid: null,
  } as never);
  useAuth.setState({ user: undefined } as never);
  storageRemove(SERVER_KEY);
  resetButlerPersistenceForTests();
}

function login(userId: string): void {
  useAuth.setState({ user: { _id: userId, username: `user-${userId}` } as never });
}

test.after(() => restorePersistence());
test.afterEach(() => resetStores());

test('场景基线 1/7：找昨日某人文件', async () => {
  const baseline: ScenarioBaseline = {
    completion: 'partial',
    capabilityPreflight: '知道发送人、日期和是否带文件后，可直接命中；别名、多候选和跨 session 上下文还没有编译层。',
    sources: ['search_messages'],
    errorAction: '不会直接写消息、工作项或本地文件。',
    clarification: '如果“某人”不是明确姓名，当前仍缺少系统化别名/澄清回路。',
    recovery: '重问同一筛选条件可重复执行；结果不持久化为独立调查 session。',
  };

  useChat.setState({
    subscriptions: {
      'room-design': { rid: 'room-design', fname: '设计讨论', name: 'design' },
    },
    rooms: {
      'room-design': { _id: 'room-design', fname: '设计讨论', name: 'design' },
    },
    messages: {
      'room-design': [
        {
          _id: 'msg-file-1',
          rid: 'room-design',
          msg: '老李把昨日设计稿发上来了',
          ts: '2026-07-21T09:10:00.000Z',
          u: { _id: 'u-li', username: 'laoli', name: '老李' },
          file: { name: '设计稿-v2.pdf' },
        },
      ],
    },
  } as never);

  const raw = await searchLoadedMessages({
    query: '设计稿',
    from: '老李',
    roomName: '设计讨论',
    since: '2026-07-21',
    until: '2026-07-21',
    hasFile: true,
  });
  const rows = parseJson<Array<Record<string, string>>>(raw);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].roomName, '设计讨论');
  assert.equal(rows[0].sender, '老李');
  assert.equal(rows[0].text, '老李把昨日设计稿发上来了');
  assert.equal(baseline.completion, 'partial');
});

test('场景基线 2/7：比较两个 PR', async () => {
  const baseline: ScenarioBaseline = {
    completion: 'complete',
    capabilityPreflight: '能按明确编号读取 PR 固定快照、文件变更和受限文本正文。',
    sources: ['list_pull_requests', 'run_azure_devops_server_cli'],
    errorAction: '不会自动合并、评论或修改 PR。',
    clarification: '若用户没给出两个 PR 编号，先要求补齐，不能从已加载列表中猜。',
    recovery: '固定 iteration 可重复读取；正文不可用时降级为元数据与文件清单结论。',
  };

  useWorkbench.setState({
    config: { adoBase: 'https://ado.example', account: 'alice@example.com' } as never,
    prs: [
      {
        id: 101,
        title: '支付服务重试逻辑',
        repo: 'payments',
        project: '商城',
        creator: 'Alice',
        creatorUnique: 'alice@example.com',
        reviewers: [{ name: 'Bob', unique: 'bob@example.com', vote: 0 }],
        sourceBranch: 'feature/retry',
        targetBranch: 'main',
        webUrl: 'https://ado.example/pr/101',
      },
      {
        id: 102,
        title: '支付服务超时治理',
        repo: 'payments',
        project: '商城',
        creator: 'Carol',
        creatorUnique: 'carol@example.com',
        reviewers: [{ name: 'Alice', unique: 'alice@example.com', vote: 0 }],
        sourceBranch: 'feature/timeout',
        targetBranch: 'main',
        webUrl: 'https://ado.example/pr/102',
      },
    ],
  });

  const rows = parseJson<Array<Record<string, string | number>>>(
    (await invokeTool('list_pull_requests', { query: '支付服务' })).text,
  );
  const names = toolNames();

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.id), [101, 102]);
  assert.equal(names.has('compare_pull_requests'), false);
  assert.equal(names.has('get_pull_request'), false);
  assert.equal(names.has('list_pull_request_changes'), false);
  assert.equal(names.has('read_pull_request_file'), false);
  assert.equal(names.has('run_azure_devops_server_cli'), true);
  assert.equal(baseline.completion, 'complete');
});

test('场景基线 3/7：群聊提取承诺', async () => {
  const baseline: ScenarioBaseline = {
    completion: 'gap',
    capabilityPreflight: '当前只能检索原始消息，缺少 commitment/context compiler 与 task-state 结构化提取。',
    sources: ['search_messages'],
    errorAction: '不会把群聊里提到的承诺静默写成待办、工作项或记忆。',
    clarification: '没有“这是承诺/截止时间/负责人”的显式澄清层。',
    recovery: '可重复搜索原始消息；提取承诺仍需人工判读。',
  };

  useChat.setState({
    subscriptions: {
      'room-dev': { rid: 'room-dev', fname: '研发群', name: 'dev' },
    },
    rooms: {
      'room-dev': { _id: 'room-dev', fname: '研发群', name: 'dev' },
    },
    messages: {
      'room-dev': [
        {
          _id: 'msg-commit-1',
          rid: 'room-dev',
          msg: '我周四前补发布文档。',
          ts: '2026-07-22T09:00:00.000Z',
          u: { _id: 'u-a', username: 'alice', name: 'Alice' },
        },
        {
          _id: 'msg-commit-2',
          rid: 'room-dev',
          msg: '我来跟进 CI 红灯，今晚前给结果。',
          ts: '2026-07-22T09:05:00.000Z',
          u: { _id: 'u-b', username: 'bob', name: 'Bob' },
        },
      ],
    },
  } as never);

  const rows = parseJson<Array<Record<string, string>>>(
    await searchLoadedMessages({
      query: '前',
      roomName: '研发群',
      since: '2026-07-22',
      until: '2026-07-22',
    }),
  );
  const names = toolNames();

  assert.equal(rows.length, 2);
  assert.equal(names.has('summarize_room'), false);
  assert.equal(names.has('extract_commitments'), false);
  assert.equal(baseline.completion, 'gap');
});

test('场景基线 4/7：逾期 WI 跟进草稿', async () => {
  const baseline: ScenarioBaseline = {
    completion: 'partial',
    capabilityPreflight: '能列出逾期工作项事实，但缺少预检后的 typed 跟进草稿、审批和 checkpoint。',
    sources: ['list_work_items'],
    errorAction: '不会自动给负责人发催办消息，也不会创建/修改工作项。',
    clarification: '当前不会追问“催谁、用什么口径、发到哪里”。',
    recovery: '重查可再次列逾期项；跟进草稿仍需人工整理。',
  };

  useWorkbench.setState({
    workItems: [
      {
        id: 501,
        title: '付款接口联调',
        type: 'User Story',
        state: '活动',
        project: '商城',
        assignedTo: '张三',
        dueDate: '2026-07-20T00:00:00.000Z',
        webUrl: 'https://ado.example/wi/501',
      },
    ],
  });

  const rows = parseJson<Array<Record<string, string | number>>>(
    (await invokeTool('list_work_items', { query: '付款接口' })).text,
  );
  const draftTools = [...toolNames()].filter((name) => name.startsWith('draft_'));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 501);
  assert.equal(rows[0].assignedTo, '张三');
  assert.deepEqual(draftTools, ['draft_routine']);
  assert.equal(baseline.completion, 'partial');
});

test('场景基线 5/7：构建失败关联提交', async () => {
  const baseline: ScenarioBaseline = {
    completion: 'gap',
    capabilityPreflight: '当前能列失败构建，但没有变更集/提交关联层，也没有失败原因预检合同。',
    sources: ['list_builds'],
    errorAction: '不会自动回滚、重试构建或修改代码。',
    clarification: '不会追问应该关联哪个仓库、哪个 PR、哪段变更。',
    recovery: '可重复筛失败构建；提交关联需要后续 typed tool/runtime 补足。',
  };

  useWorkbench.setState({
    builds: [
      {
        id: 9001,
        buildNumber: 'CI_20260722.3',
        definition: 'payments-ci',
        project: '商城',
        status: 'completed',
        result: 'failed',
        requestedFor: 'Alice',
        queueTime: '2026-07-22T08:00:00.000Z',
        finishTime: '2026-07-22T08:12:00.000Z',
        webUrl: 'https://ado.example/build/9001',
      },
    ],
  });

  const rows = parseJson<Array<Record<string, string | number>>>(
    (await invokeTool('list_builds', { query: 'payments-ci', failedOnly: true })).text,
  );
  const names = toolNames();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, 'failed');
  assert.equal(names.has('list_commits'), false);
  assert.equal(names.has('list_build_changes'), false);
  assert.equal(baseline.completion, 'gap');
});

test('场景基线 6/7：创建周报例行任务', async () => {
  const baseline: ScenarioBaseline = {
    completion: 'complete',
    capabilityPreflight: '已具备 weekly-report 技能与 draft_routine 草案闸门，可确认后落到 routines store。',
    sources: ['load_skill', 'draft_routine'],
    errorAction: '不会绕过确认直接启用例行任务。',
    clarification: '技能名、时间或星期非法时会直接拒绝。',
    recovery: '用户可重新生成草案并再次确认；重启后 routines 走既有持久化路径。',
  };

  const runtime = runtimeHarness();
  const skillBody = (await invokeTool('load_skill', { name: 'weekly-report' })).text;
  const draftResult = await tool('draft_routine').invoke({
    name: '每周周报',
    time: '18:30',
    days: [5],
    skillName: 'weekly-report',
  }, runtime.context);

  assert.match(skillBody, /周报/);
  assert.equal(draftResult.status, 'approval-required');
  assert.match(formatButlerToolResult(draftResult), /approval-required/);
  assert.equal(runtime.approvals.length, 1);
  const draft = useButler.getState().routineDraft as RoutineDraftWithCheckpoint | null;
  assert.ok(draft);
  assert.equal(draft.name, '每周周报');
  assert.equal(draft.time, '18:30');
  assert.deepEqual(draft.days, [5]);
  assert.equal(draft.skillName, 'weekly-report');
  assert.equal(draft.checkpointId, draftResult.checkpoint?.id);
  assert.equal(useRoutines.getState().routines.length, 0);

  const originalApprove = useButler.getState().approveToolCheckpoint;
  useButler.setState({
    approveToolCheckpoint: async (checkpointId) => {
      const checkpoint = runtime.checkpoints.get(checkpointId);
      assert.ok(checkpoint, `缺少 checkpoint ${checkpointId}`);
      const draftRoutine = tool('draft_routine');
      assert.ok(draftRoutine.approve, 'draft_routine 缺少 approve');
      const approved = await draftRoutine.approve(checkpoint, runtime.context);
      assert.equal(approved.status, 'completed');
      useButler.setState((state) => ({
        routineDraft: state.routineDraft?.checkpointId === checkpointId ? null : state.routineDraft,
      }));
    },
  });
  try {
    await useButler.getState().confirmRoutineDraft();
  } finally {
    useButler.setState({ approveToolCheckpoint: originalApprove });
  }
  const created = useRoutines.getState().routines[0];
  assert.ok(created);
  assert.equal(created.name, '每周周报');
  assert.equal(created.skillName, 'weekly-report');
  assert.equal(created.enabled, true);
  assert.equal(baseline.completion, 'complete');
});

test('场景基线 7/7：跨重启续跑', async () => {
  const baseline: ScenarioBaseline = {
    completion: 'partial',
    capabilityPreflight: '同一 server scope + userId 下可恢复共享 Butler 会话，但仍受单 session 与 3 天 TTL 约束。',
    sources: ['builtin:butler 持久化', 'useButler.hydrate'],
    errorAction: '不会跨账号或跨服务器串用历史。',
    clarification: '当前不会把恢复点拆成多 task state / transcript session。',
    recovery: '刷新或重启后可在同 scope 下继续对话；超过 TTL 则只回看不续跑。',
  };

  storageSet(SERVER_KEY, 'https://chat.example.com');
  login('resume-user');
  const restoreRunner = setButlerLoopRunner(async (options) => ({
    text: `回复：${String(options.messages.at(-1)?.content ?? '')}`,
    messages: options.messages,
  }));

  try {
    await useButler.getState().hydrate();
    await useButler.getState().ask('调查昨天的问题');
    await flushButlerPersist();

    const scope = `${getServerBase() || 'same-origin'}:resume-user`;
    const stored = await appData.get<Record<string, unknown>>('builtin:butler', scope);
    assert.ok(stored, '应按 server scope + userId 持久化');
    const registry = await appData.get<{
      sessions: Array<{ taskState?: { goal: string; status: string; manifest: { schemaVersion: number } } }>;
    }>('builtin:butler', `session-registry:${scope}`);
    const taskState = registry?.sessions[0]?.taskState;
    assert.equal(taskState?.goal, '调查昨天的问题');
    assert.equal(taskState?.status, 'completed');
    assert.equal(taskState?.manifest.schemaVersion, 1);

    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '调查昨天的问题'), true);
    assert.equal(useButler.getState().taskState?.goal, '调查昨天的问题');

    await useButler.getState().ask('补充第二个问题');
    assert.deepEqual(
      useButler.getState().history.slice(-4).map(({ role, content }) => ({ role, content })),
      [
        { role: 'user', content: '调查昨天的问题' },
        { role: 'assistant', content: '回复：调查昨天的问题' },
        { role: 'user', content: '补充第二个问题' },
        { role: 'assistant', content: '回复：补充第二个问题' },
      ],
    );
    assert.equal(baseline.completion, 'partial');
  } finally {
    restoreRunner();
  }
});

test('不完整指代不调用大脑，补齐后把任务合同注入实际回合', async () => {
  login('clarify-user');
  let calls = 0;
  let systemPrompt = '';
  const restoreRunner = setButlerLoopRunner(async (options) => {
    calls += 1;
    systemPrompt = String(options.messages[0]?.content ?? '');
    return { text: '已完成只读比较。', messages: options.messages };
  });

  try {
    await useButler.getState().ask('比较这两个 PR');
    assert.equal(calls, 0);
    assert.equal(useButler.getState().taskState?.status, 'awaiting-clarification');
    assert.equal(useButler.getState().lines.at(-1)?.text, '请给出要比较的两个 PR 编号。');

    await useButler.getState().ask('PR #101 和 PR #102');
    assert.equal(calls, 1);
    assert.equal(useButler.getState().taskState?.status, 'completed');
    assert.match(systemPrompt, /"scenario":"compare-pull-requests"/);
    assert.match(systemPrompt, /"tool":"run_azure_devops_server_cli"/);
    assert.match(systemPrompt, /"freshness":"query-time"/);
    assert.match(systemPrompt, /不评论、合并或修改 PR/);
  } finally {
    restoreRunner();
  }
});
