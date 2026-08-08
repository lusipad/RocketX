import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import {
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
} from '../../apps/web/src/lib/butlerBrain';
import { getServerBase, setServerBase } from '../../apps/web/src/lib/client';
import { checkWatchers } from '../../apps/web/src/lib/butlerWatchers';
import {
  setButlerProfileStorage,
  setSkillEnabled,
} from '../../apps/web/src/lib/butlerProfile';
import {
  dueRoutines,
  setRoutineCodexRunner,
  setRoutineNowProvider,
  setRoutineStorage,
  startRoutineScheduler,
  useRoutines,
  type Routine,
} from '../../apps/web/src/stores/routines';
import { useAuth } from '../../apps/web/src/stores/auth';
import {
  listButlerWorkflowSnapshots,
  pauseButlerWorkflowTask,
  resetButlerPersistenceForTests,
  runButlerWorkflowTask,
  setButlerPersistence,
  useButler,
} from '../../apps/web/src/stores/butler';
import { useChat } from '../../apps/web/src/stores/chat';

// 决策 13：Codex 是唯一大脑；测试环境冒充桌面端
const restoreTauriForFile = setButlerBrainTauriProvider(() => true);
test.after(() => restoreTauriForFile());

const MONDAY_0829 = new Date(2026, 0, 5, 8, 29).getTime();
const MONDAY_0830 = new Date(2026, 0, 5, 8, 30).getTime();

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'routine-1',
    name: '测试例行事务',
    trigger: { kind: 'daily', time: '08:30' },
    skillName: 'morning-brief',
    delivery: 'today',
    enabled: true,
    createdAt: MONDAY_0829,
    runs: [],
    ...overrides,
  };
}

function resetRoutineStore(routines: Routine[] = []): void {
  useRoutines.setState({
    routines,
    eventCards: [],
    seenKeys: [],
    runningIds: [],
    hydrated: false,
  });
}

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function setupWorkflowRuntime(userId: string): Promise<() => void> {
  const restorePersistence = setButlerPersistence(
    createRcxStore({ backend: createMemoryBackend() }).appData,
  );
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  useAuth.setState({ user: { _id: userId, username: userId } as never });
  await useButler.getState().hydrate();
  return () => {
    restorePersistence();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    useAuth.setState({ user: undefined } as never);
  };
}

test('hydrate 使用可注入存储并补齐默认停用的内置例行事务', () => {
  const storage = new MemoryStorage();
  storage.set('rcx-butler-v1:routines', JSON.stringify({
    routines: [routine({ id: 'saved' })],
    eventCards: [
      { id: 'event:build:1', kind: 'build-failed', title: '旧构建失败', detail: '已被成功覆盖', at: 1 },
      { id: 'event:workitem:2', kind: 'workitem-assigned', title: '旧指派提醒', detail: '改由提议处理', at: 1 },
    ],
  }));
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  resetRoutineStore();

  try {
    useRoutines.getState().hydrate();
    const routines = useRoutines.getState().routines;
    assert.ok(routines.some((item) => item.id === 'saved'));
    assert.deepEqual(
      routines.filter((item) => item.id.startsWith('builtin-')).map(({ name, enabled }) => ({ name, enabled })),
      [{ name: '晨报', enabled: false }, { name: '晚间回顾', enabled: false }],
    );
    assert.deepEqual(useRoutines.getState().eventCards, []);
  } finally {
    restoreNow();
    restoreStorage();
    resetRoutineStore();
  }
});

test('桌面管理可切换例行事务并持久化', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  resetRoutineStore([routine()]);

  try {
    useRoutines.getState().setEnabled('routine-1', false);
    assert.equal(useRoutines.getState().routines[0].enabled, false);
    const saved = JSON.parse(storage.get('rcx-butler-v1:routines') ?? '{}') as { routines?: Routine[] };
    assert.equal(saved.routines?.[0]?.enabled, false);
  } finally {
    restoreStorage();
    resetRoutineStore();
  }
});

test('已停用技能不能新建对应的内置例行事务', () => {
  const storage = new MemoryStorage();
  const restoreProfile = setButlerProfileStorage(storage);
  const restoreStorage = setRoutineStorage(storage);
  resetRoutineStore();

  try {
    setSkillEnabled('morning-brief', false);
    assert.equal(useRoutines.getState().loadTemplate('morning-brief'), undefined);
    assert.deepEqual(useRoutines.getState().routines, []);
  } finally {
    restoreStorage();
    restoreProfile();
    resetRoutineStore();
  }
});

test('房间汇总模板只保存房间参数并引用原生 Skill，不再复制方法论 prompt', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  resetRoutineStore();

  try {
    const loaded = useRoutines.getState().loadTemplate('room-digest', {
      rooms: ['General', '发布群'],
    });
    assert.equal(loaded?.skillName, 'room-digest');
    assert.equal(loaded?.prompt, undefined);
    assert.deepEqual(loaded?.params?.rooms, ['General', '发布群']);
  } finally {
    restoreStorage();
    resetRoutineStore();
  }
});

test('旧版未编辑的房间汇总迁移到原生 Skill，用户改过的方法仍保留 prompt', () => {
  const storage = new MemoryStorage();
  storage.set('rcx-butler-v1:routines', JSON.stringify({
    routines: [
      routine({
        id: 'room-digest-v1',
        templateId: 'room-digest',
        skillName: undefined,
        prompt: '旧版内置房间汇总方法',
        params: { rooms: ['General'] },
        contractVersion: 1,
      }),
      routine({
        id: 'room-digest-custom',
        templateId: 'room-digest',
        skillName: undefined,
        prompt: '用户改过的房间汇总方法',
        params: { rooms: ['发布群'] },
        contractVersion: 2,
      }),
    ],
    eventCards: [],
  }));
  const restoreStorage = setRoutineStorage(storage);
  resetRoutineStore();

  try {
    useRoutines.getState().hydrate();
    const migrated = useRoutines.getState().routines.find((item) => item.id === 'room-digest-v1');
    assert.equal(migrated?.skillName, 'room-digest');
    assert.equal(migrated?.prompt, undefined);
    const customized = useRoutines.getState().routines.find((item) => item.id === 'room-digest-custom');
    assert.equal(customized?.skillName, undefined);
    assert.equal(customized?.prompt, '用户改过的房间汇总方法');
  } finally {
    restoreStorage();
    resetRoutineStore();
  }
});

test('已停用技能不能重新开启现有例行事务', () => {
  const storage = new MemoryStorage();
  const restoreProfile = setButlerProfileStorage(storage);
  const restoreStorage = setRoutineStorage(storage);
  resetRoutineStore([routine({ enabled: false, templateId: 'morning-brief' })]);

  try {
    setSkillEnabled('morning-brief', false);
    useRoutines.getState().setEnabled('routine-1', true);
    assert.equal(useRoutines.getState().routines[0]?.enabled, false);
  } finally {
    restoreStorage();
    restoreProfile();
    resetRoutineStore();
  }
});

test('调整例行合同会新增版本，回退也留下新的审计版本', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  resetRoutineStore([routine({ prompt: '先核对发布状态' })]);

  try {
    useRoutines.getState().updateContract(
      'routine-1',
      { prompt: '先核对发布状态，再检查回滚责任人' },
      '补充回滚检查',
    );
    let current = useRoutines.getState().routines[0]!;
    assert.equal(current.contractVersion, 2);
    assert.deepEqual(current.versions?.map((version) => version.version), [1, 2]);
    assert.equal(current.versions?.[1]?.reason, '补充回滚检查');

    useRoutines.getState().rollbackContract('routine-1', 1);
    current = useRoutines.getState().routines[0]!;
    assert.equal(current.contractVersion, 3);
    assert.equal(current.prompt, '先核对发布状态');
    assert.equal(current.versions?.[2]?.reason, '回退到 v1');
  } finally {
    restoreNow();
    restoreStorage();
    resetRoutineStore();
  }
});

test('桌面关闭提醒后从事件卡与持久化中一并移除', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  resetRoutineStore([routine()]);
  useRoutines.setState({
    eventCards: [{ id: 'event:mention:r1', kind: 'mention-stale', title: '@我未回应', detail: '仍有一条', at: MONDAY_0830 }],
  });

  try {
    useRoutines.getState().dismissCard('event:mention:r1');
    assert.deepEqual(useRoutines.getState().eventCards, []);
    const saved = JSON.parse(storage.get('rcx-butler-v1:routines') ?? '{}') as { eventCards?: unknown[] };
    assert.deepEqual(saved.eventCards, []);
  } finally {
    restoreStorage();
    resetRoutineStore();
  }
});

test('dueRoutines 只在匹配日期到点后触发一次', () => {
  const daily = routine();
  assert.equal(dueRoutines([daily], MONDAY_0829).length, 0);
  assert.deepEqual(dueRoutines([daily], MONDAY_0830).map((item) => item.id), ['routine-1']);
  assert.equal(dueRoutines([routine({ lastFiredDate: '2026-01-05' })], MONDAY_0830).length, 0);
  assert.equal(dueRoutines([routine({ trigger: { kind: 'daily', time: '08:30', days: [2] } })], MONDAY_0830).length, 0);
  assert.equal(dueRoutines([routine({ enabled: false })], MONDAY_0830).length, 0);
});

test('未登录时 scheduler 不消耗当日触发，登录后仍会执行', async () => {
  const storage = new MemoryStorage();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (_key: string) => undefined,
    },
  });
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  const restoreBrainStorage = setButlerBrainStorage(storage);
  const restorePersistence = setButlerPersistence(
    createRcxStore({ backend: createMemoryBackend() }).appData,
  );
  let calls = 0;
  const restoreRunner = setRoutineCodexRunner(async () => {
    calls += 1;
    return { text: '登录后晨报' };
  });
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  useAuth.setState({ user: undefined } as never);
  useChat.setState({ subscriptions: {}, rooms: {}, messages: {}, activeRid: null } as never);
  setServerBase('https://chat.example');
  resetRoutineStore([routine()]);

  try {
    await useRoutines.getState().tick(MONDAY_0830);
    assert.equal(calls, 0);
    assert.equal(useRoutines.getState().routines[0]?.lastFiredDate, undefined);
    assert.deepEqual(useRoutines.getState().routines[0]?.runs, []);

    await useRoutines.getState().runNow('routine-1');
    assert.equal(useRoutines.getState().routines[0]?.runs[0]?.status, 'error');
    assert.ok(useRoutines.getState().routines[0]?.runs[0]?.text);
    assert.equal(useRoutines.getState().routines[0]?.lastFiredDate, undefined);

    useAuth.setState({ user: { _id: 'routine-login-user', username: 'routine-login' } as never });
    await useButler.getState().hydrate();
    await useRoutines.getState().tick(MONDAY_0830);

    assert.equal(calls, 1);
    assert.equal(useRoutines.getState().routines[0]?.lastFiredDate, '2026-01-05');
    assert.equal(useRoutines.getState().routines[0]?.runs[0]?.status, 'ok');
  } finally {
    restoreRunner();
    restorePersistence();
    restoreBrainStorage();
    restoreNow();
    restoreStorage();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    useAuth.setState({ user: undefined } as never);
    resetRoutineStore();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('runNow 写入成功记录并裁剪到十条', async () => {
  const oldRuns = Array.from({ length: 10 }, (_, index) => ({
    id: `old-${index}`,
    at: MONDAY_0829 - index,
    status: 'ok' as const,
    text: `旧结果 ${index}`,
  }));
  resetRoutineStore([routine({ runs: oldRuns })]);
  let taskText = '';
  const restoreRunner = setRoutineCodexRunner(async (options) => {
    taskText = options.text;
    return { text: '晨报结果' };
  });
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  const restoreWorkflow = await setupWorkflowRuntime('routine-success-user');

  try {
    await useRoutines.getState().runNow('routine-1');
    const runs = useRoutines.getState().routines[0].runs;
    assert.equal(runs.length, 10);
    assert.deepEqual(runs[0], { id: runs[0].id, at: MONDAY_0830, status: 'ok', text: '晨报结果' });
    assert.match(taskText, new RegExp(`上次成功运行时间：${new Date(MONDAY_0829).toISOString()}`));
  } finally {
    restoreNow();
    restoreRunner();
    restoreWorkflow();
    resetRoutineStore();
  }
});

test('保留自定义 prompt 的例行事务仍收到成功游标和房间范围', async () => {
  resetRoutineStore([routine({
    skillName: undefined,
    prompt: '按用户改过的方法汇总。',
    params: { rooms: ['General', '发布群'] },
    precheck: 'none',
    runs: [{
      id: 'previous-success',
      at: MONDAY_0829,
      status: 'ok',
      text: '上次结果',
    }],
  })]);
  let taskText = '';
  const restoreRunner = setRoutineCodexRunner(async (options) => {
    taskText = options.text;
    return { text: '自定义汇总结果' };
  });
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  const restoreWorkflow = await setupWorkflowRuntime('routine-custom-prompt-user');

  try {
    await useRoutines.getState().runNow('routine-1');

    assert.match(taskText, /按用户改过的方法汇总/);
    assert.match(taskText, new RegExp(`上次成功运行时间：${new Date(MONDAY_0829).toISOString()}`));
    assert.match(taskText, /只处理这些房间：General、发布群/);
    assert.equal(useRoutines.getState().routines[0]?.runs[0]?.status, 'ok');
  } finally {
    restoreNow();
    restoreRunner();
    restoreWorkflow();
    resetRoutineStore();
  }
});

test('runNow 在技能停用后写入明确错误且不调用执行器', async () => {
  const storage = new MemoryStorage();
  const restoreProfile = setButlerProfileStorage(storage);
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  let calls = 0;
  const restoreRunner = setRoutineCodexRunner(async () => {
    calls += 1;
    return { text: '不应生成的结果' };
  });
  resetRoutineStore([routine()]);

  try {
    setSkillEnabled('morning-brief', false);
    await useRoutines.getState().runNow('routine-1');

    const run = useRoutines.getState().routines[0]?.runs[0];
    assert.equal(calls, 0);
    assert.equal(run?.status, 'error');
    assert.match(run?.text ?? '', /已停用或已卸载/);
    assert.match(run?.text ?? '', /技能中心/);
  } finally {
    restoreRunner();
    restoreNow();
    restoreStorage();
    restoreProfile();
    resetRoutineStore();
  }
});

test('scheduler 静默跳过已停用技能且不重复写失败记录', async () => {
  const storage = new MemoryStorage();
  const restoreProfile = setButlerProfileStorage(storage);
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  let calls = 0;
  const restoreRunner = setRoutineCodexRunner(async () => {
    calls += 1;
    return { text: '不应生成的结果' };
  });
  resetRoutineStore([routine()]);

  try {
    setSkillEnabled('morning-brief', false);
    await useRoutines.getState().tick(MONDAY_0830);
    await useRoutines.getState().tick(MONDAY_0830);

    assert.equal(calls, 0);
    assert.deepEqual(useRoutines.getState().routines[0]?.runs, []);
    assert.equal(useRoutines.getState().routines[0]?.lastFiredDate, undefined);
  } finally {
    restoreRunner();
    restoreNow();
    restoreStorage();
    restoreProfile();
    resetRoutineStore();
  }
});

test('runNow 将引擎错误转成友好错误，并防止重入', async () => {
  resetRoutineStore([routine()]);
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const restoreRunner = setRoutineCodexRunner(async () => {
    calls += 1;
    await pending;
    throw new Error('unexpected boom');
  });
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  const restoreWorkflow = await setupWorkflowRuntime('routine-error-user');

  try {
    const first = useRoutines.getState().runNow('routine-1');
    const second = useRoutines.getState().runNow('routine-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    const state = useRoutines.getState();
    assert.equal(state.runningIds.length, 0);
    assert.equal(state.routines[0].runs[0].status, 'error');
    assert.equal(state.routines[0].runs[0].text, '管家这次没答上来，稍后再问一次。');
  } finally {
    restoreNow();
    restoreRunner();
    restoreWorkflow();
    resetRoutineStore();
  }
});

test('runNow 用独立 ephemeral runner 显式调用房间汇总 Skill，并只传任务参数', async () => {
  resetRoutineStore([routine({
    name: '房间汇总',
    skillName: 'room-digest',
    params: { rooms: ['General', '发布群'] },
  })]);
  const storage = new MemoryStorage();
  storage.set('rcx-butler-v2:memory', JSON.stringify({
    schemaVersion: 2,
    records: [{
      id: 'routine-memory-style',
      kind: 'preference',
      scope: { server: getServerBase() || 'same-origin', account: 'routine-codex-user' },
      subject: '汇总方式',
      value: '先列风险，再列进展',
      provenance: { butlerSource: 'test', summary: '用户确认' },
      confidence: 'confirmed',
      createdAt: 1,
      confirmedAt: 1,
      expiresAt: null,
      status: 'active',
      supersedes: [],
    }],
  }));
  const restoreBrainStorage = setButlerBrainStorage(storage);
  const restoreProfile = setButlerProfileStorage(storage);
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  setCodexBrainUnavailableReason(undefined);
  let input: { text: string; skillName?: string; taskContext?: string } | undefined;
  const restoreRunner = setRoutineCodexRunner(async (options) => {
    input = options;
    return { text: 'Codex 房间汇总' };
  });
  const restoreWorkflow = await setupWorkflowRuntime('routine-codex-user');

  try {
    await useRoutines.getState().runNow('routine-1');
    assert.equal(
      input?.text,
      '执行 Today 例行事务“房间汇总”，直接输出结果。\n这是该例行事务首次成功运行前的检查。\n只处理这些房间：General、发布群。',
    );
    assert.equal(input?.skillName, 'room-digest');
    assert.match(input?.taskContext ?? '', /汇总方式.*先列风险，再列进展/);
    assert.doesNotMatch(input?.text ?? '', /请按以下方法论/);
    assert.equal(useRoutines.getState().routines[0].runs[0].text, 'Codex 房间汇总');
  } finally {
    restoreRunner();
    restoreNow();
    restorePlatform();
    restoreBrainStorage();
    restoreProfile();
    restoreWorkflow();
    resetRoutineStore();
  }
});

test('旧的不规范技能在 Codex 例行事务中继续使用 legacy 正文路径', async () => {
  resetRoutineStore([routine({ skillName: '旧 技能' })]);
  const storage = new MemoryStorage();
  storage.set('rcx-butler-v1:skills', JSON.stringify([
    { name: '旧 技能', description: '迁移前技能。', body: '先查询旧系统，再输出结果。' },
  ]));
  const restoreProfile = setButlerProfileStorage(storage);
  const restoreBrainStorage = setButlerBrainStorage(storage);
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  setCodexBrainUnavailableReason(undefined);
  let input: { text: string; skillName?: string } | undefined;
  const restoreRunner = setRoutineCodexRunner(async (options) => {
    input = options;
    return { text: '旧技能结果' };
  });
  const restoreWorkflow = await setupWorkflowRuntime('routine-legacy-skill-user');

  try {
    await useRoutines.getState().runNow('routine-1');
    assert.equal(input?.skillName, undefined);
    assert.match(input?.text ?? '', /请按以下方法论执行并直接输出结果/);
    assert.match(input?.text ?? '', /先查询旧系统，再输出结果/);
  } finally {
    restoreRunner();
    restoreNow();
    restorePlatform();
    restoreBrainStorage();
    restoreProfile();
    restoreWorkflow();
    resetRoutineStore();
  }
});

test('checkWatchers 只保留未回应 @我，构建与新指派不再生成提醒', () => {
  const now = new Date(2026, 0, 5, 12, 0).getTime();
  const snapshot = {
    builds: [
      { id: 7, definition: 'Web', buildNumber: '20260105.1', result: 'failed', project: 'RocketX' },
      { id: 8, definition: 'Web', buildNumber: '20260105.2', result: 'succeeded', project: 'RocketX' },
    ],
    workItems: [{ id: 42, title: '修复登录', assignedTo: 'DOMAIN\\alice', project: 'RocketX' }],
    subscriptions: [{ rid: 'room-1', name: '发布群', userMentions: 2, lastMessageAt: now - 3 * 60 * 60 * 1000 }],
    user: { username: 'alice', name: 'Alice Zhang' },
  };
  const cards = checkWatchers(snapshot, now);
  assert.equal(cards.length, 1);
  assert.ok(cards.some((card) => card.title === '@我未回应：发布群（3小时前）'));
  assert.equal(checkWatchers({ ...snapshot, seenKeys: cards.map((card) => card.dedupeKey) }, now).length, 0);
  assert.equal(checkWatchers({ ...snapshot, subscriptions: [{ rid: 'room-1', name: '发布群', userMentions: 2, lastMessageAt: now - 119 * 60 * 1000 }] }, now)
    .some((card) => card.kind === 'mention-stale'), false);
  // 房间缺少最后消息时间时不触发，避免出现「NaN/几十万小时前」的编造卡片。
  assert.equal(checkWatchers({ ...snapshot, subscriptions: [{ rid: 'room-1', name: '发布群', userMentions: 2, lastMessageAt: 0 }] }, now)
    .some((card) => card.kind === 'mention-stale'), false);
});

test('manual 与 schedule routine 都应通过同一 workflow，并向 runner 传入 toolRuntimeContext factory', async () => {
  const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
  const restorePersistence = setButlerPersistence(appData);
  const storage = new MemoryStorage();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (_key: string) => undefined,
    },
  });
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  const restoreBrainStorage = setButlerBrainStorage(storage);
  const restoreTauri = setButlerBrainTauriProvider(() => true);
  let codexToolRuntimeContext: unknown;
  const restoreCodexRunner = setRoutineCodexRunner(async (options) => {
    codexToolRuntimeContext = (options as { toolRuntimeContext?: unknown }).toolRuntimeContext;
    return { text: 'Codex 晨报' };
  });

  useAuth.setState({ user: { _id: 'routine-workflow-user', username: 'routine' } as never });
  useButler.getState().reset();
  resetButlerPersistenceForTests();
  setServerBase('https://chat.example');
  resetRoutineStore([routine()]);

  try {
    await useButler.getState().hydrate();

    await useRoutines.getState().runNow('routine-1');

    useRoutines.setState({
      routines: [routine({ lastFiredDate: undefined, runs: [] })],
      runningIds: [],
    });
    useRoutines.getState().tick(MONDAY_0830);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const snapshots = listButlerWorkflowSnapshots().filter((snapshot) => snapshot.kind === 'routine');
    assert.equal(snapshots.length, 1);
    assert.equal(typeof codexToolRuntimeContext, 'function');
    assert.equal(snapshots[0]?.key, 'routine:routine-1');
    assert.equal(snapshots[0]?.triggerReason, 'schedule');
    assert.equal(snapshots[0]?.attempts, 2);
  } finally {
    restoreCodexRunner();
    restoreTauri();
    restoreBrainStorage();
    restoreNow();
    restoreStorage();
    restorePersistence();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    useAuth.setState({ user: undefined } as never);
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    resetRoutineStore();
  }
});

test('watcher 检测应写入 watcher workflow sources，且 disable routine 会暂停对应 workflow', async () => {
  const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
  const restorePersistence = setButlerPersistence(appData);
  const storage = new MemoryStorage();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (_key: string) => undefined,
    },
  });
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);

  useAuth.setState({ user: { _id: 'watcher-workflow-user', username: 'watcher' } as never });
  useButler.getState().reset();
  resetButlerPersistenceForTests();
  setServerBase('https://chat.example');
  resetRoutineStore([routine()]);
  useChat.setState({
    subscriptions: {
      'room-1': { rid: 'room-1', fname: '发布群', name: 'release', userMentions: 2 },
    },
    rooms: {
      'room-1': { _id: 'room-1', fname: '发布群', name: 'release', lm: new Date(MONDAY_0830 - 3 * 60 * 60 * 1000).toISOString() },
    },
    messages: {},
    activeRid: null,
  } as never);

  try {
    await useButler.getState().hydrate();
    useRoutines.getState().tick(MONDAY_0830);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const watcher = listButlerWorkflowSnapshots().find((snapshot) => snapshot.kind === 'watcher');
    assert.ok(watcher);
    assert.deepEqual(watcher.sources, [
      { kind: 'room', id: 'room-1', rid: 'room-1', label: '发布群' },
    ]);
    assert.equal(useRoutines.getState().eventCards[0]?.rid, 'room-1');

    const blocked = new Promise<never>(() => undefined);
    const workflowRun = runButlerWorkflowTask({
      key: 'routine:routine-1',
      kind: 'routine',
      goal: '晨报',
      triggerReason: 'manual-run',
      execute: async () => blocked,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    useRoutines.getState().setEnabled('routine-1', false);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const routineSnapshot = listButlerWorkflowSnapshots().find((snapshot) => snapshot.key === 'routine:routine-1');
    assert.equal(routineSnapshot?.paused, true);
    assert.equal(routineSnapshot?.taskState?.status, 'paused');
  } finally {
    await pauseButlerWorkflowTask('routine:routine-1').catch(() => undefined);
    restoreNow();
    restoreStorage();
    restorePersistence();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    useAuth.setState({ user: undefined } as never);
    useChat.setState({ subscriptions: {}, rooms: {}, messages: {}, activeRid: null } as never);
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    resetRoutineStore();
  }
});

test('routines 入口源码需要接入 workflow runtime，而不是直接各走各的本地路径', () => {
  const source = readFileSync('apps/web/src/stores/routines.ts', 'utf8');
  assert.match(source, /runButlerWorkflowTask/);
  assert.match(source, /pauseButlerWorkflowTask/);
  assert.match(source, /toolRuntimeContext/);
});

test('真实 scheduler 跨过一分钟后自行触发 schedule workflow，不依赖手动运行', async () => {
  const storage = new MemoryStorage();
  storage.set('rcx-butler-v1:routines', JSON.stringify({
    routines: [routine({
      name: '定时短验收',
      skillName: undefined,
      prompt: '只回复“定时短验收通过”。',
    })],
    eventCards: [],
  }));
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (_key: string) => undefined,
    },
  });
  const intervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setInterval');
  let scheduledTick: (() => void) | undefined;
  Object.defineProperty(globalThis, 'setInterval', {
    configurable: true,
    value: ((callback: () => void, delay: number) => {
      assert.equal(delay, 60_000);
      scheduledTick = callback;
      return 1;
    }) as typeof setInterval,
  });
  let now = MONDAY_0829;
  const restoreNow = setRoutineNowProvider(() => now);
  const restoreStorage = setRoutineStorage(storage);
  const restoreBrainStorage = setButlerBrainStorage(storage);
  const restorePersistence = setButlerPersistence(
    createRcxStore({ backend: createMemoryBackend() }).appData,
  );
  let calls = 0;
  const restoreRunner = setRoutineCodexRunner(async () => {
    calls += 1;
    return { text: '定时短验收通过' };
  });
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  useAuth.setState({ user: { _id: 'short-scheduler-user', username: 'short-scheduler' } as never });
  useChat.setState({ subscriptions: {}, rooms: {}, messages: {}, activeRid: null } as never);
  setServerBase('https://chat.example');
  resetRoutineStore();

  try {
    await useButler.getState().hydrate();
    startRoutineScheduler();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.ok(scheduledTick);

    now = MONDAY_0830;
    scheduledTick();
    for (let attempt = 0; attempt < 20 && calls === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls, 1);
    const fired = useRoutines.getState().routines.find((item) => item.id === 'routine-1');
    assert.equal(fired?.lastFiredDate, '2026-01-05');
    assert.equal(fired?.runs[0]?.status, 'ok');
    assert.equal(fired?.runs[0]?.text, '定时短验收通过');
    const workflow = listButlerWorkflowSnapshots().find((snapshot) => snapshot.key === 'routine:routine-1');
    assert.equal(workflow?.triggerReason, 'schedule');
  } finally {
    restoreRunner();
    restorePersistence();
    restoreBrainStorage();
    restoreStorage();
    restoreNow();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    useAuth.setState({ user: undefined } as never);
    useChat.setState({ subscriptions: {}, rooms: {}, messages: {}, activeRid: null } as never);
    resetRoutineStore();
    if (intervalDescriptor) Object.defineProperty(globalThis, 'setInterval', intervalDescriptor);
    if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
