import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import { useAuth } from '../../apps/web/src/stores/auth';
import {
  flushButlerPersist,
  resetButlerPersistenceForTests,
  setButlerLoopRunner,
  setButlerNowProvider,
  setButlerPersistence,
  useButler,
} from '../../apps/web/src/stores/butler';
import {
  discardResidentCodexThread,
  residentCodexThreadSnapshot,
} from '../../apps/web/src/stores/butlerCodex';

const DAY = 24 * 60 * 60 * 1000;
const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
const restorePersistence = setButlerPersistence(appData);
test.after(() => restorePersistence());

function login(userId: string): void {
  useAuth.setState({ user: { _id: userId, username: `user-${userId}` } as never });
}

test('超过三天没对话：恢复时仍接续 transcript、模型历史与 Codex 恢复点', async () => {
  let now = 10 * DAY;
  const restoreNow = setButlerNowProvider(() => now);
  try {
    login('stale-user');
    const scope = 'same-origin:stale-user';
    // 只存在旧版单会话记录，且最后活动已超过固定三天窗口
    await appData.set('builtin:butler', scope, {
      lines: [
        { id: 'old-user', role: 'user', text: '当时的问题' },
        { id: 'old-assistant', role: 'assistant', text: '当时的回复' },
      ],
      history: [
        { role: 'user', content: '当时的问题' },
        { role: 'assistant', content: '当时的回复' },
      ],
      codexThread: { threadId: 'old-thread', promptHash: 'old-hash' },
      lastAt: now,
    });

    // 模拟 4 天后重启
    now += 4 * DAY;
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();

    const state = useButler.getState();
    // 固定时间窗不再截断恢复，旧 transcript 与模型上下文都能继续
    assert.equal(state.lines.some((line) => line.text === '当时的问题'), true);
    assert.equal(state.lines.some((line) => /已开启全新上下文/.test(line.text)), false);
    assert.equal(state.history.at(-1)?.content, '当时的回复');
    assert.deepEqual(residentCodexThreadSnapshot(), { threadId: 'old-thread', promptHash: 'old-hash' });

    // 旧记录无损迁入新 registry；旧 key 继续镜像当前会话供旧版本回滚读取
    assert.equal(state.sessions.length, 1);
    const activeSessionId = state.activeSessionId;
    const registry = await appData.get<{
      schemaVersion: number;
      activeSessionId: string;
      sessions: Array<{ id: string; lines: Array<{ text: string }> }>;
    }>('builtin:butler', `session-registry:${scope}`);
    assert.equal(registry?.schemaVersion, 1);
    assert.equal(registry?.activeSessionId, activeSessionId);
    assert.equal(registry?.sessions[0]?.lines.some((item) => item.text === '当时的问题'), true);

    await state.renameSession(activeSessionId, '历史调查');
    await flushButlerPersist();
    const rollback = await appData.get<{ lines: Array<{ text: string }>; codexThread?: { threadId: string } }>(
      'builtin:butler',
      scope,
    );
    assert.equal(rollback?.lines.some((item) => item.text === '当时的问题'), true);
    assert.equal(rollback?.codexThread?.threadId, 'old-thread');
  } finally {
    await discardResidentCodexThread();
    restoreNow();
  }
});

test('三天内的对话正常接续上下文', async () => {
  let now = 20 * DAY;
  const restoreNow = setButlerNowProvider(() => now);
  const restoreRunner = setButlerLoopRunner(async (options) => ({
    text: '昨天的回复',
    messages: options.messages,
  }));
  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('fresh-user');
    await useButler.getState().hydrate();
    await useButler.getState().ask('昨天的问题');
    await flushButlerPersist();

    now += 1 * DAY;
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();

    const state = useButler.getState();
    assert.equal(state.history.at(-1)?.content, '昨天的回复');
    assert.equal(state.lines.some((line) => /已开启全新上下文/.test(line.text)), false);
  } finally {
    restoreNow();
    restoreRunner();
  }
});

test('「新对话」创建独立 session，旧 transcript 可切回恢复', async () => {
  const restoreRunner = setButlerLoopRunner(async (options) => ({
    text: '旧回复',
    messages: options.messages,
  }));
  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    login('reset-user');
    await useButler.getState().hydrate();
    await useButler.getState().ask('旧问题');
    const oldSessionId = useButler.getState().activeSessionId;
    await useButler.getState().newConversation();

    const state = useButler.getState();
    assert.equal(state.lines.some((line) => line.text === '旧问题'), false);
    assert.equal(state.history.length, 0);
    assert.equal(state.sessions.length, 2);
    assert.notEqual(state.activeSessionId, oldSessionId);
    await useButler.getState().switchSession(oldSessionId);
    assert.equal(useButler.getState().lines.some((line) => line.text === '旧问题'), true);

    // 当前 session 与旧 session 都能跨重启恢复
    await useButler.getState().switchSession(state.activeSessionId);
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '旧问题'), false);
    assert.equal(useButler.getState().sessions.length, 2);
    await useButler.getState().switchSession(oldSessionId);
    assert.equal(useButler.getState().lines.some((line) => line.text === '旧问题'), true);
  } finally {
    restoreRunner();
  }
});

test('两个管家对话表面共用 session 切换器', () => {
  for (const path of [
    'apps/web/src/components/ButlerConversation.tsx',
    'apps/web/src/components/ButlerPanel.tsx',
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /ButlerSessionSwitcher/, path);
  }
  const switcher = readFileSync('apps/web/src/components/ButlerSessionSwitcher.tsx', 'utf8');
  assert.match(switcher, /switchSession/);
  assert.match(switcher, /renameSession/);
  assert.match(switcher, /newConversation/);
});
