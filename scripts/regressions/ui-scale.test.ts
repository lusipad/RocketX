import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { UI_SCALE_OPTIONS, normalizeUiScale, stepUiScale } from '../../apps/web/src/lib/uiScale';

const storage = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

let useUiPrefs: typeof import('../../apps/web/src/stores/uiPrefs').useUiPrefs;

test.before(async () => {
  ({ useUiPrefs } = await import('../../apps/web/src/stores/uiPrefs'));
});

test.afterEach(() => {
  storage.clear();
  useUiPrefs.setState({
    hoverDelayMs: 2000,
    taskbarFlash: true,
    uiScale: 100,
  });
});

test('界面缩放只允许 issue #135 约定的六档', () => {
  assert.deepEqual(UI_SCALE_OPTIONS, [80, 90, 100, 110, 125, 150]);
  assert.equal(normalizeUiScale(80), 80);
  assert.equal(normalizeUiScale(125), 125);
  assert.equal(normalizeUiScale(95), 100);
  assert.equal(normalizeUiScale('110'), 100);
  assert.equal(normalizeUiScale(undefined), 100);
});

test('缩放步进按固定档位前后移动，并在边界钳住', () => {
  assert.equal(stepUiScale(100, 'in'), 110);
  assert.equal(stepUiScale(110, 'out'), 100);
  assert.equal(stepUiScale(150, 'in'), 150);
  assert.equal(stepUiScale(80, 'out'), 80);
  assert.equal(stepUiScale(95, 'in'), 110);
  assert.equal(stepUiScale(95, 'out'), 90);
});

test('保存 uiScale 时保留其他本机偏好，不回写非法档位', () => {
  storage.set('rcx-ui-prefs', JSON.stringify({
    hoverDelayMs: 500,
    taskbarFlash: false,
    uiScale: 95,
  }));

  useUiPrefs.getState().setUiScale(125);

  assert.deepEqual(JSON.parse(storage.get('rcx-ui-prefs') ?? '{}'), {
    hoverDelayMs: 500,
    taskbarFlash: false,
    uiScale: 125,
  });
  assert.equal(useUiPrefs.getState().uiScale, 125);
});

test('桌面缩放使用 Tauri 原生 WebView 权限，不回退 CSS transform', () => {
  const nativeSource = readFileSync('apps/web/src/lib/desktopUiScale.ts', 'utf8');
  const capability = JSON.parse(
    readFileSync('apps/desktop/src-tauri/capabilities/default.json', 'utf8'),
  ) as { permissions: string[] };

  assert.match(nativeSource, /getCurrentWebview\(\)\.setZoom\(scale \/ 100\)/);
  assert.doesNotMatch(nativeSource, /transform|devicePixelRatio/);
  assert.ok(capability.permissions.includes('core:webview:allow-set-webview-zoom'));
});
