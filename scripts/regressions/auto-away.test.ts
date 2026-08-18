import assert from 'node:assert/strict';
import test from 'node:test';
import { rest } from '../../apps/web/src/lib/client';
import { startAutoAway } from '../../apps/web/src/lib/autoAway';
import { useAuth } from '../../apps/web/src/stores/auth';
import { usePrefs } from '../../apps/web/src/stores/prefs';

/**
 * 自动离开（设置页 enableAutoAway / idleTimeLimit 的执行端）：
 * fake timer + mock rest + 注入 EventTarget，锁定「超时置 away、活动恢复、
 * 不跟手动状态打架、偏好实时生效、下限钳制」的语义。
 */

const originalSetStatus = rest.setStatus;

let dispose: (() => void) | null = null;
let statuses: string[];

function setup(opts: { enabled?: boolean; idleSeconds?: number; status?: string } = {}) {
  useAuth.setState({
    status: 'authed',
    user: { _id: 'me', username: 'me', name: 'Me', status: opts.status ?? 'online' },
    error: null,
  });
  usePrefs.setState({
    prefs: {
      ...usePrefs.getState().prefs,
      enableAutoAway: opts.enabled ?? true,
      idleTimeLimit: opts.idleSeconds ?? 60,
    },
  });
  statuses = [];
}

function start(target: EventTarget): void {
  rest.setStatus = (async (status: string) => {
    statuses.push(status);
  }) as typeof rest.setStatus;
  dispose = startAutoAway(target);
}

/** 计时器回调是 async 的：把 microtask 队列放干再断言 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function activity(target: EventTarget): void {
  target.dispatchEvent(new Event('mousemove'));
}

test.afterEach(() => {
  dispose?.();
  dispose = null;
  rest.setStatus = originalSetStatus;
  useAuth.setState({ status: 'guest', user: null, error: null });
});

test('超时无活动自动置 away，本地状态同步', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => t.mock.timers.reset());
  setup({ idleSeconds: 60 });
  const target = new EventTarget();
  start(target);

  t.mock.timers.tick(59_000);
  await flush();
  assert.deepEqual(statuses, []);

  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(statuses, ['away']);
  assert.equal(useAuth.getState().user?.status, 'away');
});

test('自动 away 后第一次活动恢复 online，之后重新计时', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => t.mock.timers.reset());
  setup({ idleSeconds: 60 });
  const target = new EventTarget();
  start(target);

  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(statuses, ['away']);

  activity(target);
  await flush();
  assert.deepEqual(statuses, ['away', 'online']);
  assert.equal(useAuth.getState().user?.status, 'online');

  // 恢复后计时器重新生效：再无活动 60s 又置 away
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(statuses, ['away', 'online', 'away']);
});

test('开关关闭时不计时、不置 away', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => t.mock.timers.reset());
  setup({ enabled: false, idleSeconds: 60 });
  const target = new EventTarget();
  start(target);

  t.mock.timers.tick(300_000);
  await flush();
  assert.deepEqual(statuses, []);
});

test('计时中途关闭开关：立刻停表', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => t.mock.timers.reset());
  setup({ idleSeconds: 60 });
  const target = new EventTarget();
  start(target);

  t.mock.timers.tick(30_000);
  usePrefs.setState({ prefs: { ...usePrefs.getState().prefs, enableAutoAway: false } });
  t.mock.timers.tick(300_000);
  await flush();
  assert.deepEqual(statuses, []);
});

test('手动 busy 状态不动（只在 online 时才自动置 away）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => t.mock.timers.reset());
  setup({ status: 'busy', idleSeconds: 60 });
  const target = new EventTarget();
  start(target);

  t.mock.timers.tick(300_000);
  await flush();
  assert.deepEqual(statuses, []);
  assert.equal(useAuth.getState().user?.status, 'busy');
});

test('自动 away 期间手动改了状态：活动不再恢复', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => t.mock.timers.reset());
  setup({ idleSeconds: 60 });
  const target = new EventTarget();
  start(target);

  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(statuses, ['away']);

  // 用户在设置页手动切到 busy（applyStatus 会刷新 auth store）
  useAuth.setState({ user: { ...useAuth.getState().user!, status: 'busy' } });
  activity(target);
  await flush();
  assert.deepEqual(statuses, ['away'], '不应再发恢复 online 的请求');
  assert.equal(useAuth.getState().user?.status, 'busy');
});

test('idleTimeLimit 修改实时生效；低于下限按 30s 钳制', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => t.mock.timers.reset());
  setup({ idleSeconds: 120 });
  const target = new EventTarget();
  start(target);

  // 改小：立刻按新值重新计时
  usePrefs.setState({ prefs: { ...usePrefs.getState().prefs, idleTimeLimit: 45 } });
  t.mock.timers.tick(44_000);
  await flush();
  assert.deepEqual(statuses, []);
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(statuses, ['away']);
  dispose?.();
  dispose = null;

  // 钳制：设 5s 也按 30s 走
  setup({ idleSeconds: 5 });
  const target2 = new EventTarget();
  start(target2);
  t.mock.timers.tick(29_000);
  await flush();
  assert.deepEqual(statuses, []);
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(statuses, ['away']);
});

test('清理函数移除监听器和计时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => t.mock.timers.reset());
  setup({ idleSeconds: 60 });
  const target = new EventTarget();
  start(target);
  dispose?.();
  dispose = null;

  activity(target);
  t.mock.timers.tick(300_000);
  await flush();
  assert.deepEqual(statuses, []);
});
