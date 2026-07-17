import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiMessage } from '../../apps/web/src/kernel/ai/provider';
import { createButlerTools } from '../../apps/web/src/lib/butlerTools';
import { setButlerLoopRunner, setButlerNowProvider, useButler } from '../../apps/web/src/stores/butler';
import { useRoutines } from '../../apps/web/src/stores/routines';

function resetStore(): void {
  useButler.getState().reset();
}

test('管家连续提问会累积模型历史和展示行', async () => {
  resetStore();
  const replies = ['第一轮回复', '第二轮回复'];
  const restore = setButlerLoopRunner(async (options) => ({
    text: replies.shift() ?? '',
    messages: options.messages,
  }));

  try {
    await useButler.getState().ask('第一问');
    await useButler.getState().ask('第二问');

    const state = useButler.getState();
    assert.deepEqual(state.history.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一轮回复' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '第二轮回复' },
    ]);
    assert.deepEqual(state.lines.slice(1).map(({ role, text }) => ({ role, text })), [
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

test('管家提示会带入可注入的本地当前时间', async () => {
  resetStore();
  const restoreNow = setButlerNowProvider(() => new Date(2026, 0, 5, 8, 30).getTime());
  const restoreRunner = setButlerLoopRunner(async (options) => {
    assert.match(options.messages[0].content, /当前时间：2026-01-05 08:30 周一$/);
    return { text: '收到。', messages: options.messages };
  });

  try {
    await useButler.getState().ask('现在几点？');
  } finally {
    restoreRunner();
    restoreNow();
    resetStore();
  }
});

test('管家将流式内容和工具活动实时写入展示状态', async () => {
  resetStore();
  const snapshots: Array<{ text: string; activity: string | null }> = [];
  const restore = setButlerLoopRunner(async (options) => {
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
    return { text: '我先查询。', messages: options.messages };
  });

  try {
    await useButler.getState().ask('今天有什么待办？');

    assert.deepEqual(snapshots, [
      { text: '我先', activity: null },
      { text: '我先', activity: '正在调用 查询待办…' },
      { text: '我先查询。', activity: '正在调用 查询待办…' },
      { text: '我先查询。', activity: null },
    ]);
    assert.equal(useButler.getState().lines.at(-1)?.text, '我先查询。');
    assert.equal(useButler.getState().activity, null);
  } finally {
    restore();
    resetStore();
  }
});

test('管家透明展示 remember 工具写入的记忆', async () => {
  resetStore();
  const restore = setButlerLoopRunner(async (options) => {
    options.onEvent?.({
      type: 'tool-call',
      toolCall: { id: 'remember_1', name: 'remember', arguments: '{"fact":"我偏好简短回复"}' },
    });
    options.onEvent?.({ type: 'tool-result', toolCallId: 'remember_1', content: '已记住：我偏好简短回复' });
    return { text: '我会按这个偏好回复。', messages: options.messages };
  });

  try {
    await useButler.getState().ask('以后简短一点');

    assert.deepEqual(useButler.getState().lines.slice(1).map(({ role, text }) => ({ role, text })), [
      { role: 'user', text: '以后简短一点' },
      { role: 'assistant', text: '📌 已记住：我偏好简短回复' },
      { role: 'assistant', text: '我会按这个偏好回复。' },
    ]);
  } finally {
    restore();
    resetStore();
  }
});

test('未配置 Provider 时保留输入并显示友好错误', async () => {
  resetStore();
  const restore = setButlerLoopRunner(async () => {
    throw new Error('AI Provider 不存在: unconfigured');
  });

  try {
    await useButler.getState().ask('帮我看看今天的情况');

    const state = useButler.getState();
    assert.equal(state.error, '尚未配置 AI Provider，可在设置页添加；快速搜索与查询不受影响。');
    assert.equal(state.running, false);
    assert.equal(state.lines.at(-1)?.text, '帮我看看今天的情况');
  } finally {
    restore();
    resetStore();
  }
});

test('裁剪历史时不会留下没有对应 assistant 工具调用的 tool 消息', async () => {
  resetStore();
  const history: AiMessage[] = [
    {
      role: 'assistant',
      content: '先查一下。',
      toolCalls: [{ id: 'call_1', name: 'list_todos', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: '[]' },
    ...Array.from({ length: 37 }, (_, index): AiMessage => ({ role: 'user', content: `旧问题 ${index}` })),
  ];
  useButler.setState({ history });
  const restore = setButlerLoopRunner(async (options) => ({ text: '新的回复', messages: options.messages }));

  try {
    await useButler.getState().ask('新问题');

    const next = useButler.getState().history;
    assert.ok(next.length <= 40);
    assert.equal(next.some((message) => message.role === 'tool'), false);
    assert.equal(next.some((message) => message.toolCalls?.some((call) => call.id === 'call_1')), false);
    assert.deepEqual(next.slice(-2).map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '新的回复' },
    ]);
  } finally {
    restore();
    resetStore();
  }
});

test('draft_routine 只能落草案，确认后才创建并启用例行事务', async () => {
  resetStore();
  useRoutines.setState({ routines: [], eventCards: [], seenKeys: [], runningIds: [], hydrated: false });
  const draftRoutine = createButlerTools().find((tool) => tool.name === 'draft_routine');
  assert.ok(draftRoutine);

  assert.match(await draftRoutine.execute({ name: '晨报', time: '8:30', skillName: 'morning-brief' }), /时间格式无效/);
  assert.equal(useButler.getState().routineDraft, null);
  assert.match(await draftRoutine.execute({ name: '晨报', time: '08:30', skillName: 'missing-skill' }), /未找到技能/);
  assert.equal(useButler.getState().routineDraft, null);

  assert.equal(
    await draftRoutine.execute({ name: '每周周报', time: '18:30', days: [5], skillName: 'weekly-report' }),
    '已生成例行事务草案，等待用户确认。',
  );
  assert.deepEqual(useButler.getState().routineDraft, { name: '每周周报', time: '18:30', days: [5], skillName: 'weekly-report' });
  assert.equal(useRoutines.getState().routines.length, 0);

  useButler.getState().confirmRoutineDraft();
  const created = useRoutines.getState().routines[0];
  assert.equal(created.name, '每周周报');
  assert.equal(created.enabled, true);
  assert.equal(created.skillName, 'weekly-report');
  assert.equal(useButler.getState().routineDraft, null);
  useRoutines.setState({ routines: [], eventCards: [], seenKeys: [], runningIds: [], hydrated: false });
});
