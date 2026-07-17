import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldExpandRun } from '../../apps/web/src/lib/butlerReport';

const at = (day: number, hour: number, minute: number) => new Date(2026, 6, day, hour, minute).getTime();

test('当天成功的管家报告默认展开', () => {
  assert.equal(shouldExpandRun({ at: at(18, 8, 30), status: 'ok' }, at(18, 12, 0)), true);
});

test('昨天成功的管家报告默认收起', () => {
  assert.equal(shouldExpandRun({ at: at(17, 23, 59), status: 'ok' }, at(18, 0, 1)), false);
});

test('当天失败的管家报告默认收起', () => {
  assert.equal(shouldExpandRun({ at: at(18, 8, 30), status: 'error' }, at(18, 12, 0)), false);
});

test('没有管家报告时默认收起', () => {
  assert.equal(shouldExpandRun(undefined, at(18, 12, 0)), false);
});

test('跨午夜边界不会误判为当天报告', () => {
  assert.equal(shouldExpandRun({ at: at(17, 23, 59), status: 'ok' }, at(18, 0, 0)), false);
  assert.equal(shouldExpandRun({ at: at(18, 0, 0), status: 'ok' }, at(18, 0, 0)), true);
});
