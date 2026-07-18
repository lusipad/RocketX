import test from 'node:test';
import assert from 'node:assert/strict';
import { shortcutKeyOf } from '../../apps/web/src/lib/shortcutKey';

test('中文输入法把组合键报成 Process 时按物理键位识别（issue #63）', () => {
  // 焦点在输入框、微软拼音激活：Ctrl+Shift+F 的 e.key 是 'Process'
  assert.equal(shortcutKeyOf({ key: 'Process', code: 'KeyF' }), 'f');
  assert.equal(shortcutKeyOf({ key: 'Process', code: 'KeyK' }), 'k');
  assert.equal(shortcutKeyOf({ key: 'Process', code: 'Digit1' }), '1');
});

test('e.key 正常时优先使用 e.key，不受键盘布局影响', () => {
  assert.equal(shortcutKeyOf({ key: 'F', code: 'KeyF' }), 'f');
  assert.equal(shortcutKeyOf({ key: 'k', code: 'KeyK' }), 'k');
  // Dvorak：物理 KeyF 位置打出的是 u，应该按 u 算
  assert.equal(shortcutKeyOf({ key: 'u', code: 'KeyF' }), 'u');
  assert.equal(shortcutKeyOf({ key: 'ArrowDown', code: 'ArrowDown' }), 'arrowdown');
  assert.equal(shortcutKeyOf({ key: 'Escape', code: 'Escape' }), 'escape');
});

test('Process 且无法还原物理键位时保持原值，不误触发', () => {
  assert.equal(shortcutKeyOf({ key: 'Process', code: 'Space' }), 'process');
  assert.equal(shortcutKeyOf({ key: 'Process', code: '' }), 'process');
});
