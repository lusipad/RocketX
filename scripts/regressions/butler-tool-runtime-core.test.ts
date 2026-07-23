import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelButlerToolCheckpoint,
  createButlerToolCheckpoint,
  formatButlerToolResult,
  normalizeButlerToolCheckpoint,
  recoverButlerToolCheckpoint,
  type ButlerToolAuditEntry,
  type ButlerToolCheckpoint,
  type ButlerToolRuntimeContext,
} from '../../apps/web/src/lib/butlerToolRuntime';
import {
  recallButlerMemory,
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

test('remember 在 approve 前只生成 checkpoint，不直接写长期记忆', async () => {
  const restoreStorage = setButlerProfileStorage(new MemoryStorage());
  const runtime = runtimeHarness();
  try {
    const remember = tool('remember');
    const invoked = await remember.invoke({ fact: '我偏好简短回复' }, runtime.context);

    assert.equal(invoked.status, 'approval-required');
    assert.equal(invoked.effect, 'write');
    assert.equal(runtime.approvals.length, 1);
    assert.equal(recallButlerMemory('简短回复').length, 0);
    assert.match(formatButlerToolResult(invoked), /approval-required/);
    assert.equal(JSON.stringify(runtime.audits).includes('我偏好简短回复'), false, '审计不能通过幂等键泄漏记忆正文');

    const approved = await remember.approve?.(invoked.checkpoint!, runtime.context);
    assert.equal(approved?.status, 'completed');
    assert.equal(approved?.checkpoint?.attempts, 1);
    assert.equal(recallButlerMemory('简短回复').map((entry) => entry.text).join(','), '我偏好简短回复');

    const repeated = await remember.approve?.(invoked.checkpoint!, runtime.context);
    assert.equal(repeated?.status, 'completed');
    assert.equal(repeated?.checkpoint?.attempts, 1);
    assert.equal(recallButlerMemory('简短回复').length, 1);
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
