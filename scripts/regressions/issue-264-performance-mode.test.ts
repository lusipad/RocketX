import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  normalizeRuntimeMode,
  readRuntimeMode,
  runtimeFeatures,
} from '../../apps/web/src/lib/runtimeMode';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

function memoryStorage(seed?: string): { getItem: (key: string) => string | null; setItem: () => void } {
  const values = new Map<string, string>();
  if (seed) values.set('rcx-runtime-mode-v1', seed);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: () => {},
  };
}

test('运行模式默认 standard，performance 会一次性关掉 AI/管家/OCR/轮询探测', () => {
  assert.equal(normalizeRuntimeMode(undefined), 'standard');
  assert.equal(normalizeRuntimeMode('performance'), 'performance');
  assert.equal(normalizeRuntimeMode('PERFORMANCE'), 'performance');
  assert.equal(normalizeRuntimeMode('invalid'), 'standard');

  const standard = runtimeFeatures('standard');
  const performance = runtimeFeatures('performance');

  assert.equal(standard.ai, true);
  assert.equal(standard.bootKernel, true);
  assert.equal(standard.reducedMotion, false);

  assert.equal(performance.ai, false);
  assert.equal(performance.butler, false);
  assert.equal(performance.sharedAgent, false);
  assert.equal(performance.polling, false);
  assert.equal(performance.routines, false);
  assert.equal(performance.runtimeProbes, false);
  assert.equal(performance.ocr, false);
  assert.equal(performance.reducedMotion, true);
});

test('运行模式可由 query 覆盖 localStorage，缺省回退 standard', () => {
  const location = { search: '?rcx-mode=performance' } as Pick<Location, 'search'>;
  assert.equal(readRuntimeMode(memoryStorage('standard'), location), 'performance');
  assert.equal(readRuntimeMode(memoryStorage('performance'), { search: '' }), 'performance');
  assert.equal(readRuntimeMode(memoryStorage('bad'), { search: '' }), 'standard');
  assert.equal(readRuntimeMode(undefined, undefined), 'standard');
});

test('启动前先应用运行模式，再按模式决定是否初始化 kernel', () => {
  const main = source('apps/web/src/main.tsx');
  assert.match(main, /applyRuntimeModeDocumentState\(\)/);
  assert.match(main, /if \(runtimeFeatures\(\)\.bootKernel\) \{\s*await initializeKernel\(\);?\s*\}/);
  assert.match(main, /ReactDOM\.createRoot/);
});

test('performance 模式不启动旧 polling bridge，仍屏蔽 AI 相关入口与副作用', () => {
  const runtime = source('apps/web/src/kernel/runtime.tsx');
  const app = source('apps/web/src/App.tsx');
  const mainPage = source('apps/web/src/pages/MainPage.tsx');
  const chatArea = source('apps/web/src/components/ChatArea.tsx');
  const quickSwitcher = source('apps/web/src/components/QuickSwitcher.tsx');
  const settings = source('apps/web/src/pages/SettingsPage.tsx');
  const lightbox = source('apps/web/src/components/ImageLightbox.tsx');

  assert.match(runtime, /if \((?:features|runtimeFeatures\(\))\.ai\)/);
  assert.match(runtime, /if \((?:features|runtimeFeatures\(\))\.sharedAgent\)/);
  assert.match(runtime, /if \((?:features|runtimeFeatures\(\))\.routines\)/);
  assert.match(runtime, /startRoutineScheduler\(\)/);
  assert.doesNotMatch(runtime, /ButlerPollerBridge|startButlerPoller|poller bridge/i);
  assert.doesNotMatch(app, /ButlerPollerBridge/);
  assert.match(mainPage, /runtimeFeatures\(\)\.runtimeProbes/);
  assert.match(chatArea, /(?:features|runtimeFeatures\(\))\.butler/);
  assert.match(quickSwitcher, /runtimeFeatures\(\)\.butler/);
  assert.match(settings, /runtimeFeatures\(\)\.ai/);
  assert.match(lightbox, /runtimeFeatures\(\)\.ocr/);
});
