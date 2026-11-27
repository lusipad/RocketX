import assert from 'node:assert/strict';
import test from 'node:test';
import { createStartupCoordinator, type StartupAuthSnapshot, type StartupState } from '../../apps/web/src/lib/startup';

function auth(status: StartupAuthSnapshot['status'], userId: string | null): StartupAuthSnapshot {
  return { status, userId };
}

test('启动协调器按阶段执行且重复 start 共用同一个 promise', async () => {
  const calls: string[] = [];
  const states: StartupState[] = [];
  let current = auth('authed', 'user-1');
  const coordinator = createStartupCoordinator({
    steps: {
      preparePlatform: () => calls.push('platform'),
      restoreAuth: async () => calls.push('auth'),
      readAuth: () => current,
      hydrateAccount: (userId) => calls.push(`account:${userId}`),
      loadCoreData: async () => calls.push('core'),
      initializeRuntime: async () => calls.push('runtime'),
      initializeKernel: async () => calls.push('kernel'),
      startBackground: async () => calls.push('background'),
    },
    onState: (state) => states.push(state),
  });

  const first = coordinator.start();
  const second = coordinator.start();
  assert.strictEqual(first, second);
  await first;
  assert.deepEqual(calls, ['platform', 'auth', 'account:user-1', 'core', 'runtime', 'kernel', 'background']);
  assert.equal(coordinator.getState().stage, 'background-ready');
  assert.deepEqual(states.filter((state) => state.operation === null).map((state) => state.stage), [
    'idle',
    'platform-ready',
    'account-scope-ready',
    'auth-restored',
    'core-data-ready',
    'messaging-connected',
    'kernel-ready',
    'background-ready',
  ]);
  assert.deepEqual(
    states.filter((state) => state.operation).map((state) => state.operation),
    ['platform', 'auth', 'account', 'core', 'runtime', 'kernel', 'background'],
  );
});

test('无账号停在 guest，不启动账号数据、Kernel 或后台任务', async () => {
  const calls: string[] = [];
  const coordinator = createStartupCoordinator({
    steps: {
      preparePlatform: () => calls.push('platform'),
      restoreAuth: async () => calls.push('auth'),
      readAuth: () => auth('guest', null),
      hydrateAccount: () => calls.push('account'),
      loadCoreData: async () => calls.push('core'),
      initializeRuntime: async () => calls.push('runtime'),
      initializeKernel: async () => calls.push('kernel'),
      startBackground: async () => calls.push('background'),
    },
    onState: () => {},
  });
  await coordinator.start();
  assert.deepEqual(calls, ['platform', 'auth']);
  assert.equal(coordinator.getState().stage, 'guest');
});

test('阶段超时进入可重试错误，重试成功后恢复 ready', async () => {
  const calls: string[] = [];
  const states: StartupState[] = [];
  let shouldTimeout = true;
  const coordinator = createStartupCoordinator({
    steps: {
      preparePlatform: () => {},
      restoreAuth: async () => {},
      readAuth: () => auth('authed', 'user-1'),
      hydrateAccount: () => {},
      loadCoreData: async () => {
        if (shouldTimeout) await new Promise(() => {});
        calls.push('core');
      },
      initializeRuntime: async () => {},
      initializeKernel: async () => {},
      startBackground: async () => {},
    },
    onState: (state) => states.push(state),
    timeouts: { core: 5 },
  });
  await coordinator.start();
  assert.equal(coordinator.getState().stage, 'error');
  assert.equal(coordinator.getState().error?.stage, 'auth-restored');
  shouldTimeout = false;
  await coordinator.retry();
  assert.equal(coordinator.getState().stage, 'background-ready');
  assert.equal(calls.length, 1);
  assert.ok(states.some((state) => state.stage === 'error'));
});

test('超时会 abort 旧阶段，旧阶段完成后不能覆盖新一轮状态', async () => {
  let attempts = 0;
  let aborted = false;
  const coordinator = createStartupCoordinator({
    steps: {
      preparePlatform: () => {},
      restoreAuth: async () => {},
      readAuth: () => auth('authed', 'user-1'),
      hydrateAccount: () => {},
      loadCoreData: async (signal) => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            }, { once: true });
          });
          return;
        }
      },
      initializeRuntime: async () => {},
      initializeKernel: async () => {},
      startBackground: async () => {},
    },
    onState: () => {},
    timeouts: { core: 5 },
  });
  await coordinator.start();
  assert.equal(coordinator.getState().stage, 'error');
  await coordinator.retry();
  assert.equal(aborted, true);
  assert.equal(attempts, 2);
  assert.equal(coordinator.getState().stage, 'background-ready');
});
