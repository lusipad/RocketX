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
import { residentCodexThreadSnapshot } from '../../apps/web/src/stores/butlerCodex';

const DAY = 24 * 60 * 60 * 1000;
const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
const restorePersistence = setButlerPersistence(appData);
test.after(() => restorePersistence());

function login(userId: string): void {
  useAuth.setState({ user: { _id: userId, username: `user-${userId}` } as never });
}

test('超过三天没对话：恢复时旧记录仅供回看，上下文与 Codex 线程不续', async () => {
  let now = 10 * DAY;
  const restoreNow = setButlerNowProvider(() => now);
  const restoreRunner = setButlerLoopRunner(async (options) => ({
    text: '当时的回复',
    messages: options.messages,
  }));
  try {
    login('stale-user');
    await useButler.getState().hydrate();
    await useButler.getState().ask('当时的问题');
    await flushButlerPersist();
    // 手工补上 Codex 线程快照，模拟当时用的是 Codex 大脑
    const scope = 'same-origin:stale-user';
    const saved = (await appData.get<Record<string, unknown>>('builtin:butler', scope))!;
    await appData.set('builtin:butler', scope, {
      ...saved,
      codexThread: { threadId: 'old-thread', promptHash: 'old-hash' },
    });

    // 模拟 4 天后重启
    now += 4 * DAY;
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();

    const state = useButler.getState();
    // 旧对话可回看，并有明确的新上下文提示
    assert.equal(state.lines.some((line) => line.text === '当时的问题'), true);
    assert.match(state.lines.at(-1)?.text ?? '', /已开启全新上下文/);
    // 模型历史与 Codex 线程都不续
    assert.equal(state.history.length, 0);
    assert.equal(residentCodexThreadSnapshot(), undefined);
  } finally {
    restoreNow();
    restoreRunner();
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

test('「新对话」清空对话与持久化，从全新上下文开始', async () => {
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
    await useButler.getState().newConversation();

    const state = useButler.getState();
    assert.equal(state.lines.some((line) => line.text === '旧问题'), false);
    assert.equal(state.history.length, 0);
    // 持久化的也是清空后的状态：重启不会诈尸
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '旧问题'), false);
  } finally {
    restoreRunner();
  }
});

test('两个 AI 入口都有「新对话」按钮', () => {
  for (const path of [
    'apps/web/src/pages/AiAssistantPage.tsx',
    'apps/web/src/components/ButlerPanel.tsx',
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /newConversation/, path);
    assert.match(source, /MessageSquarePlus/, path);
  }
});
