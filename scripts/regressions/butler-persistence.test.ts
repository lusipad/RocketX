import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import { setButlerBrainTauriProvider } from '../../apps/web/src/lib/butlerBrain';
import type { ButlerErrandRun } from '../../apps/web/src/lib/butlerErrands';
import { useAuth } from '../../apps/web/src/stores/auth';
import {
  appendButlerSessionLine,
  butlerSessionRecap,
  flushButlerPersist,
  resetButlerPersistenceForTests,
  setButlerCodexRunner,
  setButlerNowProvider,
  setButlerPersistence,
  useButler,
  type ButlerLine,
} from '../../apps/web/src/stores/butler';
import { useButlerErrandRuns } from '../../apps/web/src/stores/butlerErrandRuns';

const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
const restorePersistence = setButlerPersistence(appData);
// 决策 13：Codex 是唯一大脑；测试环境用 provider 冒充桌面端，runner 全部走 codex 替身
const restoreTauri = setButlerBrainTauriProvider(() => true);
test.after(() => {
  restoreTauri();
  restorePersistence();
});
import {
  discardResidentCodexThread,
  hydrateResidentCodexThread,
  residentCodexThreadSnapshot,
} from '../../apps/web/src/stores/butlerCodex';

function login(userId: string): void {
  useAuth.setState({ user: { _id: userId, username: `user-${userId}` } as never });
}

test('AI 对话落盘后重启可恢复，账号隔离', async () => {
  login('user-1');
  const restore = setButlerCodexRunner(async () => ({ text: '第一轮回复' }));
  try {
    await useButler.getState().hydrate();
    await useButler.getState().ask('第一问');
    await flushButlerPersist();

    // 模拟重启：清掉内存态与持久化范围，重新 hydrate
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();

    const restored = useButler.getState();
    assert.deepEqual(
      restored.lines.map(({ role, text }) => ({ role, text })).slice(-2),
      [
        { role: 'user', text: '第一问' },
        { role: 'assistant', text: '第一轮回复' },
      ],
    );
    // 换账号（不重启）：scope 变化走切换分支，不能看到别人的对话
    login('user-2');
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '第一问'), false);
  } finally {
    restore();
  }
});

test('房间管家使用独立会话，返回管家页时恢复原来的普通会话', async () => {
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  login('room-history-user');
  const restore = setButlerCodexRunner(async (options) => ({ text: `回复：${options.text}` }));
  const room = { rid: 'room-general', roomName: 'General' };
  try {
    await useButler.getState().hydrate();
    const standaloneSessionId = useButler.getState().activeSessionId;
    await useButler.getState().ask('整理我的本周工作');
    await flushButlerPersist();

    await useButler.getState().newConversation();
    const otherStandaloneSessionId = useButler.getState().activeSessionId;
    assert.notEqual(otherStandaloneSessionId, standaloneSessionId);
    await useButler.getState().ask('这是另一个普通会话');
    await flushButlerPersist();
    await useButler.getState().switchSession(standaloneSessionId);

    await useButler.getState().ask('你好', room);
    await flushButlerPersist();
    const roomSessionId = useButler.getState().activeSessionId;
    assert.notEqual(roomSessionId, standaloneSessionId);
    assert.equal(useButler.getState().sessions.find((session) => session.id === roomSessionId)?.origin?.rid, room.rid);

    await useButler.getState().ask('最近在讨论啥', room);
    await flushButlerPersist();
    assert.equal(
      useButler.getState().sessions.find((session) => session.id === roomSessionId)?.title,
      'General · 最近在讨论啥',
    );

    await useButler.getState().openStandaloneConversation();
    assert.equal(useButler.getState().activeSessionId, standaloneSessionId);
    assert.equal(useButler.getState().context, null);
    assert.equal(useButler.getState().lines.some((line) => line.text === '整理我的本周工作'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '这是另一个普通会话'), false);
    assert.equal(useButler.getState().lines.some((line) => line.text === '最近在讨论啥'), false);

    await useButler.getState().openRoomConversation(room);
    assert.equal(useButler.getState().activeSessionId, roomSessionId);
    assert.equal(useButler.getState().context?.label, 'General');
    assert.equal(useButler.getState().lines.some((line) => line.text === '最近在讨论啥'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '整理我的本周工作'), false);

    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();
    await useButler.getState().openStandaloneConversation();
    assert.equal(useButler.getState().activeSessionId, standaloneSessionId);
    await useButler.getState().openRoomConversation(room);
    assert.equal(useButler.getState().activeSessionId, roomSessionId);
  } finally {
    restore();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
  }
});

test('后台任务结果只写回来源会话，不覆盖当前正在看的另一段对话', async () => {
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  login('errand-return-user');
  try {
    await useButler.getState().hydrate();
    const sourceSessionId = useButler.getState().activeSessionId;
    await useButler.getState().newConversation();
    const currentSessionId = useButler.getState().activeSessionId;
    assert.notEqual(currentSessionId, sourceSessionId);

    assert.equal(
      appendButlerSessionLine(sourceSessionId, 'assistant', '「登录修复」回话了：验证通过。'),
      true,
    );
    assert.equal(
      useButler.getState().lines.some((item) => item.text.includes('登录修复')),
      false,
    );

    await useButler.getState().switchSession(sourceSessionId);
    assert.equal(
      useButler.getState().lines.some((item) => item.text === '「登录修复」回话了：验证通过。'),
      true,
    );
    await flushButlerPersist();

    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();
    await useButler.getState().switchSession(sourceSessionId);
    assert.equal(
      useButler.getState().lines.some((item) => item.text === '「登录修复」回话了：验证通过。'),
      true,
    );
  } finally {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
  }
});

test('后台任务的审批提醒和最终结果自动回到来源会话且同一审批不重复提醒', async () => {
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  useButlerErrandRuns.setState({ runs: [], visibleRuns: [] });
  login('errand-event-user');
  try {
    await useButler.getState().hydrate();
    const sourceSessionId = useButler.getState().activeSessionId;
    await useButler.getState().newConversation();
    const currentSessionId = useButler.getState().activeSessionId;
    const running: ButlerErrandRun = {
      id: 'errand-event-run',
      title: '登录修复',
      threadId: 'thread-1',
      workspaceRoot: 'D:/Repos/rocketchatx',
      workspaceName: 'RocketX',
      readOnly: false,
      startedAt: 1,
      status: 'running',
      approvals: [],
      traces: [],
      originSessionId: sourceSessionId,
    };
    useButlerErrandRuns.setState({ runs: [running], visibleRuns: [running] });

    const waiting: ButlerErrandRun = {
      ...running,
      status: 'awaiting-approval',
      approvals: [{
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        policy: {},
        params: {},
        at: 2,
      }],
    };
    useButlerErrandRuns.setState({ runs: [waiting], visibleRuns: [waiting] });
    useButlerErrandRuns.setState({
      runs: [{ ...waiting, activity: '仍在等待确认' }],
      visibleRuns: [{ ...waiting, activity: '仍在等待确认' }],
    });

    const replied: ButlerErrandRun = {
      ...waiting,
      status: 'replied',
      approvals: [],
      reply: '验证通过。',
    };
    useButlerErrandRuns.setState({ runs: [replied], visibleRuns: [replied] });

    assert.equal(useButler.getState().activeSessionId, currentSessionId);
    assert.equal(useButler.getState().lines.some((item) => item.text.includes('登录修复')), false);
    await useButler.getState().switchSession(sourceSessionId);
    assert.deepEqual(
      useButler.getState().lines
        .filter((item) => item.text.includes('登录修复'))
        .map((item) => item.text),
      [
        '「登录修复」需要你确认一项操作，已经放在任务卡里。',
        '「登录修复」回话了：验证通过。',
      ],
    );
  } finally {
    useButlerErrandRuns.setState({ runs: [], visibleRuns: [] });
    resetButlerPersistenceForTests();
    useButler.getState().reset();
  }
});

test('读取房间管家记录不会切换或停止当前普通会话', async () => {
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  login('room-preview-user');
  const restore = setButlerCodexRunner(async (options) => ({ text: `回复：${options.text}` }));
  const room = { rid: 'room-preview', roomName: 'Preview' };
  let originalStop: ReturnType<typeof useButler.getState>['stop'] | undefined;
  try {
    await useButler.getState().hydrate();
    const standaloneSessionId = useButler.getState().activeSessionId;
    await useButler.getState().ask('保留这个普通会话');
    await useButler.getState().ask('房间里讨论了什么', room);
    await useButler.getState().openStandaloneConversation();

    originalStop = useButler.getState().stop;
    let stopCalls = 0;
    useButler.setState({
      running: true,
      stop: async () => {
        stopCalls += 1;
      },
    });
    const lines = await useButler.getState().readRoomConversation(room);

    assert.equal(stopCalls, 0);
    assert.equal(useButler.getState().activeSessionId, standaloneSessionId);
    assert.equal(lines.some((line) => line.text === '房间里讨论了什么'), true);
    useButler.setState({ running: false, stop: originalStop });
  } finally {
    if (originalStop) useButler.setState({ running: false, stop: originalStop });
    resetButlerPersistenceForTests();
    useButler.getState().reset();
  }
});

test('回合失败后的 taskState 会覆盖已落盘的 running 状态', async () => {
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  login('task-failed-user');
  let rejectTurn!: (reason?: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const restore = setButlerCodexRunner(async () => {
    markStarted();
    return new Promise<never>((_resolve, reject) => {
      rejectTurn = reject;
    });
  });

  try {
    await useButler.getState().hydrate();
    const asking = useButler.getState().ask('调查昨天的问题');
    await started;
    await flushButlerPersist();
    rejectTurn(new Error('调查失败'));
    await asking;
    assert.equal(useButler.getState().taskState?.status, 'failed');
    await new Promise<void>((resolve) => setTimeout(resolve, 550));

    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().taskState?.status, 'failed');
  } finally {
    restore();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
  }
});

test('停止回合后的 taskState 会覆盖已落盘的 running 状态', async () => {
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  login('task-paused-user');
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  // Codex 的停止是服务端中断后回合就地完成：runner 在 stop 发起后正常返回
  let releaseTurn!: () => void;
  const restore = setButlerCodexRunner(async () => {
    markStarted();
    return new Promise<{ text: string }>((resolve) => {
      releaseTurn = () => resolve({ text: '' });
    });
  });

  try {
    await useButler.getState().hydrate();
    const asking = useButler.getState().ask('调查昨天的问题');
    await started;
    await flushButlerPersist();
    const stopping = useButler.getState().stop();
    releaseTurn();
    await stopping;
    await asking;
    assert.equal(useButler.getState().taskState?.status, 'paused');
    await new Promise<void>((resolve) => setTimeout(resolve, 550));

    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().taskState?.status, 'paused');
  } finally {
    restore();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
  }
});

test('直接入口发问会先 hydrate 当前 session，不丢失已存上下文', async () => {
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  login('direct-entry-user');
  await appData.set('builtin:butler', 'same-origin:direct-entry-user', {
    lines: [{ id: 'stored-line', role: 'user', text: '已存问题' }],
    history: [{ role: 'user', content: '已存问题' }],
    lastAt: 1,
  });
  const restore = setButlerCodexRunner(async () => ({ text: '直接入口回复' }));
  try {
    await useButler.getState().ask('直接入口问题');
    assert.equal(useButler.getState().lines.some((line) => line.text === '已存问题'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '直接入口问题'), true);
  } finally {
    restore();
  }
});

test('直接入口与页面同时 hydrate 时不会覆盖刚发送的消息', async () => {
  const delayedReads: Array<{ resolve: (value: unknown) => void }> = [];
  const restoreRacePersistence = setButlerPersistence({
    get: async <T>(): Promise<T | undefined> => new Promise<T | undefined>((resolve) => {
      delayedReads.push({ resolve: (value) => resolve(value as T | undefined) });
    }),
    set: async () => undefined,
  });
  const restoreRunner = setButlerCodexRunner(async () => ({ text: '并发入口回复' }));

  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('concurrent-entry-user');

    const asking = useButler.getState().ask('并发入口问题');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const mountingHydrate = useButler.getState().hydrate();
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (const read of delayedReads.slice(0, 2)) read.resolve(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const read of delayedReads.slice(2)) read.resolve(undefined);
    await Promise.all([asking, mountingHydrate]);

    assert.equal(useButler.getState().lines.some((line) => line.text === '并发入口问题'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '并发入口回复'), true);
  } finally {
    resetButlerPersistenceForTests();
    restoreRunner();
    restoreRacePersistence();
  }
});

test('发问等待 hydrate 时新建 session 不会截断旧 session 的已完成回复', async () => {
  const delayedReads: Array<{ resolve: (value: unknown) => void }> = [];
  let signalReads: (() => void) | undefined;
  const readsStarted = new Promise<void>((resolve) => {
    signalReads = resolve;
  });
  const restoreRacePersistence = setButlerPersistence({
    get: async <T>(): Promise<T | undefined> => new Promise<T | undefined>((resolve) => {
      delayedReads.push({ resolve: (value) => resolve(value as T | undefined) });
      if (delayedReads.length === 2) signalReads?.();
    }),
    set: async () => undefined,
  });
  const restoreRunner = setButlerCodexRunner(async () => ({ text: '旧 session 的完整回复' }));

  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('new-session-race-user');

    const asking = useButler.getState().ask('旧 session 的问题');
    await readsStarted;
    const creating = useButler.getState().newConversation();
    for (const read of delayedReads) read.resolve(undefined);
    await Promise.all([asking, creating]);

    const oldSession = useButler.getState().sessions.find((session) => session.title === '旧 session 的问题');
    assert.ok(oldSession);
    await useButler.getState().switchSession(oldSession.id);
    assert.equal(useButler.getState().lines.some((line) => line.text === '旧 session 的问题'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '旧 session 的完整回复'), true);
  } finally {
    resetButlerPersistenceForTests();
    restoreRunner();
    restoreRacePersistence();
  }
});

test('Codex 回合尚不可中断时新建 session 会等待旧回复完整落盘', async () => {
  let signalRunnerStarted: (() => void) | undefined;
  const runnerStarted = new Promise<void>((resolve) => {
    signalRunnerStarted = resolve;
  });
  let releaseRunner: (() => void) | undefined;
  const runnerRelease = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  const restoreRunner = setButlerCodexRunner(async () => {
    signalRunnerStarted?.();
    await runnerRelease;
    return { text: 'Codex 旧 session 的完整回复' };
  });

  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('codex-new-session-race-user');
    await useButler.getState().hydrate();

    const asking = useButler.getState().ask('Codex 旧 session 的问题');
    await runnerStarted;
    const creating = useButler.getState().newConversation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRunner?.();
    await Promise.all([asking, creating]);

    const oldSession = useButler.getState().sessions.find((session) => session.title === 'Codex 旧 session 的问题');
    assert.ok(oldSession);
    await useButler.getState().switchSession(oldSession.id);
    assert.equal(useButler.getState().lines.some((line) => line.text === 'Codex 旧 session 的问题'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === 'Codex 旧 session 的完整回复'), true);
  } finally {
    resetButlerPersistenceForTests();
    restoreRunner();
  }
});

test('多个 session 可创建、重命名、切换，并独立恢复 transcript 与 Codex 恢复点', async () => {
  let now = 1_000;
  const restoreNow = setButlerNowProvider(() => now);
  const restore = setButlerCodexRunner(async (options) => ({ text: `回复：${options.text}` }));
  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('session-user');
    await useButler.getState().hydrate();

    const firstSessionId = useButler.getState().activeSessionId;
    await useButler.getState().renameSession(firstSessionId, '发布调查');
    await useButler.getState().ask('第一问');
    hydrateResidentCodexThread('thread-first', 'hash-first', {
      createdWithCodexVersion: '0.144.4',
      createdWithRuntimeSource: 'system',
      lastResumedWithCodexVersion: '0.145.0',
      lastResumedWithRuntimeSource: 'manual',
      lastResumeMode: 'native',
    });
    await flushButlerPersist();

    now = 2_000;
    await useButler.getState().newConversation();
    const secondSessionId = useButler.getState().activeSessionId;
    assert.notEqual(secondSessionId, firstSessionId);
    await useButler.getState().renameSession(secondSessionId, '构建调查');
    await useButler.getState().ask('第二问');
    hydrateResidentCodexThread('thread-second', 'hash-second', {
      createdWithCodexVersion: '0.144.4',
      createdWithRuntimeSource: 'bundled',
      lastResumeMode: 'transcript-rebuilt',
    });
    await flushButlerPersist();

    assert.deepEqual(
      useButler.getState().sessions.map(({ id, title }) => ({ id, title })),
      [
        { id: secondSessionId, title: '构建调查' },
        { id: firstSessionId, title: '发布调查' },
      ],
    );

    await useButler.getState().switchSession(firstSessionId);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第一问'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第二问'), false);
    assert.deepEqual(residentCodexThreadSnapshot(), {
      threadId: 'thread-first',
      promptHash: 'hash-first',
      createdWithCodexVersion: '0.144.4',
      createdWithRuntimeSource: 'system',
      lastResumedWithCodexVersion: '0.145.0',
      lastResumedWithRuntimeSource: 'manual',
      lastResumeMode: 'native',
    });

    await useButler.getState().switchSession(secondSessionId);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第二问'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第一问'), false);
    assert.deepEqual(residentCodexThreadSnapshot(), {
      threadId: 'thread-second',
      promptHash: 'hash-second',
      createdWithCodexVersion: '0.144.4',
      createdWithRuntimeSource: 'bundled',
      lastResumeMode: 'transcript-rebuilt',
    });
    assert.deepEqual(
      useButler.getState().sessions.map(({ id, updatedAt }) => ({ id, updatedAt })),
      [
        { id: secondSessionId, updatedAt: 2_000 },
        { id: firstSessionId, updatedAt: 1_000 },
      ],
    );

    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await discardResidentCodexThread();
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().activeSessionId, secondSessionId);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第二问'), true);
    assert.equal(useButler.getState().sessions.length, 2);
    assert.deepEqual(residentCodexThreadSnapshot(), {
      threadId: 'thread-second',
      promptHash: 'hash-second',
      createdWithCodexVersion: '0.144.4',
      createdWithRuntimeSource: 'bundled',
      lastResumeMode: 'transcript-rebuilt',
    });
  } finally {
    await discardResidentCodexThread();
    restoreNow();
    restore();
  }
});

test('删除会话：删非活动只移除，删活动切最近，删最后一个新建默认，重启后仍生效', async () => {
  let now = 1_000;
  const restoreNow = setButlerNowProvider(() => now);
  const restore = setButlerCodexRunner(async (options) => ({ text: `回复：${options.text}` }));
  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('delete-user');
    await useButler.getState().hydrate();

    const firstSessionId = useButler.getState().activeSessionId;
    await useButler.getState().ask('第一段调查');
    now = 2_000;
    await useButler.getState().newConversation();
    const secondSessionId = useButler.getState().activeSessionId;
    await useButler.getState().ask('第二段调查');
    await flushButlerPersist();

    now = 3_000;
    await useButler.getState().newConversation();
    const thirdSessionId = useButler.getState().activeSessionId;
    await useButler.getState().ask('第三段调查');
    await flushButlerPersist();

    // 删非活动：列表少一个，活动会话与 transcript 不变
    await useButler.getState().deleteSession(firstSessionId);
    assert.equal(useButler.getState().sessions.length, 2);
    assert.equal(useButler.getState().activeSessionId, thirdSessionId);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第三段调查'), true);

    // 删除不存在/已删除的 id 是 no-op
    await useButler.getState().deleteSession(firstSessionId);
    assert.equal(useButler.getState().sessions.length, 2);

    // 删活动会话：切到最近的另一个有内容会话，并恢复它的 transcript
    await useButler.getState().deleteSession(thirdSessionId);
    assert.equal(useButler.getState().activeSessionId, secondSessionId);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第二段调查'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第三段调查'), false);

    // 删最后一个会话：新建默认会话，transcript 清空为欢迎语
    now = 4_000;
    await useButler.getState().deleteSession(secondSessionId);
    assert.notEqual(useButler.getState().activeSessionId, secondSessionId);
    assert.equal(useButler.getState().sessions.length, 1);
    assert.equal(useButler.getState().sessions[0].title, '新对话');
    assert.equal(useButler.getState().lines.some((line) => line.text === '第二段调查'), false);

    // 重启后删除仍生效
    await flushButlerPersist();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await discardResidentCodexThread();
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().sessions.length, 1);
    assert.equal(useButler.getState().sessions.some((session) => session.id === thirdSessionId), false);
    assert.equal(useButler.getState().sessions.some((session) => session.id === secondSessionId), false);
  } finally {
    await discardResidentCodexThread();
    restoreNow();
    restore();
  }
});

test('registry 体积控制：空会话不落盘，有真实提问的会话永不被自动清理', async () => {
  let now = 1_000;
  const restoreNow = setButlerNowProvider(() => now);
  const restore = setButlerCodexRunner(async (options) => ({ text: `回复：${options.text}` }));
  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('prune-user');
    await useButler.getState().hydrate();

    const realSessionId = useButler.getState().activeSessionId;
    await useButler.getState().ask('有内容的调查');
    await flushButlerPersist();

    // 连点三次「新对话」：每次都把上一个空会话留在身后
    now = 2_000;
    await useButler.getState().newConversation();
    now = 3_000;
    await useButler.getState().newConversation();
    now = 4_000;
    await useButler.getState().newConversation();
    const activeEmptyId = useButler.getState().activeSessionId;
    await flushButlerPersist();

    // 运行期不清理：空会话仍可在界面里被选中（清理与 switchSession 会竞争）
    assert.equal(useButler.getState().sessions.length, 4);

    // 重启后清理：只剩「有内容的」+「重启时活动的那个空会话」（活动豁免）
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await discardResidentCodexThread();
    await useButler.getState().hydrate();
    assert.deepEqual(
      useButler.getState().sessions.map((session) => session.id).sort(),
      [activeEmptyId, realSessionId].sort(),
    );

    // 有真实提问的会话内容原样保留
    await useButler.getState().switchSession(realSessionId);
    assert.equal(useButler.getState().lines.some((line) => line.text === '有内容的调查'), true);
  } finally {
    await discardResidentCodexThread();
    restoreNow();
    restore();
  }
});

test('「上回说到」派生：取最后一问与其后回答并截断，会话摘要带 lastAsk 预览', async () => {
  const lineOf = (role: ButlerLine['role'], text: string): ButlerLine => ({ id: `${role}-${text}`, role, text });
  assert.equal(butlerSessionRecap([]), null);
  assert.equal(butlerSessionRecap([lineOf('assistant', '欢迎语')]), null);

  const recap = butlerSessionRecap([
    lineOf('assistant', '欢迎语'),
    lineOf('user', '早先的问题'),
    lineOf('assistant', '早先的回答'),
    lineOf('user', `比较 #101 和 #102 ${'长'.repeat(60)}`),
    lineOf('assistant', '先说结论。'),
    lineOf('assistant', `最终建议：先合 #102。${'详'.repeat(90)}`),
  ]);
  assert.ok(recap);
  assert.equal(recap.lastAsk.length, 41);
  assert.equal(recap.lastAsk.endsWith('…'), true);
  assert.equal(recap.lastAsk.startsWith('比较 #101 和 #102'), true);
  assert.ok(recap.lastReply);
  assert.equal(recap.lastReply.startsWith('最终建议：先合 #102。'), true);
  assert.equal(recap.lastReply.endsWith('…'), true);

  const askOnly = butlerSessionRecap([lineOf('user', '还没有回答的问题')]);
  assert.deepEqual(askOnly, { lastAsk: '还没有回答的问题' });

  const restore = setButlerCodexRunner(async () => ({ text: '好的' }));
  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('recap-user');
    await useButler.getState().hydrate();
    await useButler.getState().ask('这个会话在查什么');
    await flushButlerPersist();
    assert.equal(useButler.getState().sessions[0].lastAsk, '这个会话在查什么');
  } finally {
    await discardResidentCodexThread();
    restore();
  }
});

test('切换服务器或账号会先保存旧 scope，并且不会串写 session', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const restore = setButlerCodexRunner(async (options) => ({ text: `回复：${options.text}` }));
  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    values.set('rcx-server', 'https://server-a.example');
    login('same-user');
    await useButler.getState().hydrate();
    await useButler.getState().ask('服务器 A 的问题');

    // 不手工 flush，hydrate 必须先把旧 scope 的防抖写入安全落盘
    values.set('rcx-server', 'https://server-b.example');
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '服务器 A 的问题'), false);
    await useButler.getState().ask('服务器 B 的问题');
    await flushButlerPersist();

    login('other-user');
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '服务器 B 的问题'), false);

    login('same-user');
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '服务器 B 的问题'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '服务器 A 的问题'), false);

    values.set('rcx-server', 'https://server-a.example');
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '服务器 A 的问题'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '服务器 B 的问题'), false);
  } finally {
    await discardResidentCodexThread();
    restore();
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test('迟到的旧 scope hydrate 结果不会覆盖当前服务器 session', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>([['rcx-server', 'https://server-a.example']]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
    },
  });

  const delayed: Array<{ resolve: (value: unknown) => void }> = [];
  let signalDelayedReads: (() => void) | undefined;
  const delayedReadsStarted = new Promise<void>((resolve) => {
    signalDelayedReads = resolve;
  });
  const writes: string[] = [];
  const restoreRacePersistence = setButlerPersistence({
    get: async <T>(_appId: string, key: string): Promise<T | undefined> => {
      if (key.includes('https://server-a.example:race-user')) {
        return new Promise<T | undefined>((resolve) => {
          delayed.push({ resolve: (value) => resolve(value as T | undefined) });
          if (delayed.length === 2) signalDelayedReads?.();
        });
      }
      if (key === 'https://server-b.example:race-user') {
        return {
          lines: [{ id: 'server-b-line', role: 'user', text: '服务器 B 的已存对话' }],
          history: [{ role: 'user', content: '服务器 B 的已存对话' }],
          lastAt: 2,
        } as T;
      }
      return undefined;
    },
    set: async (_appId, key) => {
      writes.push(key);
    },
  });

  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('race-user');

    const staleHydrate = useButler.getState().hydrate();
    await delayedReadsStarted;
    values.set('rcx-server', 'https://server-b.example');
    await useButler.getState().hydrate();

    const staleLegacy = {
      lines: [{ id: 'server-a-line', role: 'user', text: '服务器 A 的迟到对话' }],
      history: [{ role: 'user', content: '服务器 A 的迟到对话' }],
      lastAt: 1,
    };
    delayed[0]?.resolve(undefined);
    delayed[1]?.resolve(staleLegacy);
    await staleHydrate;

    assert.equal(useButler.getState().lines.some((line) => line.text === '服务器 B 的已存对话'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '服务器 A 的迟到对话'), false);
    assert.equal(writes.some((key) => key.includes('https://server-a.example:race-user')), false);
  } finally {
    resetButlerPersistenceForTests();
    await discardResidentCodexThread();
    restoreRacePersistence();
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test('Codex 常驻线程随对话一并保存，重启后走 resume 接续', () => {
  // 注水标记为 interrupted，下一次提问会经 thread/resume 恢复上下文
  hydrateResidentCodexThread('thread-1', 'hash-1');
  assert.deepEqual(residentCodexThreadSnapshot(), { threadId: 'thread-1', promptHash: 'hash-1' });
  // 本次运行已有线程时不被覆盖
  hydrateResidentCodexThread('thread-2', 'hash-2');
  assert.deepEqual(residentCodexThreadSnapshot(), { threadId: 'thread-1', promptHash: 'hash-1' });

  const butlerCodex = readFileSync('apps/web/src/stores/butlerCodex.ts', 'utf8');
  assert.match(butlerCodex, /residentStatus = 'interrupted';/);
  // 两个管家对话表面都要触发恢复；房间浮层通过只读入口恢复，不切换活动会话。
  assert.match(readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8'), /hydrate/u);
  assert.match(readFileSync('apps/web/src/components/ButlerPanel.tsx', 'utf8'), /readRoomConversation/u);
  const butlerStore = readFileSync('apps/web/src/stores/butler.ts', 'utf8');
  assert.match(butlerStore, /readRoomConversation:[\s\S]{0,220}await get\(\)\.hydrate\(\)/u);
});
