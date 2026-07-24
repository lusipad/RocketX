import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import {
  setButlerBrain,
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
} from '../../apps/web/src/lib/butlerBrain';
import { setServerBase } from '../../apps/web/src/lib/client';
import { checkWatchers } from '../../apps/web/src/lib/butlerWatchers';
import { setButlerProfileStorage } from '../../apps/web/src/lib/butlerProfile';
import {
  dueRoutines,
  setRoutineCodexRunner,
  setRoutineLoopRunner,
  setRoutineNowProvider,
  setRoutineStorage,
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
  const restoreRunner = setRoutineLoopRunner(async () => {
    calls += 1;
    return { text: '登录后晨报', messages: [] };
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
  const restoreRunner = setRoutineLoopRunner(async () => ({ text: '晨报结果', messages: [] }));
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  const restoreWorkflow = await setupWorkflowRuntime('routine-success-user');

  try {
    await useRoutines.getState().runNow('routine-1');
    const runs = useRoutines.getState().routines[0].runs;
    assert.equal(runs.length, 10);
    assert.deepEqual(runs[0], { id: runs[0].id, at: MONDAY_0830, status: 'ok', text: '晨报结果' });
  } finally {
    restoreNow();
    restoreRunner();
    restoreWorkflow();
    resetRoutineStore();
  }
});

test('runNow 将未配置 Provider 转成友好错误，并防止重入', async () => {
  resetRoutineStore([routine()]);
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const restoreRunner = setRoutineLoopRunner(async () => {
    calls += 1;
    await pending;
    throw new Error('AI Provider 不存在: unconfigured');
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
    assert.equal(state.routines[0].runs[0].text, '尚未配置 AI Provider，可在设置页添加；快速搜索与查询不受影响。');
  } finally {
    restoreNow();
    restoreRunner();
    restoreWorkflow();
    resetRoutineStore();
  }
});

test('选择 Codex 大脑时，runNow 使用独立的 ephemeral runner', async () => {
  resetRoutineStore([routine()]);
  const storage = new MemoryStorage();
  const restoreBrainStorage = setButlerBrainStorage(storage);
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  setCodexBrainUnavailableReason(undefined);
  setButlerBrain('codex');
  let input: { text: string; skillName?: string } | undefined;
  const restoreRunner = setRoutineCodexRunner(async (options) => {
    input = options;
    return { text: 'Codex 晨报' };
  });
  const restoreWorkflow = await setupWorkflowRuntime('routine-codex-user');

  try {
    await useRoutines.getState().runNow('routine-1');
    assert.equal(input?.text, '执行 Today 例行事务“测试例行事务”，直接输出结果。');
    assert.equal(input?.skillName, 'morning-brief');
    assert.doesNotMatch(input?.text ?? '', /^晨报|请按以下方法论/);
    assert.equal(useRoutines.getState().routines[0].runs[0].text, 'Codex 晨报');
  } finally {
    restoreRunner();
    restoreNow();
    restorePlatform();
    restoreBrainStorage();
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
  setButlerBrain('codex');
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

test('manual 与 schedule routine 都应通过同一 workflow，并向 API/Codex runner 传入 toolRuntimeContext factory', async () => {
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
  let apiToolRuntimeContext: unknown;
  let codexToolRuntimeContext: unknown;
  const restoreLoopRunner = setRoutineLoopRunner(async (options) => {
    apiToolRuntimeContext = (options as { toolRuntimeContext?: unknown }).toolRuntimeContext;
    return { text: 'API 晨报', messages: [] };
  });
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

    setButlerBrain('api');
    await useRoutines.getState().runNow('routine-1');

    useRoutines.setState({
      routines: [routine({ lastFiredDate: undefined, runs: [] })],
      runningIds: [],
    });
    setButlerBrain('codex');
    useRoutines.getState().tick(MONDAY_0830);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const snapshots = listButlerWorkflowSnapshots().filter((snapshot) => snapshot.kind === 'routine');
    assert.equal(snapshots.length, 1);
    assert.equal(typeof apiToolRuntimeContext, 'function');
    assert.equal(typeof codexToolRuntimeContext, 'function');
    assert.equal(snapshots[0]?.key, 'routine:routine-1');
    assert.equal(snapshots[0]?.triggerReason, 'schedule');
    assert.equal(snapshots[0]?.attempts, 2);
  } finally {
    restoreCodexRunner();
    restoreLoopRunner();
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
