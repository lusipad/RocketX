import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import {
  setButlerBrain,
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
} from '../../apps/web/src/lib/butlerBrain';
import { useAuth } from '../../apps/web/src/stores/auth';
import {
  flushButlerPersist,
  resetButlerPersistenceForTests,
  setButlerCodexRunner,
  setButlerLoopRunner,
  setButlerNowProvider,
  setButlerPersistence,
  useButler,
} from '../../apps/web/src/stores/butler';

const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
const restorePersistence = setButlerPersistence(appData);
test.after(() => restorePersistence());
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
  const restore = setButlerLoopRunner(async (options) => ({
    text: '第一轮回复',
    messages: options.messages,
  }));
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
    assert.equal(restored.history.at(-1)?.content, '第一轮回复');

    // 换账号（不重启）：scope 变化走切换分支，不能看到别人的对话
    login('user-2');
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '第一问'), false);
  } finally {
    restore();
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
  const restore = setButlerLoopRunner(async (options) => ({
    text: '直接入口回复',
    messages: options.messages,
  }));
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
  const restoreRunner = setButlerLoopRunner(async (options) => ({
    text: '并发入口回复',
    messages: options.messages,
  }));

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
  const restoreRunner = setButlerLoopRunner(async (options) => ({
    text: '旧 session 的完整回复',
    messages: options.messages,
  }));

  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('new-session-race-user');

    const asking = useButler.getState().ask('旧 session 的问题');
    await readsStarted;
    const creating = useButler.getState().newConversation();
    for (const read of delayedReads) read.resolve(undefined);
    await Promise.all([asking, creating]);

    const oldSession = useButler.getState().sessions.find((session) => session.title === '默认对话');
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
  const brainEntries = new Map<string, string>();
  const restoreBrainStorage = setButlerBrainStorage({
    get: (key) => brainEntries.get(key) ?? null,
    set: (key, value) => brainEntries.set(key, value),
  });
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  setButlerBrain('codex');

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

    const oldSession = useButler.getState().sessions.find((session) => session.title === '默认对话');
    assert.ok(oldSession);
    await useButler.getState().switchSession(oldSession.id);
    assert.equal(useButler.getState().lines.some((line) => line.text === 'Codex 旧 session 的问题'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === 'Codex 旧 session 的完整回复'), true);
  } finally {
    resetButlerPersistenceForTests();
    restoreRunner();
    restorePlatform();
    restoreBrainStorage();
  }
});

test('多个 session 可创建、重命名、切换，并独立恢复 transcript 与 Codex 恢复点', async () => {
  let now = 1_000;
  const restoreNow = setButlerNowProvider(() => now);
  const restore = setButlerLoopRunner(async (options) => ({
    text: `回复：${options.messages.at(-1)?.content ?? ''}`,
    messages: options.messages,
  }));
  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('session-user');
    await useButler.getState().hydrate();

    const firstSessionId = useButler.getState().activeSessionId;
    await useButler.getState().renameSession(firstSessionId, '发布调查');
    await useButler.getState().ask('第一问');
    hydrateResidentCodexThread('thread-first', 'hash-first');
    await flushButlerPersist();

    now = 2_000;
    await useButler.getState().newConversation();
    const secondSessionId = useButler.getState().activeSessionId;
    assert.notEqual(secondSessionId, firstSessionId);
    await useButler.getState().renameSession(secondSessionId, '构建调查');
    await useButler.getState().ask('第二问');
    hydrateResidentCodexThread('thread-second', 'hash-second');
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
    assert.deepEqual(residentCodexThreadSnapshot(), { threadId: 'thread-first', promptHash: 'hash-first' });

    await useButler.getState().switchSession(secondSessionId);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第二问'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第一问'), false);
    assert.deepEqual(residentCodexThreadSnapshot(), { threadId: 'thread-second', promptHash: 'hash-second' });
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
  } finally {
    await discardResidentCodexThread();
    restoreNow();
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
  const restore = setButlerLoopRunner(async (options) => ({
    text: `回复：${options.messages.at(-1)?.content ?? ''}`,
    messages: options.messages,
  }));
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
  // 两个管家对话表面都要触发恢复
  for (const page of [
    'apps/web/src/components/ButlerConversation.tsx',
    'apps/web/src/components/ButlerPanel.tsx',
  ]) {
    assert.match(readFileSync(page, 'utf8'), /hydrate/u);
  }
});
