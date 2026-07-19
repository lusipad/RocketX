import assert from 'node:assert/strict';
import test from 'node:test';
import {
  setButlerBrain,
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
} from '../../apps/web/src/lib/butlerBrain';
import { checkWatchers } from '../../apps/web/src/lib/butlerWatchers';
import {
  dueRoutines,
  setRoutineCodexRunner,
  setRoutineLoopRunner,
  setRoutineNowProvider,
  setRoutineStorage,
  useRoutines,
  type Routine,
} from '../../apps/web/src/stores/routines';

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

test('dueRoutines 只在匹配日期到点后触发一次', () => {
  const daily = routine();
  assert.equal(dueRoutines([daily], MONDAY_0829).length, 0);
  assert.deepEqual(dueRoutines([daily], MONDAY_0830).map((item) => item.id), ['routine-1']);
  assert.equal(dueRoutines([routine({ lastFiredDate: '2026-01-05' })], MONDAY_0830).length, 0);
  assert.equal(dueRoutines([routine({ trigger: { kind: 'daily', time: '08:30', days: [2] } })], MONDAY_0830).length, 0);
  assert.equal(dueRoutines([routine({ enabled: false })], MONDAY_0830).length, 0);
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

  try {
    await useRoutines.getState().runNow('routine-1');
    const runs = useRoutines.getState().routines[0].runs;
    assert.equal(runs.length, 10);
    assert.deepEqual(runs[0], { id: runs[0].id, at: MONDAY_0830, status: 'ok', text: '晨报结果' });
  } finally {
    restoreNow();
    restoreRunner();
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

  try {
    const first = useRoutines.getState().runNow('routine-1');
    const second = useRoutines.getState().runNow('routine-1');
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
  let input = '';
  const restoreRunner = setRoutineCodexRunner(async (options) => {
    input = options.text;
    return { text: 'Codex 晨报' };
  });

  try {
    await useRoutines.getState().runNow('routine-1');
    assert.match(input, /请按以下方法论执行并直接输出结果/);
    assert.equal(useRoutines.getState().routines[0].runs[0].text, 'Codex 晨报');
  } finally {
    restoreRunner();
    restoreNow();
    restorePlatform();
    restoreBrainStorage();
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
