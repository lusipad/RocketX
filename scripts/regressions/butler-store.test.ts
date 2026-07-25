import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiMessage } from '../../apps/web/src/kernel/ai/provider';
import { setButlerBrainTauriProvider } from '../../apps/web/src/lib/butlerBrain';
import { parseButlerMemoryState } from '../../apps/web/src/lib/butlerMemory';
import { setButlerProfileStorage, type ButlerProfileStorage } from '../../apps/web/src/lib/butlerProfile';
import { createButlerTools, type ButlerRoutineDraft } from '../../apps/web/src/lib/butlerTools';
import {
  formatButlerToolResult,
  type ButlerToolCheckpoint,
  type ButlerToolRuntimeContext,
} from '../../apps/web/src/lib/butlerToolRuntime';
import { setButlerCodexRunner, setButlerNowProvider, setButlerPersistence, setButlerToolAuditWriter, trimButlerHistory, useButler } from '../../apps/web/src/stores/butler';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useRoutines } from '../../apps/web/src/stores/routines';
import { getServerBase, setServerBase } from '../../apps/web/src/lib/client';

// 决策 13：Codex 是唯一大脑；测试环境冒充桌面端
const restoreTauriForFile = setButlerBrainTauriProvider(() => true);
test.after(() => restoreTauriForFile());

function resetStore(): void {
  useButler.getState().reset();
}

class MemoryStorage implements ButlerProfileStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

type RoutineDraftWithCheckpoint = ButlerRoutineDraft & { checkpointId?: string };

interface RuntimeHarness {
  checkpoints: Map<string, ButlerToolCheckpoint>;
  approvals: ButlerToolCheckpoint[];
  context: ButlerToolRuntimeContext;
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

function storedMemoryRecords(storage: ButlerProfileStorage) {
  return parseButlerMemoryState(storage.get('rcx-butler-v2:memory') ?? '').records;
}

test('管家连续提问会累积展示行', async () => {
  resetStore();
  const replies = ['第一轮回复', '第二轮回复'];
  const restore = setButlerCodexRunner(async () => ({ text: replies.shift() ?? '' }));

  try {
    await useButler.getState().ask('第一问');
    await useButler.getState().ask('第二问');

    assert.deepEqual(useButler.getState().lines.slice(1).map(({ role, text }) => ({ role, text })), [
      { role: 'user', text: '第一问' },
      { role: 'assistant', text: '第一轮回复' },
      { role: 'user', text: '第二问' },
      { role: 'assistant', text: '第二轮回复' },
    ]);
  } finally {
    restore();
    resetStore();
  }
});

test('管家本轮收到图片，展示行保留附件名称', async () => {
  resetStore();
  let captured: Array<{ dataUrl: string }> | undefined;
  const restore = setButlerCodexRunner(async (options) => {
    captured = options.images?.map(({ dataUrl }) => ({ dataUrl }));
    return { text: '看到了。' };
  });

  try {
    await useButler.getState().ask('分析截图', undefined, [{
      name: 'screen.png',
      type: 'image/png',
      size: 5,
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
    }]);

    assert.deepEqual(captured, [{ dataUrl: 'data:image/png;base64,aW1hZ2U=' }]);
    assert.equal(useButler.getState().lines.at(-2)?.attachments?.[0]?.name, 'screen.png');
  } finally {
    restore();
    resetStore();
  }
});

test('管家回合会带入可注入的本地当前时间', async () => {
  resetStore();
  const injectedNow = new Date(2026, 0, 5, 8, 30).getTime();
  const restoreNow = setButlerNowProvider(() => injectedNow);
  const restoreRunner = setButlerCodexRunner(async (options) => {
    assert.equal(options.now, injectedNow);
    return { text: '收到。' };
  });

  try {
    await useButler.getState().ask('现在几点？');
  } finally {
    restoreRunner();
    restoreNow();
    resetStore();
  }
});

test('房间上下文只随本次回合传给引擎，不污染后续回合与展示行', async () => {
  resetStore();
  const captured: Array<unknown> = [];
  const restore = setButlerCodexRunner(async (options) => {
    captured.push(options.context);
    return { text: '收到。' };
  });

  try {
    await useButler.getState().ask('这周方案定了吗？', { rid: 'room-1', roomName: '产品讨论' });
    await useButler.getState().ask('再确认一次。');

    assert.equal((captured[0] as { label?: string } | undefined)?.label, '产品讨论');
    assert.equal(captured[1], undefined);
    assert.equal(useButler.getState().lines.some((line) => line.text.includes('产品讨论')), false);
  } finally {
    restore();
    resetStore();
  }
});

test('管家将流式内容和工具活动实时写入展示状态', async () => {
  resetStore();
  const snapshots: Array<{ text: string; activity: string | null }> = [];
  const restore = setButlerCodexRunner(async (options) => {
    options.onEvent?.({ type: 'content', content: '我先' });
    snapshots.push({ text: useButler.getState().lines.at(-1)?.text ?? '', activity: useButler.getState().activity });
    options.onEvent?.({
      type: 'tool-call',
      toolCall: { id: 'call_1', name: 'list_todos', arguments: '{}' },
    });
    snapshots.push({ text: useButler.getState().lines.at(-1)?.text ?? '', activity: useButler.getState().activity });
    options.onEvent?.({ type: 'content', content: '查询。' });
    snapshots.push({ text: useButler.getState().lines.at(-1)?.text ?? '', activity: useButler.getState().activity });
    options.onEvent?.({ type: 'tool-result', toolCallId: 'call_1', content: '[]' });
    snapshots.push({ text: useButler.getState().lines.at(-1)?.text ?? '', activity: useButler.getState().activity });
    return { text: '我先查询。' };
  });

  try {
    await useButler.getState().ask('今天有什么待办？');

    // 工具返回后不回落 null：否则界面退回通用兜底「正在处理请求…」，
    // 等于把刚建立起来的进度感又丢掉（Codex 路径随后会用 summarizing 覆盖）。
    assert.deepEqual(snapshots, [
      { text: '我先', activity: null },
      { text: '我先', activity: '正在调用 查询待办…' },
      { text: '我先查询。', activity: '正在调用 查询待办…' },
      { text: '我先查询。', activity: '正在整理结果…' },
    ]);
    assert.equal(useButler.getState().lines.at(-1)?.text, '我先查询。');
    assert.equal(useButler.getState().activity, null);
  } finally {
    restore();
    resetStore();
  }
});

test('remember 在 ask 流里只留下待审批 checkpoint，不伪造已写入成功消息', async () => {
  resetStore();
  const restore = setButlerCodexRunner(async (options) => {
    options.onEvent?.({
      type: 'tool-call',
      toolCall: {
        id: 'remember_1',
        name: 'remember',
        arguments: '{"kind":"preference","scope":"account","subject":"reply-style","value":"默认简短回复"}',
      },
    });
    options.onEvent?.({ type: 'tool-result', toolCallId: 'remember_1', content: 'approval-required：写入长期记忆；尚未执行。' });
    return { text: '我会按这个偏好回复。' };
  });

  try {
    await useButler.getState().ask('以后简短一点');

    assert.deepEqual(useButler.getState().lines.slice(1).map(({ role, text }) => ({ role, text })), [
      { role: 'user', text: '以后简短一点' },
      { role: 'assistant', text: '我会按这个偏好回复。' },
    ]);
  } finally {
    restore();
    resetStore();
  }
});

test('ask runner 的 toolRuntimeContext 冻结当前 auth 与 room/project source snapshot', async () => {
  resetStore();
  const restorePersistence = setButlerPersistence({
    get: async () => undefined,
    set: async () => undefined,
  });
  const previousAuth = useAuth.getState();
  const previousServerBase = getServerBase();
  const previousLocalStorage = globalThis.localStorage;
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
      removeItem: (key: string) => {
        entries.delete(key);
      },
    },
  });
  useButler.setState({ activeSessionId: 'session-1' });
  useAuth.setState({
    status: 'authed',
    user: { _id: 'alice' } as never,
  });
  setServerBase('https://chat.example');
  const captured: ButlerToolRuntimeContext[] = [];
  const restore = setButlerCodexRunner(async (options) => {
    const first = options.toolRuntimeContext?.({ id: 'remember_1', name: 'remember', arguments: '{}' } as never);
    assert.ok(first);
    captured.push(first);
    useButler.setState({
      context: {
        kind: 'room',
        label: 'Other',
        detail: '切走后的房间',
        sources: [
          { kind: 'room', id: 'room-other', rid: 'room-other', label: 'Other' },
          { kind: 'work-item', id: 'wi-2', project: 'project-b', label: '#2' },
        ],
      } as never,
    });
    const second = options.toolRuntimeContext?.({ id: 'remember_2', name: 'remember', arguments: '{}' } as never);
    assert.ok(second);
    captured.push(second);
    return { text: '收到。' };
  });

  try {
    await useButler.getState().ask('记一下发布偏好', {
      kind: 'room',
      label: 'General',
      detail: '当前 Rocket.Chat 房间',
      sources: [
        { kind: 'room', id: 'room-general', rid: 'room-general', label: 'General' },
        { kind: 'work-item', id: 'wi-1', project: 'project-a', label: '#1 发布' },
      ],
    } as never);

    assert.equal(captured.length, 2);
    assert.ok(captured[0]?.taskId);
    assert.equal(captured[1]?.taskId, captured[0]?.taskId);
    assert.ok(captured[0]?.sessionId);
    assert.equal(captured[1]?.sessionId, captured[0]?.sessionId);
    assert.deepEqual(captured.map((context) => ({
      callId: context.callId,
      scope: context.scope,
      sources: context.sources,
    })), [
      {
        callId: 'remember_1',
        scope: {
          server: 'https://chat.example',
          account: 'alice',
          project: 'project-a',
          room: 'room-general',
        },
        sources: [
          { kind: 'room', id: 'room-general', rid: 'room-general' },
          { kind: 'work-item', id: 'wi-1', project: 'project-a' },
        ],
      },
      {
        callId: 'remember_2',
        scope: {
          server: 'https://chat.example',
          account: 'alice',
          project: 'project-a',
          room: 'room-general',
        },
        sources: [
          { kind: 'room', id: 'room-general', rid: 'room-general' },
          { kind: 'work-item', id: 'wi-1', project: 'project-a' },
        ],
      },
    ]);
  } finally {
    restore();
    restorePersistence();
    useAuth.setState(previousAuth);
    setServerBase(previousServerBase);
    if (previousLocalStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: previousLocalStorage,
      });
    }
    resetStore();
  }
});

test('确认 typed remember checkpoint 后写入 v2 memory，并在对话中追加一次性审批结果', async () => {
  resetStore();
  const storage = new MemoryStorage();
  const restoreStorage = setButlerProfileStorage(storage);
  const restoreAuditWriter = setButlerToolAuditWriter(() => undefined);
  const remember = createButlerTools().find((tool) => tool.name === 'remember');
  assert.ok(remember);
  const runtime = runtimeHarness();
  runtime.context.scope = {
    server: 'https://chat.example',
    account: 'alice',
    room: 'release-room',
  };
  try {
    const invoked = await remember.invoke({
      kind: 'preference',
      scope: 'room',
      subject: 'reply-style',
      value: '默认简短回复',
    }, runtime.context);

    assert.equal(invoked.status, 'approval-required');
    assert.equal(storedMemoryRecords(storage).length, 0);
    assert.equal(useButler.getState().runtimeCheckpoints.length, 1);

    await useButler.getState().approveToolCheckpoint(invoked.checkpoint!.id);
    assert.deepEqual(storedMemoryRecords(storage).map((record) => ({
      kind: record.kind,
      scope: record.scope,
      subject: record.subject,
      value: record.value,
      status: record.status,
    })), [{
      kind: 'preference',
      scope: {
        server: 'https://chat.example',
        account: 'alice',
        room: 'release-room',
      },
      subject: 'reply-style',
      value: '默认简短回复',
      status: 'active',
    }]);
    assert.equal(useButler.getState().lines.at(-1)?.text, '📌 已记录 preference 记忆（room:release-room）：reply-style = 默认简短回复');

    const lineCount = useButler.getState().lines.length;
    await useButler.getState().approveToolCheckpoint(invoked.checkpoint!.id);
    assert.equal(storedMemoryRecords(storage).length, 1);
    assert.equal(useButler.getState().lines.length, lineCount);
  } finally {
    restoreAuditWriter();
    restoreStorage();
    resetStore();
  }
});

test('回合失败时保留输入并显示友好错误，不丢用户的问题', async () => {
  resetStore();
  const restore = setButlerCodexRunner(async () => {
    throw new Error('unexpected boom');
  });

  try {
    await useButler.getState().ask('帮我看看今天的情况');

    const state = useButler.getState();
    assert.equal(state.error, 'Codex 大脑暂时无法回答，请稍后重试。');
    assert.equal(state.running, false);
    assert.equal(state.lines.at(-1)?.text, '帮我看看今天的情况');
  } finally {
    restore();
    resetStore();
  }
});

test('非桌面端不静默降级，明说管家在桌面端且不调用引擎', async () => {
  resetStore();
  const restorePlatform = setButlerBrainTauriProvider(() => false);
  let runnerCalled = false;
  const restoreRunner = setButlerCodexRunner(async () => {
    runnerCalled = true;
    return { text: '不应执行' };
  });

  try {
    await useButler.getState().ask('帮我看看今天的情况');
    const state = useButler.getState();
    assert.equal(runnerCalled, false);
    assert.match(state.error ?? '', /桌面端/);
    assert.equal(state.lines.at(-1)?.text, '帮我看看今天的情况');
  } finally {
    restoreRunner();
    restorePlatform();
    resetStore();
  }
});

test('裁剪历史时不会留下没有对应 assistant 工具调用的 tool 消息', () => {
  // hydrate 恢复旧会话的 history 时仍走 trimButlerHistory；孤儿 tool 消息会让 provider 报错
  const history: AiMessage[] = [
    {
      role: 'assistant',
      content: '先查一下。',
      toolCalls: [{ id: 'call_1', name: 'list_todos', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: '[]' },
    ...Array.from({ length: 39 }, (_, index): AiMessage => ({ role: 'user', content: `旧问题 ${index}` })),
  ];
  const next = trimButlerHistory(history);
  assert.ok(next.length <= 40);
  assert.equal(next.some((message) => message.role === 'tool'), false);
  assert.equal(next.some((message) => message.toolCalls?.some((call) => call.id === 'call_1')), false);
});

test('draft_routine 只能落草案，确认后才创建并启用例行事务', async () => {
  resetStore();
  useRoutines.setState({ routines: [], eventCards: [], seenKeys: [], runningIds: [], hydrated: false });
  const draftRoutine = createButlerTools().find((tool) => tool.name === 'draft_routine');
  assert.ok(draftRoutine);
  const runtime = runtimeHarness();

  const invalidTime = await draftRoutine.invoke({ name: '晨报', time: '8:30', skillName: 'morning-brief' }, runtime.context);
  assert.match(formatButlerToolResult(invalidTime), /时间格式无效/);
  assert.equal(useButler.getState().routineDraft, null);
  const missingSkill = await draftRoutine.invoke({ name: '晨报', time: '08:30', skillName: 'missing-skill' }, runtime.context);
  assert.match(formatButlerToolResult(missingSkill), /未找到技能/);
  assert.equal(useButler.getState().routineDraft, null);

  const invoked = await draftRoutine.invoke({ name: '每周周报', time: '18:30', days: [5], skillName: 'weekly-report' }, runtime.context);
  assert.equal(invoked.status, 'approval-required');
  assert.match(formatButlerToolResult(invoked), /approval-required/);
  assert.equal(runtime.approvals.length, 1);
  const draft = useButler.getState().routineDraft as RoutineDraftWithCheckpoint | null;
  assert.ok(draft);
  assert.equal(draft.name, '每周周报');
  assert.equal(draft.time, '18:30');
  assert.deepEqual(draft.days, [5]);
  assert.equal(draft.skillName, 'weekly-report');
  assert.equal(draft.checkpointId, invoked.checkpoint?.id);
  assert.equal(useRoutines.getState().routines.length, 0);

  const originalApprove = useButler.getState().approveToolCheckpoint;
  useButler.setState({
    approveToolCheckpoint: async (checkpointId) => {
      const checkpoint = runtime.checkpoints.get(checkpointId);
      assert.ok(checkpoint, `缺少 checkpoint ${checkpointId}`);
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
  assert.equal(created.enabled, true);
  assert.equal(created.skillName, 'weekly-report');
  assert.equal(useButler.getState().routineDraft, null);
  useRoutines.setState({ routines: [], eventCards: [], seenKeys: [], runningIds: [], hydrated: false });
});
