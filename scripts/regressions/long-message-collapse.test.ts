import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLongMessage,
  longMessageCharLimit,
  longMessageLineLimit,
} from '../../apps/web/src/lib/longMessage';
import { usePrefs } from '../../apps/web/src/stores/prefs';

// 以 1080p 窗口为基准：半屏 540px ÷ 23px/行 ≈ 23 行，约 920 字符
const VIEWPORT = 1080;
const LINE_LIMIT = longMessageLineLimit(VIEWPORT);
const CHAR_LIMIT = longMessageCharLimit(VIEWPORT);

test('半屏折算（默认）：1080p 约 23 行 / 920 字符，屏幕越大阈值越宽松', () => {
  assert.equal(LINE_LIMIT, 23);
  assert.equal(CHAR_LIMIT, 920);
  assert.ok(longMessageLineLimit(1440) > LINE_LIMIT);
  assert.ok(longMessageLineLimit(900) < LINE_LIMIT);
});

test('折叠时机可调：一屏、两屏按比例放宽阈值', () => {
  assert.equal(longMessageLineLimit(VIEWPORT, 'one'), 46);
  assert.equal(longMessageLineLimit(VIEWPORT, 'two'), 93);
  // 同一条消息在半屏下折叠、在两屏下不折叠
  const text = Array(30).fill('行').join('\n');
  assert.equal(isLongMessage(text, VIEWPORT, 'half'), true);
  assert.equal(isLongMessage(text, VIEWPORT, 'two'), false);
});

test('小窗口有下限：再小也不低于 8 行，避免误折叠普通消息', () => {
  assert.equal(longMessageLineLimit(300), 8);
});

test('字符数阈值：恰好不超过不算长，超过算长', () => {
  assert.equal(isLongMessage('字'.repeat(CHAR_LIMIT), VIEWPORT), false);
  assert.equal(isLongMessage('字'.repeat(CHAR_LIMIT + 1), VIEWPORT), true);
});

test('行数阈值：不超过不算长，超过算长', () => {
  assert.equal(isLongMessage(Array(LINE_LIMIT).fill('行').join('\n'), VIEWPORT), false);
  assert.equal(isLongMessage(Array(LINE_LIMIT + 1).fill('行').join('\n'), VIEWPORT), true);
});

test('短消息（无换行）不触发折叠', () => {
  assert.equal(isLongMessage('在吗？', VIEWPORT), false);
  assert.equal(isLongMessage('', VIEWPORT), false);
});

test('消息偏好默认值与自定义键都能随账号同步', async () => {
  assert.equal(usePrefs.getState().prefs.rcxCollapseLongMessages, true);
  assert.equal(usePrefs.getState().prefs.rcxLongMessageFoldAt, 'half');
  assert.equal(usePrefs.getState().prefs.rcxAutoFormatMixedLanguage, true);
  // 键必须在 RcPreferences 上，否则 savePreferences 类型层就存不进去
  const types = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../../packages/rc-client/src/types.ts', import.meta.url), 'utf8'),
  );
  assert.match(types, /rcxCollapseLongMessages\?: boolean/);
  assert.match(types, /rcxLongMessageFoldAt\?: 'half' \| 'one' \| 'two'/);
  assert.match(types, /rcxAutoFormatMixedLanguage\?: boolean/);
});
