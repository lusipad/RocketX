import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestBadgeSetter } from '../../apps/web/src/lib/taskbar';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Regression: ISSUE-010 — 较慢的旧徽标生成会覆盖已经完成的清零请求
// Found by /qa on 2026-07-15
// Report: .gstack/qa-reports/qa-report-localhost-5173-2026-07-15.md
test('较慢的旧角标不能覆盖已经完成的清零请求', async () => {
  const slowBadge = deferred();
  const applied: number[] = [];
  const setBadge = createLatestBadgeSetter(async (count, isCurrent) => {
    if (count > 0) await slowBadge.promise;
    if (isCurrent()) applied.push(count);
  });

  const oldRequest = setBadge(5);
  const latestRequest = setBadge(0);
  slowBadge.resolve();
  await Promise.all([oldRequest, latestRequest]);

  assert.deepEqual(applied, [0]);
});

// Regression: ISSUE-010 — 旧原生调用开始后仍可能晚于新调用完成
// Found by /qa on 2026-07-15
// Report: .gstack/qa-reports/qa-report-localhost-5173-2026-07-15.md
test('已经开始的旧原生调用完成后，最新角标仍必须最后落地', async () => {
  const enteredNativeCall = deferred();
  const finishOldNativeCall = deferred();
  const applied: number[] = [];
  const setBadge = createLatestBadgeSetter(async (count, isCurrent) => {
    if (!isCurrent()) return;
    if (count === 5) {
      enteredNativeCall.resolve();
      await finishOldNativeCall.promise;
    }
    applied.push(count);
  });

  const oldRequest = setBadge(5);
  await enteredNativeCall.promise;
  const latestRequest = setBadge(0);
  await Promise.resolve();
  finishOldNativeCall.resolve();
  await Promise.all([oldRequest, latestRequest]);

  assert.deepEqual(applied, [5, 0]);
});
