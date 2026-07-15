import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrayFlasher, hasTrayAttention } from '../../apps/web/src/lib/tray';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('普通频道只有 alert 时也触发托盘提醒，但免打扰会话不触发', () => {
  assert.equal(hasTrayAttention({ channel: { unread: 0, alert: true } }), true);
  assert.equal(
    hasTrayAttention({ muted: { unread: 3, alert: true, disableNotifications: true } }),
    false,
  );
  assert.equal(hasTrayAttention({ read: { unread: 0, alert: false } }), false);
});

test('初始未闪烁时 stop 仍强制写入正常图标', async () => {
  const frames: boolean[] = [];
  const flasher = createTrayFlasher(async (normal) => {
    frames.push(normal);
  });

  await flasher.stop();

  assert.deepEqual(frames, [true]);
});

test('常规无未读更新保持幂等，不重复写入原生托盘', async () => {
  const frames: boolean[] = [];
  const flasher = createTrayFlasher(async (normal) => {
    frames.push(normal);
  });

  await flasher.setFlashing(false);
  await flasher.setFlashing(false);

  assert.deepEqual(frames, []);
});

test('托盘闪烁会交替图标，并在未读清零后恢复正常图标', async () => {
  let tick: (() => void) | undefined;
  const cleared: number[] = [];
  const frames: boolean[] = [];
  const flasher = createTrayFlasher(
    async (normal) => {
      frames.push(normal);
    },
    (callback) => {
      tick = callback;
      return 7;
    },
    (timer) => cleared.push(timer),
  );

  await flasher.setFlashing(true);
  tick?.();
  await Promise.resolve();
  tick?.();
  await flasher.stop();

  assert.deepEqual(frames, [false, true]);
  assert.deepEqual(cleared, [7]);
});

test('停止闪烁后，较慢的旧帧不能让托盘最终保持透明', async () => {
  const enteredTransparentFrame = deferred();
  const finishTransparentFrame = deferred();
  let tick: (() => void) | undefined;
  const frames: boolean[] = [];
  const flasher = createTrayFlasher(
    async (normal) => {
      if (!normal) {
        enteredTransparentFrame.resolve();
        await finishTransparentFrame.promise;
      }
      frames.push(normal);
    },
    (callback) => {
      tick = callback;
      return 9;
    },
    () => {},
  );

  await flasher.setFlashing(true);
  tick?.();
  await enteredTransparentFrame.promise;
  const stopped = flasher.stop();
  finishTransparentFrame.resolve();
  await stopped;

  assert.deepEqual(frames, [false, true]);
});

test('卸载清理恰逢透明帧时，托盘最终仍恢复正常图标', async () => {
  const enteredTransparentFrame = deferred();
  const finishTransparentFrame = deferred();
  let tick: (() => void) | undefined;
  const frames: boolean[] = [];
  const flasher = createTrayFlasher(
    async (normal) => {
      if (!normal) {
        enteredTransparentFrame.resolve();
        await finishTransparentFrame.promise;
      }
      frames.push(normal);
    },
    (callback) => {
      tick = callback;
      return 11;
    },
    () => {},
  );

  await flasher.setFlashing(true);
  tick?.();
  await enteredTransparentFrame.promise;
  const cleanup = () => void flasher.stop();
  cleanup();
  finishTransparentFrame.resolve();
  // cleanup 本身不能 await；再次 stop 会排入强制 normal 帧，供测试等待原生队列落定。
  await flasher.stop();

  assert.deepEqual(frames, [false, true]);
});
