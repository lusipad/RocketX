import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UI_LOCALE_STORAGE_KEY,
  containsHan,
  detectSystemUiLocale,
  localizeDynamicText,
  readUiLocalePreference,
  resolveUiLocale,
  saveUiLocalePreference,
  tr,
} from '../../apps/web/src/lib/uiLocale';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
    removeItem(key: string): void {
      map.delete(key);
    },
  };
}

test('system locale detection picks zh only for Chinese language tags and defaults to en otherwise', () => {
  assert.equal(detectSystemUiLocale(['zh-CN'], 'zh-CN'), 'zh');
  assert.equal(detectSystemUiLocale(['zh-TW']), 'zh');
  assert.equal(detectSystemUiLocale(['zh_HK']), 'zh');
  assert.equal(detectSystemUiLocale(['zh']), 'zh');
  assert.equal(detectSystemUiLocale(['en-US'], 'en-US'), 'en');
  assert.equal(detectSystemUiLocale(['C']), 'en');
  assert.equal(detectSystemUiLocale(['C.UTF-8']), 'en');
  assert.equal(detectSystemUiLocale(['POSIX']), 'en');
  assert.equal(detectSystemUiLocale(['fr-FR']), 'en');
  assert.equal(detectSystemUiLocale([], ''), 'en');
  // Without a DOM, implicit detection remains deterministic for pure/Node tests.
  assert.equal(detectSystemUiLocale(), 'zh');
});

test('explicit locale preference overrides auto detection and persists safely', () => {
  const storage = memoryStorage();
  assert.equal(readUiLocalePreference(storage), 'auto');
  assert.equal(resolveUiLocale(storage), 'zh');

  saveUiLocalePreference('en', storage);
  assert.equal(readUiLocalePreference(storage), 'en');
  assert.equal(resolveUiLocale(storage), 'en');
  assert.equal(storage.getItem(UI_LOCALE_STORAGE_KEY), 'en');

  saveUiLocalePreference('zh', storage);
  assert.equal(readUiLocalePreference(storage), 'zh');
  assert.equal(resolveUiLocale(storage), 'zh');

  saveUiLocalePreference('auto', storage);
  assert.equal(readUiLocalePreference(storage), 'auto');
  assert.equal(storage.getItem(UI_LOCALE_STORAGE_KEY), null);
});

test('tr and localizeDynamicText return Chinese vs English copy cleanly', () => {
  assert.equal(tr('管家', 'Butler', 'en'), 'Butler');
  assert.equal(tr('管家', 'Butler', 'zh'), '管家');

  assert.equal(containsHan('未连接服务器'), true);
  assert.equal(containsHan('Model provider configured'), false);

  assert.equal(localizeDynamicText('未配置模型', 'Model setup pending', 'en'), 'Model setup pending');
  assert.equal(localizeDynamicText('Model setup pending', 'Fallback', 'en'), 'Model setup pending');
  assert.equal(localizeDynamicText('', 'Fallback', 'en'), 'Fallback');
  assert.equal(localizeDynamicText('', 'Fallback', 'zh'), '');
  assert.equal(localizeDynamicText('未配置模型', 'Fallback', 'zh'), '未配置模型');
});
