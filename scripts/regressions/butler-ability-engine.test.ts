import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUTLER_ABILITY_TEMPLATES,
  findButlerAbilityTemplate,
} from '../../apps/web/src/lib/butlerAbilityTemplates';
import {
  MIN_INTERVAL_MINUTES,
  dueRoutines,
  setRoutineCodexRunner,
  setRoutineNowProvider,
  setRoutineStorage,
  useRoutines,
  type Routine,
} from '../../apps/web/src/stores/routines';
import { useChat } from '../../apps/web/src/stores/chat';

const NOW = new Date(2026, 6, 26, 12, 0).getTime();

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'routine-1',
    name: '测试例行事务',
    trigger: { kind: 'daily', time: '08:30' },
    prompt: '只依据输入回答。',
    delivery: 'today',
    enabled: true,
    createdAt: NOW - 60_000,
    runs: [],
    ...overrides,
  };
}

function resetRoutineStore(routines: Routine[] = []): void {
  useRoutines.setState({
    routines,
    eventCards: [],
    seenKeys: [],
    unloadedTemplateIds: [],
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

test('interval 按最后一次运行计时，并拒绝低于 15 分钟', () => {
  assert.equal(MIN_INTERVAL_MINUTES, 15);
  const lastRunAt = NOW - 14 * 60_000;
  const interval = routine({
    trigger: { kind: 'interval', everyMinutes: 15 },
    runs: [{ id: 'last', at: lastRunAt, status: 'ok', text: '上次结果' }],
  });
  assert.deepEqual(dueRoutines([interval], NOW), []);
  assert.deepEqual(
    dueRoutines([interval], lastRunAt + 15 * 60_000).map((item) => item.id),
    ['routine-1'],
  );
  assert.deepEqual(
    dueRoutines([routine({
      trigger: { kind: 'interval', everyMinutes: 14 },
    })], NOW),
    [],
  );

  resetRoutineStore();
  assert.throws(
    () => useRoutines.getState().addRoutine(routine({
      trigger: { kind: 'interval', everyMinutes: 14 },
    })),
    /不能低于 15 分钟/,
  );
  resetRoutineStore();
});

test('hydrate 接受合法 interval，并丢弃低于下限的持久化记录', () => {
  const storage = new MemoryStorage();
  storage.set('rcx-butler-v1:routines', JSON.stringify({
    routines: [
      routine({ id: 'valid-interval', trigger: { kind: 'interval', everyMinutes: 15 } }),
      routine({ id: 'invalid-interval', trigger: { kind: 'interval', everyMinutes: 14 } }),
    ],
    eventCards: [],
  }));
  const restoreStorage = setRoutineStorage(storage);
  resetRoutineStore();

  try {
    useRoutines.getState().hydrate();
    assert.ok(useRoutines.getState().routines.some((item) => item.id === 'valid-interval'));
    assert.equal(
      useRoutines.getState().routines.some((item) => item.id === 'invalid-interval'),
      false,
    );
  } finally {
    restoreStorage();
    resetRoutineStore();
  }
});

test('模板装载复制 prompt/trigger，重复装载返回同一实例', () => {
  resetRoutineStore();
  const template = findButlerAbilityTemplate('mention-triage');
  assert.ok(template);
  const originalPrompt = template.prompt;
  const originalEveryMinutes = template.defaultTrigger.kind === 'interval'
    ? template.defaultTrigger.everyMinutes
    : 0;
  const loaded = useRoutines.getState().loadTemplate('mention-triage');
  assert.ok(loaded);

  template.prompt = '模板升级后的提示词';
  if (template.defaultTrigger.kind === 'interval') {
    template.defaultTrigger.everyMinutes = 30;
  }
  try {
    assert.equal(loaded.prompt, originalPrompt);
    assert.deepEqual(loaded.trigger, {
      kind: 'interval',
      everyMinutes: originalEveryMinutes,
    });
    const duplicate = useRoutines.getState().loadTemplate('mention-triage');
    assert.equal(duplicate?.id, loaded.id);
    assert.equal(
      useRoutines.getState().routines.filter((item) => item.templateId === 'mention-triage').length,
      1,
    );
  } finally {
    template.prompt = originalPrompt;
    if (template.defaultTrigger.kind === 'interval') {
      template.defaultTrigger.everyMinutes = originalEveryMinutes;
    }
    resetRoutineStore();
  }
});

test('room-digest 装载时替换房间占位，并保留预检所需参数', () => {
  resetRoutineStore();
  assert.equal(useRoutines.getState().loadTemplate('room-digest'), undefined);
  assert.equal(
    useRoutines.getState().loadTemplate('room-digest', { rooms: [] }),
    undefined,
  );
  const loaded = useRoutines.getState().loadTemplate('room-digest', {
    rooms: ['发布群', '研发群'],
  });
  assert.ok(loaded);
  assert.doesNotMatch(loaded.prompt ?? '', /\{\{rooms\}\}/);
  assert.match(loaded.prompt ?? '', /发布群、研发群/);
  assert.deepEqual(loaded.params, { rooms: ['发布群', '研发群'] });
  resetRoutineStore();
});

test('卸载模板实例会持久化，hydrate 不会把出厂模板偷偷装回来', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => NOW);
  resetRoutineStore();

  try {
    useRoutines.getState().hydrate();
    useRoutines.getState().unloadRoutine('builtin-morning-brief');
    assert.equal(
      useRoutines.getState().routines.some((item) => item.id === 'builtin-morning-brief'),
      false,
    );

    resetRoutineStore();
    useRoutines.getState().hydrate();
    assert.equal(
      useRoutines.getState().routines.some((item) => item.id === 'builtin-morning-brief'),
      false,
    );
    assert.ok(
      useRoutines.getState().routines.some((item) => item.id === 'builtin-evening-review'),
    );
  } finally {
    restoreNow();
    restoreStorage();
    resetRoutineStore();
  }
});

test('旧格式晨报和晚间回顾迁移后保留 id 与用户改过的时间', () => {
  const storage = new MemoryStorage();
  storage.set('rcx-butler-v1:routines', JSON.stringify({
    routines: [
      routine({
        id: 'builtin-morning-brief',
        name: '晨报',
        trigger: { kind: 'daily', time: '07:45' },
        prompt: undefined,
        skillName: 'morning-brief',
      }),
      routine({
        id: 'builtin-evening-review',
        name: '晚间回顾',
        trigger: { kind: 'daily', time: '19:10' },
        prompt: undefined,
        skillName: 'evening-review',
      }),
    ],
    eventCards: [],
  }));
  const restoreStorage = setRoutineStorage(storage);
  const restoreNow = setRoutineNowProvider(() => NOW);
  resetRoutineStore();

  try {
    useRoutines.getState().hydrate();
    const morning = useRoutines.getState().routines.find(
      (item) => item.id === 'builtin-morning-brief',
    );
    const evening = useRoutines.getState().routines.find(
      (item) => item.id === 'builtin-evening-review',
    );
    assert.deepEqual(morning?.trigger, { kind: 'daily', time: '07:45' });
    assert.deepEqual(evening?.trigger, { kind: 'daily', time: '19:10' });
    assert.equal(morning?.templateId, 'morning-brief');
    assert.equal(evening?.templateId, 'evening-review');
    assert.equal(morning?.prompt, findButlerAbilityTemplate('morning-brief')?.prompt);
    assert.equal(evening?.prompt, findButlerAbilityTemplate('evening-review')?.prompt);
  } finally {
    restoreNow();
    restoreStorage();
    resetRoutineStore();
  }
});

test('new-mentions 预检无新事时定时静默跳过，手动检查留下明确结果', async () => {
  let runnerCalls = 0;
  const restoreRunner = setRoutineCodexRunner(async () => {
    runnerCalls += 1;
    return { text: '不应生成' };
  });
  const restoreNow = setRoutineNowProvider(() => NOW);
  useChat.setState({
    subscriptions: {
      'room-1': { rid: 'room-1', name: '测试群', userMentions: 0 },
    },
    rooms: {},
    messages: {},
  } as never);
  resetRoutineStore([routine({
    trigger: { kind: 'interval', everyMinutes: 15 },
    templateId: 'mention-triage',
    precheck: 'new-mentions',
    runs: [{ id: 'last', at: NOW - 15 * 60_000, status: 'ok', text: '上次结果' }],
  })]);

  try {
    await useRoutines.getState().runNow('routine-1', { triggerReason: 'schedule' });
    assert.equal(runnerCalls, 0);
    assert.equal(useRoutines.getState().routines[0]?.runs.length, 1);
    assert.deepEqual(useRoutines.getState().runningIds, []);

    await useRoutines.getState().runNow('routine-1');
    assert.equal(runnerCalls, 0);
    assert.equal(useRoutines.getState().routines[0]?.runs.length, 2);
    assert.equal(
      useRoutines.getState().routines[0]?.runs[0]?.text,
      '当前没有新的 @ 需要整理。',
    );

    useChat.setState({
      subscriptions: {
        'room-1': { rid: 'room-1', name: '测试群', userMentions: 1 },
      },
      rooms: {
        'room-1': { _id: 'room-1', lm: new Date(NOW - 16 * 60_000).toISOString() },
      },
      messages: {},
    } as never);
    await useRoutines.getState().runNow('routine-1');
    assert.equal(runnerCalls, 0);
    assert.equal(useRoutines.getState().routines[0]?.runs.length, 3);
  } finally {
    restoreNow();
    restoreRunner();
    useChat.setState({ subscriptions: {}, rooms: {}, messages: {} } as never);
    resetRoutineStore();
  }
});

test('模板库只包含四条已定案能力', () => {
  assert.deepEqual(
    BUTLER_ABILITY_TEMPLATES.map((template) => template.id),
    ['mention-triage', 'room-digest', 'morning-brief', 'evening-review'],
  );
});
