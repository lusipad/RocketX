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
import { executeRocketxDynamicTool } from '../../apps/web/src/agent/codexHostTools';
import {
  parseCodexAutomationToml,
  serializeCodexAutomationToml,
  setCodexAutomationFileAdapter,
  type CodexAutomationDefinition,
} from '../../apps/web/src/lib/codexAutomationFiles';

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
    nativeStatus: 'idle',
    nativeError: undefined,
  });
  useAuth.setState({ user: undefined } as never);
  useCodexWorkspace.setState({
    workspaceRoot: '',
    activeThreadId: undefined,
    selectedModel: '',
    selectedEffort: null,
    permissionPreset: 'auto',
    skills: [],
  });
}

test('本地缓存只读取 Codex automations 命名空间，内置模块保持为建议而不是伪任务', () => {
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
    assert.equal(ids.includes('builtin-morning-brief'), false);
    assert.equal(ids.includes('builtin-evening-review'), false);
  } finally {
    restoreNow();
    restoreStorage();
    reset();
  }
});

test('同一内置模板的旧 ID 与固定 ID 会合并为一个任务并保留运行历史', () => {
  const storage = new MemoryStorage();
  storage.set('rcx-codex-automations-v1:routines', JSON.stringify({
    routines: [
      routine({
        id: 'legacy-morning-brief',
        name: '晨报',
        templateId: 'morning-brief',
        skillName: 'morning-brief',
        enabled: true,
        updatedAt: MONDAY_0830,
        runs: [{ id: 'legacy-run', at: MONDAY_0830, status: 'ok', text: '旧任务结果' }],
      }),
      routine({
        id: 'builtin-morning-brief',
        name: '晨报',
        templateId: 'morning-brief',
        skillName: 'morning-brief',
        enabled: false,
        updatedAt: MONDAY_0829,
        runs: [{ id: 'canonical-run', at: MONDAY_0829, status: 'ok', text: '固定任务结果' }],
      }),
    ],
    eventCards: [],
  }));
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => MONDAY_0830);
  reset();
  try {
    useRoutines.getState().hydrate();
    const morning = useRoutines.getState().routines.filter((item) => item.templateId === 'morning-brief');
    assert.equal(morning.length, 1);
    assert.equal(morning[0]?.id, 'builtin-morning-brief');
    assert.equal(morning[0]?.enabled, true);
    assert.deepEqual(morning[0]?.runs.map((run) => run.id), ['legacy-run', 'canonical-run']);
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

test('dueRoutines 只在时间窗内按间隔触发', () => {
  const windowed = routine({
    trigger: {
      kind: 'interval',
      everyMinutes: 15,
      window: { start: '09:00', end: '20:00' },
    },
  });
  assert.deepEqual(dueRoutines([windowed], new Date(2026, 0, 5, 8, 45).getTime()), []);
  assert.deepEqual(
    dueRoutines([windowed], new Date(2026, 0, 5, 9, 0).getTime()).map((item) => item.id),
    ['routine-1'],
  );
  assert.deepEqual(dueRoutines([windowed], new Date(2026, 0, 5, 20, 0).getTime()), []);
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
    permissionPreset: 'full',
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
    assert.equal(received?.permissionPreset, 'full');
    assert.equal(received?.skillName, 'room-digest');
    assert.match(String(received?.text), /^\$room-digest/m);
    assert.match(String(received?.text), /General、发布群/);
    assert.deepEqual(useRoutines.getState().routines[0]?.runs[0], {
      id: useRoutines.getState().routines[0]?.runs[0]?.id,
      at: MONDAY_0830,
      status: 'ok',
      text: '真实汇总结果',
      triggerReason: 'manual',
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

test('运行结果可以持久标记已读并按 Codex 历史动作批量归档', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  reset([routine({
    runs: [
      { id: 'run-1', at: MONDAY_0830, status: 'ok', text: '结果一' },
      { id: 'run-2', at: MONDAY_0829, status: 'error', text: '结果二' },
    ],
  })]);
  try {
    useRoutines.getState().markRunRead('routine-1', 'run-1', true);
    assert.equal(useRoutines.getState().routines[0]?.runs[0]?.readAt !== undefined, true);
    useRoutines.getState().archiveRuns();
    assert.equal(useRoutines.getState().routines[0]?.runs.every((run) => run.archived), true);
    const saved = JSON.parse(storage.get('rcx-codex-automations-v1:routines') ?? '{}') as { routines: Routine[] };
    assert.equal(saved.routines[0]?.runs.every((run) => run.archived), true);
  } finally {
    restoreStorage();
    reset();
  }
});

test('对话创建已安排任务默认回到当前会话，独立任务必须显式选择 cron', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  reset();
  useCodexWorkspace.setState({ workspaceRoot: 'D:/Repos/example', activeThreadId: 'thread-current' });
  try {
    const result = await executeRocketxDynamicTool({
      tool: 'create_scheduled_task',
      arguments: {
        name: '跟进当前会话',
        prompt: '继续检查当前问题',
        rrule: 'RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=0',
      },
    });
    assert.equal(result.success, true);
    const created = JSON.parse(result.contentItems[0].type === 'inputText' ? result.contentItems[0].text : '{}') as {
      task: { kind: string; targetThreadId: string };
    };
    assert.equal(created.task.kind, 'heartbeat');
    assert.equal(created.task.targetThreadId, 'thread-current');
  } finally {
    restoreStorage();
    reset();
  }
});

test('Codex 对话通过结构化工具管理同一套已安排任务', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  reset();
  useAuth.setState({ user: { _id: 'user-1', username: 'tester' } as never });
  useCodexWorkspace.setState({
    workspaceRoot: 'D:/Repos/example',
    selectedModel: 'gpt-test',
    selectedEffort: 'high',
  });
  const restoreRunner = setRoutineCodexRunner(async () => ({ text: '结构化运行结果', threadId: 'thread-run' }));
  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await executeRocketxDynamicTool({ tool, arguments: args });
    assert.equal(result.success, true);
    return JSON.parse(result.contentItems[0].type === 'inputText' ? result.contentItems[0].text : '{}') as Record<string, unknown>;
  };
  try {
    const created = await call('create_scheduled_task', {
      name: '每周风险检查',
      prompt: '检查风险并给出三条结论',
      rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      model: 'gpt-test',
      reasoningEffort: 'high',
    });
    const task = created.task as { id: string; status: string; rrule: string };
    assert.equal(task.status, 'ACTIVE');
    assert.equal(task.rrule, 'RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0');

    const listed = await call('list_scheduled_tasks', {});
    assert.ok((listed.tasks as Array<{ id: string }>).some((item) => item.id === task.id));

    const updated = await call('update_scheduled_task', { id: task.id, status: 'PAUSED', name: '每周发布风险' });
    assert.equal((updated.task as { status: string; name: string }).status, 'PAUSED');
    assert.equal((updated.task as { status: string; name: string }).name, '每周发布风险');

    const ran = await call('run_scheduled_task', { id: task.id });
    assert.equal((ran.run as { threadId: string }).threadId, 'thread-run');

    const deleted = await call('delete_scheduled_task', { id: task.id });
    assert.equal(deleted.status, 'deleted');
    assert.equal(useRoutines.getState().routines.some((item) => item.id === task.id), false);
  } finally {
    restoreRunner();
    restoreStorage();
    reset();
  }
});

test('桌面端从 Codex automation.toml 读取任务定义并保留本地运行历史', async () => {
  const storage = new MemoryStorage();
  storage.set('rcx-codex-automations-v1:routines', JSON.stringify({
    routines: [
      routine({
        id: 'native-task',
        name: '旧缓存名称',
        runs: [{ id: 'run-1', at: MONDAY_0829, status: 'ok', text: '保留的运行结果' }],
      }),
      routine({ id: 'stale-local-task' }),
    ],
    eventCards: [],
  }));
  const definition: CodexAutomationDefinition = {
    version: 1,
    id: 'native-task',
    kind: 'cron',
    name: 'Codex 文件里的名称',
    prompt: '读取真实工作区并返回结论',
    status: 'PAUSED',
    rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    cwds: ['D:\\Repos\\native-project'],
    executionEnvironment: 'local',
    createdAt: MONDAY_0829,
    updatedAt: MONDAY_0830,
    model: 'gpt-test',
    reasoningEffort: 'high',
  };
  const restoreStorage = setRoutineStorage(storage);
  const restoreFiles = setCodexAutomationFileAdapter({
    list: async () => [{ id: definition.id, content: serializeCodexAutomationToml(definition) }],
    write: async () => undefined,
    remove: async () => undefined,
  });
  reset();
  try {
    useRoutines.getState().hydrate();
    await useRoutines.getState().hydrateNative();

    assert.deepEqual(useRoutines.getState().routines.map((item) => item.id), ['native-task']);
    assert.equal(useRoutines.getState().routines[0]?.name, 'Codex 文件里的名称');
    assert.equal(useRoutines.getState().routines[0]?.enabled, false);
    assert.equal(useRoutines.getState().routines[0]?.workspaceRoot, 'D:\\Repos\\native-project');
    assert.equal(useRoutines.getState().routines[0]?.runs[0]?.text, '保留的运行结果');
    assert.equal(useRoutines.getState().nativeStatus, 'ready');
  } finally {
    restoreFiles();
    restoreStorage();
    reset();
  }
});

test('桌面端从 Codex heartbeat 文件恢复目标会话', async () => {
  const definition: CodexAutomationDefinition = {
    version: 1,
    id: 'heartbeat-native',
    kind: 'heartbeat',
    name: '继续当前任务',
    prompt: '检查任务是否有新进展',
    status: 'ACTIVE',
    rrule: 'RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=0',
    cwds: [],
    executionEnvironment: 'local',
    targetThreadId: 'thread-native',
    createdAt: MONDAY_0829,
    updatedAt: MONDAY_0830,
  };
  const restoreFiles = setCodexAutomationFileAdapter({
    list: async () => [{ id: definition.id, content: serializeCodexAutomationToml(definition) }],
    write: async () => undefined,
    remove: async () => undefined,
  });
  reset();
  try {
    await useRoutines.getState().hydrateNative();
    assert.equal(useRoutines.getState().routines[0]?.kind, 'heartbeat');
    assert.equal(useRoutines.getState().routines[0]?.targetThreadId, 'thread-native');
  } finally {
    restoreFiles();
    reset();
  }
});

test('原生文件写入失败时回滚本地任务变更', async () => {
  const storage = new MemoryStorage();
  const original = routine({ workspaceRoot: 'D:/Repos/example', enabled: true });
  const restoreStorage = setRoutineStorage(storage);
  const restoreFiles = setCodexAutomationFileAdapter({
    list: async () => [],
    write: async () => { throw new Error('native write failed'); },
    remove: async () => undefined,
  });
  reset([original]);
  try {
    useRoutines.getState().setEnabled(original.id, false);
    await assert.rejects(
      useRoutines.getState().syncNative(original.id, original),
      /native write failed/,
    );
    assert.equal(useRoutines.getState().routines[0]?.enabled, true);

    const created = routine({ id: 'created-before-write', workspaceRoot: 'D:/Repos/example' });
    useRoutines.getState().addRoutine(created);
    await assert.rejects(
      useRoutines.getState().syncNative(created.id, null),
      /native write failed/,
    );
    assert.equal(useRoutines.getState().routines.some((item) => item.id === created.id), false);
  } finally {
    restoreFiles();
    restoreStorage();
    reset();
  }
});

test('Codex 结构化工具创建、暂停和删除时同步同一份 automation.toml', async () => {
  const files = new Map<string, string>();
  const restoreFiles = setCodexAutomationFileAdapter({
    list: async () => [...files].map(([id, content]) => ({ id, content })),
    write: async (id, content) => { files.set(id, content); },
    remove: async (id) => { files.delete(id); },
  });
  reset();
  useCodexWorkspace.setState({ workspaceRoot: 'D:/Repos/example', selectedModel: 'gpt-test', selectedEffort: 'high' });
  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await executeRocketxDynamicTool({ tool, arguments: args });
    assert.equal(result.success, true);
    return JSON.parse(result.contentItems[0].type === 'inputText' ? result.contentItems[0].text : '{}') as Record<string, unknown>;
  };
  try {
    const created = await call('create_scheduled_task', {
      name: '原生文件任务',
      prompt: '检查项目状态',
      rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    });
    const id = (created.task as { id: string }).id;
    assert.equal(files.size, 1);
    assert.equal(parseCodexAutomationToml(files.get(id)!).cwds[0], 'D:/Repos/example');

    await call('update_scheduled_task', { id, status: 'PAUSED' });
    assert.equal(parseCodexAutomationToml(files.get(id)!).status, 'PAUSED');

    await call('delete_scheduled_task', { id });
    assert.equal(files.has(id), false);
  } finally {
    restoreFiles();
    reset();
  }
});
