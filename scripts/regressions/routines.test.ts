import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dueRoutines,
  MIN_INTERVAL_MINUTES,
  setRoutineCodexRunner,
  setRoutineNowProvider,
  setRoutineStorage,
  useRoutines,
  type Routine,
} from '../../apps/web/src/stores/routines';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';

const MONDAY_0829 = new Date(2026, 0, 5, 8, 29).getTime();
const MONDAY_0830 = new Date(2026, 0, 5, 8, 30).getTime();

class MemoryStorage {
  values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'routine-1',
    name: '测试已安排任务',
    trigger: { kind: 'daily', time: '08:30' },
    prompt: '检查工作区并返回结论',
    precheck: 'none',
    enabled: true,
    createdAt: MONDAY_0829,
    runs: [],
    ...overrides,
  };
}

function reset(routines: Routine[] = []): void {
  useRoutines.setState({
    routines,
    eventCards: [],
    seenKeys: [],
    unloadedTemplateIds: [],
    runningIds: [],
    hydrated: false,
  });
  useAuth.setState({ user: undefined } as never);
  useCodexWorkspace.setState({
    workspaceRoot: '',
    selectedModel: '',
    selectedEffort: null,
    skills: [],
  });
}

test('新架构只读取 Codex automations 存储，不迁移旧 Butler 数据', () => {
  const storage = new MemoryStorage();
  storage.set('rcx-butler-v1:routines', JSON.stringify({ routines: [routine({ id: 'legacy' })] }));
  storage.set('rcx-codex-automations-v1:routines', JSON.stringify({
    routines: [routine({ id: 'native' })],
    eventCards: [],
  }));
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  reset();
  try {
    useRoutines.getState().hydrate();
    const ids = useRoutines.getState().routines.map((item) => item.id);
    assert.ok(ids.includes('native'));
    assert.equal(ids.includes('legacy'), false);
    assert.ok(ids.includes('builtin-morning-brief'));
    assert.ok(ids.includes('builtin-evening-review'));
  } finally {
    restoreNow();
    restoreStorage();
    reset();
  }
});

test('启停和创建写入新的 Codex automations 存储', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  reset([routine()]);
  try {
    useRoutines.getState().setEnabled('routine-1', false);
    const saved = JSON.parse(storage.get('rcx-codex-automations-v1:routines') ?? '{}') as { routines: Routine[] };
    assert.equal(saved.routines[0]?.enabled, false);
    assert.equal('delivery' in (saved.routines[0] ?? {}), false);
    assert.equal(storage.get('rcx-butler-v1:routines'), null);
  } finally {
    restoreStorage();
    reset();
  }
});

test('dueRoutines 支持每日与最短十五分钟间隔，并避免每日重复触发', () => {
  assert.deepEqual(dueRoutines([routine()], MONDAY_0829), []);
  assert.deepEqual(dueRoutines([routine()], MONDAY_0830).map((item) => item.id), ['routine-1']);
  assert.deepEqual(dueRoutines([routine({ lastFiredDate: '2026-01-05' })], MONDAY_0830), []);
  assert.deepEqual(dueRoutines([
    routine({ trigger: { kind: 'interval', everyMinutes: MIN_INTERVAL_MINUTES } }),
  ], MONDAY_0830).map((item) => item.id), ['routine-1']);
});

test('低于十五分钟的间隔不会被保存', () => {
  reset();
  assert.throws(() => useRoutines.getState().addRoutine(routine({
    trigger: { kind: 'interval', everyMinutes: MIN_INTERVAL_MINUTES - 1 },
  })), /interval/);
});

test('手动运行把工作区、模型、权限上下文交给同一个原生 Codex 自动化执行器', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  reset([routine({
    skillName: 'room-digest',
    prompt: undefined,
    params: { rooms: ['General', '发布群'] },
  })]);
  useAuth.setState({ user: { _id: 'user-1', username: 'tester' } as never });
  useCodexWorkspace.setState({
    workspaceRoot: 'D:/Repos/example',
    selectedModel: 'gpt-test',
    selectedEffort: 'high',
    skills: [{ name: 'room-digest', enabled: true, path: 'skill.md' } as never],
  });
  let received: Record<string, unknown> | undefined;
  const restoreRunner = setRoutineCodexRunner(async (options) => {
    received = options as unknown as Record<string, unknown>;
    options.onAdmitted?.();
    return { text: '真实汇总结果' };
  });
  try {
    await useRoutines.getState().runNow('routine-1', { triggerReason: 'manual' });
    assert.equal(received?.workspaceRoot, 'D:/Repos/example');
    assert.equal(received?.model, 'gpt-test');
    assert.equal(received?.effort, 'high');
    assert.equal(received?.skillName, 'room-digest');
    assert.match(String(received?.text), /^\$room-digest/m);
    assert.match(String(received?.text), /General、发布群/);
    assert.deepEqual(useRoutines.getState().routines[0]?.runs[0], {
      id: useRoutines.getState().routines[0]?.runs[0]?.id,
      at: MONDAY_0830,
      status: 'ok',
      text: '真实汇总结果',
    });
  } finally {
    restoreRunner();
    restoreNow();
    restoreStorage();
    reset();
  }
});

test('未选择工作区时手动和定时运行都记录明确错误，定时触发只尝试一次', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  reset([routine()]);
  useAuth.setState({ user: { _id: 'user-1', username: 'tester' } as never });
  let calls = 0;
  const restoreRunner = setRoutineCodexRunner(async () => {
    calls += 1;
    throw new Error('请先在“任务”中选择工作区');
  });
  try {
    await useRoutines.getState().runNow('routine-1', { triggerReason: 'manual' });
    assert.equal(calls, 1);
    assert.match(useRoutines.getState().routines[0]?.runs[0]?.text ?? '', /选择工作区/);

    reset([routine()]);
    useAuth.setState({ user: { _id: 'user-1', username: 'tester' } as never });
    await useRoutines.getState().tick(MONDAY_0830);
    assert.equal(calls, 2);
    assert.equal(useRoutines.getState().routines[0]?.lastFiredDate, '2026-01-05');
    assert.match(useRoutines.getState().routines[0]?.runs[0]?.text ?? '', /选择工作区/);
  } finally {
    restoreRunner();
    restoreStorage();
    reset();
  }
});

test('未登录时手动和定时运行都记录错误，定时触发不会每分钟重复', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  reset([routine()]);
  let calls = 0;
  const restoreRunner = setRoutineCodexRunner(async () => {
    calls += 1;
    return { text: '不应执行' };
  });
  try {
    await useRoutines.getState().runNow('routine-1');
    assert.equal(calls, 0);
    assert.match(useRoutines.getState().routines[0]?.runs[0]?.text ?? '', /登录/);

    reset([routine()]);
    await useRoutines.getState().tick(MONDAY_0830);
    assert.equal(calls, 0);
    assert.equal(useRoutines.getState().routines[0]?.lastFiredDate, '2026-01-05');
    assert.match(useRoutines.getState().routines[0]?.runs[0]?.text ?? '', /登录/);
  } finally {
    restoreRunner();
    restoreStorage();
    reset();
  }
});

test('Codex 目录明确停用的 Skill 不能启用或运行', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  reset([routine({ skillName: 'room-digest', prompt: undefined, enabled: false })]);
  useAuth.setState({ user: { _id: 'user-1' } as never });
  useCodexWorkspace.setState({
    workspaceRoot: 'D:/Repos/example',
    skills: [{ name: 'room-digest', enabled: false, path: 'skill.md' } as never],
  });
  let calls = 0;
  const restoreRunner = setRoutineCodexRunner(async () => {
    calls += 1;
    return { text: '不应执行' };
  });
  try {
    useRoutines.getState().setEnabled('routine-1', true);
    assert.equal(useRoutines.getState().routines[0]?.enabled, false);
    useRoutines.setState({ routines: [routine({ skillName: 'room-digest', prompt: undefined })] });
    await useRoutines.getState().runNow('routine-1');
    assert.equal(calls, 0);
    assert.match(useRoutines.getState().routines[0]?.runs[0]?.text ?? '', /已停用/);

    useRoutines.setState({ routines: [routine({ skillName: 'room-digest', prompt: undefined })] });
    await useRoutines.getState().tick(MONDAY_0830);
    assert.equal(calls, 0);
    assert.equal(useRoutines.getState().routines[0]?.lastFiredDate, '2026-01-05');
    assert.match(useRoutines.getState().routines[0]?.runs[0]?.text ?? '', /已停用/);
  } finally {
    restoreRunner();
    restoreStorage();
    reset();
  }
});

test('同一已安排任务不会并发运行，执行失败原样展示 Runtime 错误', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  reset([routine()]);
  useAuth.setState({ user: { _id: 'user-1' } as never });
  useCodexWorkspace.setState({ workspaceRoot: 'D:/Repos/example' });
  let calls = 0;
  let release: (() => void) | undefined;
  const restoreRunner = setRoutineCodexRunner(async (options) => {
    calls += 1;
    options.onAdmitted?.();
    await new Promise<void>((resolve) => { release = resolve; });
    throw new Error('AuthorizationManager check failed');
  });
  try {
    const first = useRoutines.getState().runNow('routine-1');
    const second = useRoutines.getState().runNow('routine-1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release?.();
    await Promise.all([first, second]);
    assert.equal(useRoutines.getState().routines[0]?.runs[0]?.text, 'AuthorizationManager check failed');
  } finally {
    restoreRunner();
    restoreStorage();
    reset();
  }
});

test('定时 tick 在执行结果落盘后写入每日触发游标', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  reset([routine()]);
  useAuth.setState({ user: { _id: 'user-1' } as never });
  useCodexWorkspace.setState({ workspaceRoot: 'D:/Repos/example' });
  let calls = 0;
  const restoreRunner = setRoutineCodexRunner(async (options) => {
    calls += 1;
    options.onAdmitted?.();
    return { text: '定时结果' };
  });
  try {
    await useRoutines.getState().tick(MONDAY_0830);
    assert.equal(calls, 1);
    assert.equal(useRoutines.getState().routines[0]?.lastFiredDate, '2026-01-05');
    assert.equal(useRoutines.getState().routines[0]?.runs[0]?.text, '定时结果');
    await useRoutines.getState().tick(MONDAY_0830 + 60_000);
    assert.equal(calls, 1);
  } finally {
    restoreRunner();
    restoreStorage();
    reset();
  }
});

test('调整和回退任务合同都会留下新版本', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  reset([routine({
    contractVersion: 1,
    versions: [{
      version: 1,
      at: MONDAY_0829,
      reason: '创建',
      name: '测试已安排任务',
      trigger: { kind: 'daily', time: '08:30' },
      prompt: '检查工作区并返回结论',
    }],
  })]);
  try {
    useRoutines.getState().updateContract('routine-1', { prompt: '检查后给出风险' }, '补充风险');
    assert.equal(useRoutines.getState().routines[0]?.contractVersion, 2);
    useRoutines.getState().rollbackContract('routine-1', 1);
    assert.equal(useRoutines.getState().routines[0]?.contractVersion, 3);
    assert.equal(useRoutines.getState().routines[0]?.prompt, '检查工作区并返回结论');
  } finally {
    restoreNow();
    restoreStorage();
    reset();
  }
});
