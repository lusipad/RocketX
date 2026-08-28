import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_LAN_FILE_MIN_BYTES,
  LAN_FILE_MIN_BYTES_OPTIONS,
  normalizeLanFileMinBytes,
  shouldTryLanFileTransfer,
} from '../../apps/web/src/lan/routing';

test('默认阈值为 50 MiB', () => {
  assert.equal(DEFAULT_LAN_FILE_MIN_BYTES, 50 * 1024 * 1024);
});

test('达到阈值才尝试 P2P 直传', () => {
  const min = DEFAULT_LAN_FILE_MIN_BYTES;
  assert.equal(shouldTryLanFileTransfer(min - 1, min), false);
  assert.equal(shouldTryLanFileTransfer(min, min), true);
  assert.equal(shouldTryLanFileTransfer(min * 4, min), true);
});

test('阈值为 0 时任何大小都尝试直传', () => {
  assert.equal(shouldTryLanFileTransfer(0, 0), true);
  assert.equal(shouldTryLanFileTransfer(1, 0), true);
});

test('非法阈值回退默认，合法值向下取整', () => {
  assert.equal(normalizeLanFileMinBytes(undefined), DEFAULT_LAN_FILE_MIN_BYTES);
  assert.equal(normalizeLanFileMinBytes('50'), DEFAULT_LAN_FILE_MIN_BYTES);
  assert.equal(normalizeLanFileMinBytes(-1), DEFAULT_LAN_FILE_MIN_BYTES);
  assert.equal(normalizeLanFileMinBytes(Number.NaN), DEFAULT_LAN_FILE_MIN_BYTES);
  assert.equal(normalizeLanFileMinBytes(Number.POSITIVE_INFINITY), DEFAULT_LAN_FILE_MIN_BYTES);
  assert.equal(normalizeLanFileMinBytes(0), 0);
  assert.equal(normalizeLanFileMinBytes(1024.9), 1024);
});

test('设置页档位包含默认阈值且 0 表示任何文件', () => {
  assert.ok(LAN_FILE_MIN_BYTES_OPTIONS.some((option) => option.value === 0));
  assert.ok(
    LAN_FILE_MIN_BYTES_OPTIONS.some((option) => option.value === DEFAULT_LAN_FILE_MIN_BYTES),
  );
  for (const option of LAN_FILE_MIN_BYTES_OPTIONS) {
    assert.equal(normalizeLanFileMinBytes(option.value), option.value);
  }
});

test('普通原生文件上传不再自动走 LAN（结构锁定）', () => {
  const chat = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  // 阈值判断只出现在「在线优先选路」分支，兜底分支直接 tryLanSend()
  assert.match(chat, /await uploadDesktopFile\(path, rid,/);
  assert.doesNotMatch(chat, /shouldTryLanFileTransfer/);
  assert.doesNotMatch(chat, /tryLanSend/);
});
