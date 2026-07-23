import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelButlerToolCheckpoint,
  createButlerToolCheckpoint,
  defineButlerTool,
  formatButlerToolResult,
  normalizeButlerToolCheckpoint,
  recoverButlerToolCheckpoint,
  type ButlerToolAuditEntry,
  type ButlerToolCheckpoint,
  type ButlerToolRuntimeContext,
} from '../../apps/web/src/lib/butlerToolRuntime';
import {
  parseButlerMemoryState,
  rememberButlerMemory,
  serializeButlerMemoryState,
  type ButlerMemoryState,
} from '../../apps/web/src/lib/butlerMemory';
import {
  setButlerProfileStorage,
  type ButlerProfileStorage,
} from '../../apps/web/src/lib/butlerProfile';
import { createButlerTools } from '../../apps/web/src/lib/butlerTools';
import { useRoutines, type RoutineState } from '../../apps/web/src/stores/routines';
import { useTodos } from '../../apps/web/src/stores/todos';

class MemoryStorage implements ButlerProfileStorage {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

interface RuntimeHarness {
  context: ButlerToolRuntimeContext;
  checkpoints: Map<string, ButlerToolCheckpoint>;
  approvals: ButlerToolCheckpoint[];
  audits: ButlerToolAuditEntry[];
}

function runtimeHarness(now = Date.UTC(2026, 6, 23, 9, 30)): RuntimeHarness {
  const checkpoints = new Map<string, ButlerToolCheckpoint>();
  const approvals: ButlerToolCheckpoint[] = [];
  const audits: ButlerToolAuditEntry[] = [];
  return {
    checkpoints,
    approvals,
    audits,
    context: {
      now: () => now,
      loadCheckpoint: async (id) => checkpoints.get(id),
      saveCheckpoint: async (checkpoint) => {
        checkpoints.set(checkpoint.id, checkpoint);
      },
      requestApproval: async (checkpoint) => {
        approvals.push(checkpoint);
      },
      writeAudit: async (entry) => {
        audits.push(entry);
      },
    },
  };
}

function tool(name: string) {
  const found = createButlerTools().find((item) => item.name === name);
  assert.ok(found, `缺少工具 ${name}`);
  return found;
}

function resetStores(): void {
  useRoutines.setState({
    routines: [],
    eventCards: [],
    seenKeys: [],
    runningIds: [],
    hydrated: false,
  });
  useTodos.setState({ todos: [] });
}

test.afterEach(() => resetStores());

function storedMemoryState(storage: ButlerProfileStorage): ButlerMemoryState {
  return parseButlerMemoryState(storage.get('rcx-butler-v2:memory') ?? '');
}

function writeMemoryState(storage: ButlerProfileStorage, state: ButlerMemoryState): void {
  storage.set('rcx-butler-v2:memory', serializeButlerMemoryState(state));
}

function appendScopedMemory(
  state: ButlerMemoryState,
  overrides: {
    kind: 'alias' | 'preference' | 'commitment';
    subject: string;
    value: string;
    scope?: {
      server?: string;
      account?: string;
      project?: string;
      room?: string;
    };
    provenance?: {
      butlerSource?: string;
      summary?: string;
      checkpointId?: string;
    };
    due?: string;
    expiresAt?: number | null;
    createdAt?: number;
    id?: string;
  },
): ButlerMemoryState {
  return rememberButlerMemory(state, {
    kind: overrides.kind,
    scope: {
      server: String(overrides.scope?.server ?? 'https://chat.example'),
      account: String(overrides.scope?.account ?? 'alice'),
      ...(overrides.scope?.project ? { project: String(overrides.scope.project) } : {}),
      ...(overrides.scope?.room ? { room: String(overrides.scope.room) } : {}),
    },
    subject: overrides.subject,
    value: overrides.value,
    ...(overrides.due ? { due: String(overrides.due) } : {}),
    provenance: {
      butlerSource: overrides.provenance?.butlerSource ?? 'seed',
      summary: overrides.provenance?.summary ?? 'seeded regression record',
      ...(overrides.provenance?.checkpointId ? { checkpointId: overrides.provenance.checkpointId } : {}),
    },
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
  }, {
    now: overrides.createdAt ?? Date.UTC(2026, 6, 23, 9, 30),
    createId: () => overrides.id ?? `seed-${Math.random().toString(36).slice(2, 8)}`,
  }).state;
}

test('工具在 checkpoint 中冻结调用时的可信 scope，审批时不读取后来切换的账号', async () => {
  const runtime = runtimeHarness();
  runtime.context.scope = {
    server: 'https://chat.example',
    account: 'user-a',
    room: 'room-a',
  };
  let executedScope: unknown;
  const scopedWrite = defineButlerTool({
    name: 'scoped_write',
    description: '测试可信 scope 捕获',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    effect: 'write',
    capability: 'memory.write',
    capture: (args, context) => ({ ...args, trustedScope: context.scope }),
    execute: async (args) => {
      executedScope = args.trustedScope;
      return 'ok';
    },
  });

  const invoked = await scopedWrite.invoke({ value: 'short' }, runtime.context);
  assert.equal(invoked.status, 'approval-required');
  assert.deepEqual(invoked.checkpoint?.params.trustedScope, {
    server: 'https://chat.example',
    account: 'user-a',
    room: 'room-a',
  });

  runtime.context.scope = {
    server: 'https://other.example',
    account: 'user-b',
    room: 'room-b',
  };
  const approved = await scopedWrite.approve?.(invoked.checkpoint!, runtime.context);
  assert.equal(approved?.status, 'completed');
  assert.deepEqual(executedScope, {
    server: 'https://chat.example',
    account: 'user-a',
    room: 'room-a',
  });
});

test('remember 在 approve 前只生成 checkpoint，不直接写长期记忆', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setButlerProfileStorage(storage);
  const runtime = runtimeHarness();
  runtime.context.scope = {
    server: 'https://chat.example',
    account: 'alice',
  };
  try {
    const remember = tool('remember');
    const invoked = await remember.invoke({
      kind: 'preference',
      scope: 'account',
      subject: 'reply-style',
      value: '默认简短回复',
    }, runtime.context);

    assert.equal(invoked.status, 'approval-required');
    assert.equal(invoked.effect, 'write');
    assert.equal(runtime.approvals.length, 1);
    assert.equal(storedMemoryState(storage).records.length, 0);
    assert.match(formatButlerToolResult(invoked), /approval-required/);
    assert.equal(JSON.stringify(runtime.audits).includes('默认简短回复'), false, '审计不能通过幂等键泄漏记忆正文');

    const approved = await remember.approve?.(invoked.checkpoint!, runtime.context);
    assert.equal(approved?.status, 'completed');
    assert.equal(approved?.checkpoint?.attempts, 1);
    assert.deepEqual(storedMemoryState(storage).records.map((record) => ({
      kind: record.kind,
      subject: record.subject,
      value: record.value,
      scope: record.scope,
    })), [{
      kind: 'preference',
      subject: 'reply-style',
      value: '默认简短回复',
      scope: {
        server: 'https://chat.example',
        account: 'alice',
      },
    }]);

    const repeated = await remember.approve?.(invoked.checkpoint!, runtime.context);
    assert.equal(repeated?.status, 'completed');
    assert.equal(repeated?.checkpoint?.attempts, 1);
    assert.equal(storedMemoryState(storage).records.length, 1);
  } finally {
    restoreStorage();
  }
});

test('remember 冻结 trusted scope/provenance，approve 前不落盘且重复 approve 保持幂等', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setButlerProfileStorage(storage);
  const runtime = runtimeHarness();
  runtime.context.scope = {
    server: 'HTTPS://CHAT.EXAMPLE',
    account: 'Alice',
    project: 'Release',
    room: 'General',
  };
  runtime.context.sessionId = 'session-a';
  runtime.context.taskId = 'task-a';
  runtime.context.callId = 'call-a';
  try {
    const remember = tool('remember');
    const invoked = await remember.invoke({
      kind: 'preference',
      scope: 'room',
      subject: 'reply-style',
      value: '默认简短回复',
    }, runtime.context);

    assert.equal(invoked.status, 'approval-required');
    assert.deepEqual(storedMemoryState(storage).records, []);
    assert.deepEqual(invoked.checkpoint?.params.trustedScope, {
      server: 'https://chat.example',
      account: 'alice',
      room: 'general',
    });
    assert.deepEqual(invoked.checkpoint?.params.capturedProvenance, {
      sessionId: 'session-a',
      taskId: 'task-a',
      callId: 'call-a',
      butlerSource: 'butler:user-confirmed',
      summary: '用户在当前 Butler 会话中直接确认',
    });

    runtime.context.scope = {
      server: 'https://other.example',
      account: 'bob',
      project: 'other',
      room: 'random',
    };
    runtime.context.sessionId = 'session-b';
    runtime.context.taskId = 'task-b';
    runtime.context.callId = 'call-b';

    const approved = await remember.approve?.(invoked.checkpoint!, runtime.context);
    assert.equal(approved?.status, 'completed');
    assert.equal(approved?.checkpoint?.attempts, 1);
    assert.deepEqual(storedMemoryState(storage).records.map((record) => ({
      kind: record.kind,
      scope: record.scope,
      subject: record.subject,
      value: record.value,
      provenance: record.provenance,
      status: record.status,
    })), [{
      kind: 'preference',
      scope: {
        server: 'https://chat.example',
        account: 'alice',
        room: 'general',
      },
      subject: 'reply-style',
      value: '默认简短回复',
      provenance: {
        sessionId: 'session-a',
        taskId: 'task-a',
        callId: 'call-a',
        checkpointId: invoked.checkpoint!.id,
        butlerSource: 'butler:user-confirmed',
        summary: '用户在当前 Butler 会话中直接确认',
      },
      status: 'active',
    }]);

    const repeated = await remember.approve?.(invoked.checkpoint!, runtime.context);
    assert.equal(repeated?.status, 'completed');
    assert.equal(repeated?.checkpoint?.attempts, 1);
    assert.equal(storedMemoryState(storage).records.length, 1);
  } finally {
    restoreStorage();
  }
});

test('recall_memory 从 v2 scoped memory 返回 typed 记录，不泄漏其他 scope', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setButlerProfileStorage(storage);
  try {
    let state = parseButlerMemoryState('');
    state = appendScopedMemory(state, {
      kind: 'preference',
      subject: 'reply-style',
      value: '默认简短回复',
      scope: { server: 'https://chat.example', account: 'alice' },
      id: 'memory-1',
      createdAt: Date.UTC(2026, 6, 23, 9, 30),
    });
    state = appendScopedMemory(state, {
      kind: 'alias',
      subject: '老李',
      value: '李建国',
      scope: { server: 'https://chat.example', account: 'alice', room: 'release-room' },
      id: 'memory-2',
      createdAt: Date.UTC(2026, 6, 23, 9, 31),
    });
    writeMemoryState(storage, state);

    const recall = tool('recall_memory');
    const invoked = await recall.invoke({
      scope: 'account',
      kind: 'preference',
      query: '简短',
    }, {
      scope: {
        server: 'https://chat.example',
        account: 'alice',
        project: 'ignored-project',
      },
    });

    assert.equal(invoked.status, 'completed');
    assert.deepEqual(JSON.parse(formatButlerToolResult(invoked)), {
      schemaVersion: 2,
      scope: {
        server: 'https://chat.example',
        account: 'alice',
      },
      records: [{
        id: 'memory-1',
        kind: 'preference',
        status: 'active',
        scope: {
          server: 'https://chat.example',
          account: 'alice',
        },
        subject: 'reply-style',
        value: '默认简短回复',
        confidence: 'confirmed',
        createdAt: '2026-07-23T09:30:00.000Z',
        confirmedAt: '2026-07-23T09:30:00.000Z',
        expiresAt: null,
        provenance: {
          butlerSource: 'seed',
          summary: 'seeded regression record',
        },
        supersedes: [],
      }],
    });
  } finally {
    restoreStorage();
  }
});

test('revoke/restore/import memory 都先等待审批，再对 v2 state 生效', async () => {
  const storage = new MemoryStorage();
  const restoreStorage = setButlerProfileStorage(storage);
  const runtime = runtimeHarness();
  runtime.context.scope = {
    server: 'https://chat.example',
    account: 'alice',
    room: 'release-room',
  };
  runtime.context.sessionId = 'session-a';
  runtime.context.taskId = 'task-a';
  runtime.context.callId = 'call-a';
  try {
    let state = parseButlerMemoryState('');
    state = appendScopedMemory(state, {
      kind: 'alias',
      subject: '老李',
      value: '李建国',
      scope: { server: 'https://chat.example', account: 'alice', room: 'release-room' },
      id: 'memory-1',
      createdAt: Date.UTC(2026, 6, 23, 9, 30),
    });
    writeMemoryState(storage, state);

    const revoke = tool('revoke_memory');
    const restore = tool('restore_memory');
    const importLegacy = tool('import_legacy_memory');

    const revokeInvoked = await revoke.invoke({ id: 'memory-1', scope: 'room' }, runtime.context);
    assert.equal(revokeInvoked.status, 'approval-required');
    assert.equal(storedMemoryState(storage).records.find((record) => record.id === 'memory-1')?.status, 'active');
    const revoked = await revoke.approve?.(revokeInvoked.checkpoint!, runtime.context);
    assert.equal(revoked?.status, 'completed');
    assert.equal(storedMemoryState(storage).records.find((record) => record.id === 'memory-1')?.status, 'revoked');

    const restoreInvoked = await restore.invoke({ id: 'memory-1', scope: 'room' }, runtime.context);
    assert.equal(restoreInvoked.status, 'approval-required');
    const restored = await restore.approve?.(restoreInvoked.checkpoint!, runtime.context);
    assert.equal(restored?.status, 'completed');
    const restoredState = storedMemoryState(storage);
    const latest = restoredState.records[0];
    assert.equal(latest?.value, '李建国');
    assert.equal(latest?.status, 'active');
    assert.equal(latest?.restoredFrom, 'memory-1');
    assert.equal(restoredState.records.find((record) => record.id === 'memory-1')?.status, 'revoked');

    storage.set('rcx-butler-v1:memory', JSON.stringify([{ id: 'legacy-1', text: '以后默认简短回复', at: 123 }]));
    storage.set('rcx-butler-v2:memory', serializeButlerMemoryState(parseButlerMemoryState('')));
    const importInvoked = await importLegacy.invoke({
      legacyId: 'legacy-1',
      kind: 'preference',
      scope: 'room',
      subject: 'legacy:legacy-1',
      value: '以后默认简短回复',
    }, runtime.context);
    assert.equal(importInvoked.status, 'approval-required');
    assert.equal(storedMemoryState(storage).records.length, 0);
    const imported = await importLegacy.approve?.(importInvoked.checkpoint!, runtime.context);
    assert.equal(imported?.status, 'completed');
    assert.deepEqual(storedMemoryState(storage).records.map((record) => ({
      subject: record.subject,
      value: record.value,
      confidence: record.confidence,
    })), [{
      subject: 'legacy:legacy-1',
      value: '以后默认简短回复',
      confidence: 'legacy-unverified',
    }]);
  } finally {
    restoreStorage();
  }
});

test('draft_routine 在 approve 后用 checkpoint id 创建并启用 routine，重复 approve 不重复创建', async () => {
  const runtime = runtimeHarness();
  const draftRoutine = tool('draft_routine');

  const invoked = await draftRoutine.invoke({
    name: '每周周报',
    time: '18:30',
    days: [5],
    skillName: 'weekly-report',
  }, runtime.context);

  assert.equal(invoked.status, 'approval-required');
  assert.equal(useRoutines.getState().routines.length, 0);
  assert.match(String(invoked.preview), /每周周报/);
  assert.match(String(invoked.preview), /18:30/);

  const approved = await draftRoutine.approve?.(invoked.checkpoint!, runtime.context);
  assert.equal(approved?.status, 'completed');
  const created = useRoutines.getState().routines[0];
  assert.ok(created);
  assert.equal(created.id, invoked.checkpoint?.id);
  assert.equal(created.name, '每周周报');
  assert.equal(created.skillName, 'weekly-report');
  assert.equal(created.enabled, true);

  const repeated = await draftRoutine.approve?.(invoked.checkpoint!, runtime.context);
  assert.equal(repeated?.status, 'completed');
  assert.equal(useRoutines.getState().routines.length, 1);
});

test('失败 checkpoint 只能在显式再次 approve 后重试，recover 与 cancel 保持纯状态变换', async () => {
  const runtime = runtimeHarness();
  const draftRoutine = tool('draft_routine');
  const originalAddRoutine = useRoutines.getState().addRoutine;

  useRoutines.setState({
    addRoutine: (() => {
      throw new Error('routines store unavailable');
    }) as RoutineState['addRoutine'],
  });

  try {
    const invoked = await draftRoutine.invoke({
      name: '失败后重试',
      time: '09:15',
      skillName: 'weekly-report',
    }, runtime.context);

    const failed = await draftRoutine.approve?.(invoked.checkpoint!, runtime.context);
    assert.equal(failed?.status, 'failed');
    assert.match(String(failed?.error?.message), /unavailable/);
    assert.equal(failed?.checkpoint?.status, 'failed');

    useRoutines.setState({ addRoutine: originalAddRoutine });
    const retried = await draftRoutine.approve?.(failed!.checkpoint!, runtime.context);
    assert.equal(retried?.status, 'completed');
    assert.equal(retried?.checkpoint?.attempts, 2);

    const running = normalizeButlerToolCheckpoint(createButlerToolCheckpoint({
      effect: 'write',
      toolName: 'manual_action',
      capability: 'proposal.execute',
      status: 'running',
      params: { action: 'reply' },
      preview: '向发布群回复确认消息',
      now: runtime.context.now?.(),
    }));
    const recovered = recoverButlerToolCheckpoint(running, runtime.context.now?.());
    assert.equal(recovered.status, 'failed');
    assert.match(String(recovered.error?.message), /中断/);

    const cancelled = await cancelButlerToolCheckpoint(recovered, runtime.context);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(runtime.checkpoints.get(cancelled.id)?.status, 'cancelled');
  } finally {
    useRoutines.setState({ addRoutine: originalAddRoutine });
  }
});

test('read 工具仍返回原字符串结果，schema 校验拒绝额外字段', async () => {
  useTodos.setState({
    todos: [{ id: 'todo-1', title: '补发布说明', note: '', excerpt: '', done: false } as never],
  });
  const runtime = runtimeHarness();
  const listTodos = tool('list_todos');

  const read = await listTodos.invoke({}, runtime.context);
  assert.equal(read.status, 'completed');
  assert.equal(formatButlerToolResult(read), '[{"id":"todo-1","text":"补发布说明","done":false}]');

  const invalid = await listTodos.invoke({ unexpected: true }, runtime.context);
  assert.equal(invalid.status, 'failed');
  assert.match(formatButlerToolResult(invalid), /^工具参数无效：/);
});
