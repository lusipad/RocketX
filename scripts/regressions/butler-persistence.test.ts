import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import { useAuth } from '../../apps/web/src/stores/auth';
import {
  flushButlerPersist,
  resetButlerPersistenceForTests,
  setButlerLoopRunner,
  setButlerPersistence,
  useButler,
} from '../../apps/web/src/stores/butler';

const restorePersistence = setButlerPersistence(
  createRcxStore({ backend: createMemoryBackend() }).appData,
);
test.after(() => restorePersistence());
import {
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

test('首次 hydrate 不覆盖已经开始的新对话', async () => {
  resetButlerPersistenceForTests();
  useButler.getState().reset();
  login('user-1');
  const restore = setButlerLoopRunner(async (options) => ({
    text: '新对话回复',
    messages: options.messages,
  }));
  try {
    await useButler.getState().ask('抢先提问'); // hydrate 之前用户已开聊
    await useButler.getState().hydrate();
    assert.equal(useButler.getState().lines.some((line) => line.text === '抢先提问'), true);
    assert.equal(useButler.getState().lines.some((line) => line.text === '第一问'), false);
  } finally {
    restore();
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
  // 两个入口都要触发恢复
  for (const page of [
    'apps/web/src/pages/AiAssistantPage.tsx',
    'apps/web/src/components/ButlerPanel.tsx',
  ]) {
    assert.match(readFileSync(page, 'utf8'), /hydrate/u);
  }
});
