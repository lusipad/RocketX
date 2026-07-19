import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRoundsResult,
  latestBuildsByDefinitionProject,
  runButlerRounds,
  type RoundsInput,
} from '../../apps/web/src/kernel/ai/features/butler-rounds';
import type { AiChatRequest, AiChunk } from '../../apps/web/src/kernel/ai/provider';
import type { AiChatGateway } from '../../apps/web/src/kernel/ai/features/structured-output';
import { ledgerFromTodos } from '../../apps/web/src/lib/butlerLedger';
import {
  codexEphemeralGateway,
  runRoundsWithBrain,
  setButlerRoundsCodexRunner,
} from '../../apps/web/src/lib/butlerRoundsBrain';
import {
  runButlerRoundsNow,
  useButlerRoundsRunner,
  type StoredRoundsResult,
} from '../../apps/web/src/lib/butlerRoundsRunner';
import {
  setButlerBrain,
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
  type ButlerBrainStorage,
} from '../../apps/web/src/lib/butlerBrain';
import { loadAiSettings } from '../../apps/web/src/kernel/ai/config';
import type { Todo } from '../../apps/web/src/stores/todos';
import type { Build } from '../../apps/web/src/stores/workbench';

class MemoryStorage implements ButlerBrainStorage, Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  getItem(key: string): string | null {
    return this.get(key);
  }

  setItem(key: string, value: string): void {
    this.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
}

function gateway(chunks: AiChunk[], inspect?: (request: AiChatRequest) => void): AiChatGateway {
  return {
    async *chat(_capability, request) {
      inspect?.(request);
      for (const chunk of chunks) yield chunk;
    },
  };
}

function input(overrides: Partial<RoundsInput> = {}): RoundsInput {
  const todos: Todo[] = [{
    id: 't1',
    title: '提交发布说明',
    due: '2026-07-19',
    committedTo: '发布组',
    done: false,
    createdAt: 1,
  }];
  return {
    ledger: ledgerFromTodos(todos, '2026-07-19'),
    todos,
    workItems: [],
    pullRequests: [],
    builds: [],
    iterationEndDate: null,
    localTime: '2026-07-19T12:00:00+08:00',
    lastRoundsAt: null,
    ...overrides,
  };
}

function resultJson(items: unknown[] = []): string {
  return JSON.stringify({
    headline: '今天先处理承诺',
    summary: '有一件事值得现在处理。',
    items,
    proposals: [],
    suppressed: [],
  });
}

test('合法 JSON 会按契约解析，并发送 JSON 模式请求', async () => {
  let request: AiChatRequest | undefined;
  const result = await runButlerRounds(input(), gateway([
    { content: resultJson([{ ref: 'ledger:t1', why: '今天到期', suggestedAction: '上午确认交付' }]), finishReason: 'stop' },
  ], (value) => { request = value; }));

  assert.equal(request?.responseFormat, 'json');
  assert.equal(request?.thinking, 'disabled');
  assert.equal(request?.maxTokens, 1600);
  assert.equal(result.items[0].ref, 'ledger:t1');
  assert.equal(result.items[0].why, '今天到期');
});

test('未知 ref 会让整轮失败', async () => {
  await assert.rejects(
    () => runButlerRounds(input(), gateway([
      { content: resultJson([{ ref: 'todo:invented', why: '虚构条目', suggestedAction: '处理' }]), finishReason: 'stop' },
    ])),
    /不存在的条目: todo:invented/,
  );
});

test('items 超过三条时只保留前三条', async () => {
  const todos: Todo[] = Array.from({ length: 4 }, (_, index) => ({
    id: `t${index + 1}`,
    title: `待办 ${index + 1}`,
    done: false,
    createdAt: index + 1,
  }));
  const result = await runButlerRounds(input({ todos, ledger: [] }), gateway([
    {
      content: resultJson(todos.map((todo) => ({
        ref: `todo:${todo.id}`,
        why: '会漏',
        suggestedAction: '立即处理',
      }))),
      finishReason: 'stop',
    },
  ]));

  assert.deepEqual(result.items.map((item) => item.ref), ['todo:t1', 'todo:t2', 'todo:t3']);
});

test('给不出具体动作的条目会进入工作日志', async () => {
  const result = await runButlerRounds(input(), gateway([
    { content: resultJson([{ ref: 'todo:t1', why: '目前只需要观察' }]), finishReason: 'stop' },
  ]));

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.suppressed, [{ ref: 'todo:t1', reason: '目前只需要观察' }]);
});

function build(overrides: Partial<Build>): Build {
  return {
    id: 1,
    buildNumber: '1',
    definition: 'CI',
    project: 'Alpha',
    status: 'completed',
    result: 'failed',
    requestedFor: 'me',
    queueTime: '2026-07-19T01:00:00Z',
    finishTime: '2026-07-19T01:10:00Z',
    webUrl: 'https://ado.example/build/1',
    ...overrides,
  };
}

test('同一流水线失败后成功时快照只保留后来的成功', async () => {
  const builds = [
    build({ id: 1, result: 'failed', finishTime: '2026-07-19T01:10:00Z' }),
    build({ id: 2, buildNumber: '2', result: 'succeeded', finishTime: '2026-07-19T02:10:00Z' }),
  ];
  assert.deepEqual(latestBuildsByDefinitionProject(builds).map((item) => item.result), ['succeeded']);

  let serializedBuilds: Array<{ result: string }> = [];
  await runButlerRounds(input({ builds }), gateway([
    { content: resultJson(), finishReason: 'stop' },
  ], (request) => {
    serializedBuilds = (JSON.parse(request.messages[1].content) as { builds: Array<{ result: string }> }).builds;
  }));
  assert.deepEqual(serializedBuilds.map((item) => item.result), ['succeeded']);
});

test('有效 finishTime 不会被缺失时间的历史条目覆盖', () => {
  const builds = [
    build({ id: 2, buildNumber: '2', result: 'succeeded', finishTime: '2026-07-19T02:10:00Z' }),
    build({ id: 1, result: 'failed', finishTime: '' }),
  ];
  assert.deepEqual(latestBuildsByDefinitionProject(builds).map((item) => item.result), ['succeeded']);
});

test('Codex adapter 能剥掉完整 JSON 代码围栏', async () => {
  const restore = setButlerRoundsCodexRunner(async () => ({
    text: `\`\`\`json\n${resultJson([{ ref: 'todo:t1', why: '今天到期', suggestedAction: '确认交付' }])}\n\`\`\``,
  }));
  try {
    const result = await runButlerRounds(input(), codexEphemeralGateway());
    assert.equal(result.items[0].ref, 'todo:t1');
  } finally {
    restore();
  }
});

test('选中 Codex 但不可用时直接报错，不回退 API', async () => {
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restoreTauri = setButlerBrainTauriProvider(() => false);
  setCodexBrainUnavailableReason(undefined);
  try {
    setButlerBrain('codex');
    await assert.rejects(() => runRoundsWithBrain(input()), /仅桌面端可用/);
  } finally {
    setCodexBrainUnavailableReason(undefined);
    restoreTauri();
    restoreStorage();
  }
});

test('持久化结果必须满足完整结构和界面用语约束', () => {
  assert.equal(isRoundsResult({
    headline: '今天先处理承诺',
    summary: '有一件事值得现在处理。',
    items: [],
    proposals: [],
    suppressed: [],
  }), true);
  assert.equal(isRoundsResult({
    headline: '旧巡视结果',
    summary: '不应继续展示。',
    items: [],
    proposals: [],
    suppressed: [],
  }), false);
  assert.equal(isRoundsResult({}), false);
});

test('一轮失败时保留上一轮结果并暴露可展示错误', async () => {
  const previous = {
    generatedAt: '2026-07-18T02:00:00.000Z',
    checkedCount: 1,
    refTitles: { 'ledger:t1': '提交发布说明' },
    result: {
      headline: '上一轮仍可看',
      summary: '保留旧结果。',
      items: [],
      proposals: [],
      suppressed: [],
    },
  } satisfies StoredRoundsResult;
  useButlerRoundsRunner.setState({
    lastRoundsAt: previous.generatedAt,
    lastResult: previous,
    running: false,
    error: null,
  });
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restoreTauri = setButlerBrainTauriProvider(() => false);
  try {
    setButlerBrain('codex');
    await runButlerRoundsNow(new Date('2026-07-19T04:00:00.000Z'));
    const state = useButlerRoundsRunner.getState();
    assert.strictEqual(state.lastResult, previous);
    assert.match(state.error ?? '', /仅桌面端可用/);
    assert.equal(state.running, false);
  } finally {
    useButlerRoundsRunner.setState({
      lastRoundsAt: null,
      lastResult: null,
      running: false,
      error: null,
    });
    restoreTauri();
    restoreStorage();
  }
});

test('旧 AI 配置保留自定义 Provider，并为管家简报继承每日回顾路由', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  storage.setItem('rcx-ai-settings-v1', JSON.stringify({
    providers: [{
      id: 'custom',
      kind: 'openai-compatible',
      name: 'Custom',
      baseUrl: 'https://example.com/v1',
      model: 'model-a',
      locality: 'external',
      hasSecret: true,
    }],
    routes: {
      summary: { providerId: 'custom', localOnly: false },
      extraction: { providerId: 'custom', localOnly: false },
      'daily-review': { providerId: 'custom', localOnly: true },
      'text-tool': { providerId: 'custom', localOnly: false },
      agent: { providerId: 'custom', localOnly: false },
    },
  }));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const settings = loadAiSettings();
    assert.equal(settings.providers[0]?.id, 'custom');
    assert.deepEqual(settings.routes['butler-rounds'], { providerId: 'custom', localOnly: true });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('台账只派生未完成的承诺与等待', () => {
  const todos: Todo[] = [
    { id: 'c', title: '答应的事', committedTo: 'Alice', due: '2026-07-19', done: false, createdAt: 1 },
    { id: 'w', note: '等回复', waitingFor: 'Bob', due: '2026-07-18', done: false, createdAt: 2 },
    { id: 'both', title: '双向', committedTo: 'Carol', waitingFor: 'Dave', done: false, createdAt: 3 },
    { id: 'plain', title: '普通待办', done: false, createdAt: 4 },
    { id: 'done', title: '做完了', committedTo: 'Eve', done: true, createdAt: 5 },
  ];

  assert.deepEqual(ledgerFromTodos(todos, '2026-07-19'), [
    { kind: 'commitment', todoId: 'c', who: 'Alice', title: '答应的事', due: '2026-07-19', dueState: 'today' },
    { kind: 'wait', todoId: 'w', who: 'Bob', title: '等回复', due: '2026-07-18', dueState: 'overdue' },
    { kind: 'commitment', todoId: 'both', who: 'Carol', title: '双向', due: undefined, dueState: 'none' },
    { kind: 'wait', todoId: 'both', who: 'Dave', title: '双向', due: undefined, dueState: 'none' },
  ]);
});
