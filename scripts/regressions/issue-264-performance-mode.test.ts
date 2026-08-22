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
  assert.match(main, /if \(runtimeFeatures\(\)\.bootKernel\)\s*await initializeKernel\(undefined, signal\);/);
  assert.match(main, /ReactDOM\.createRoot/);
  const render = main.indexOf('ReactDOM.createRoot');
  const warmup = main.lastIndexOf('scheduleStartupWarmups();');
  assert.ok(render >= 0 && warmup > render, '拼音预热必须移到首屏 render 之后');
});

test('首屏渲染后才在浏览器空闲阶段预加载拼音字典', () => {
  const main = source('apps/web/src/main.tsx');
  assert.match(main, /function scheduleStartupWarmups\(\)[\s\S]*preloadPinyin\(\)/);
  assert.match(main, /const schedule = \(\) => window\.setTimeout\(run, 1_200\)/);
  assert.match(main, /requestAnimationFrame\(\(\) => \{[\s\S]*requestIdleCallback\(schedule/);
  assert.match(main, /window\.requestIdleCallback\(schedule, \{ timeout: 2_000 \}\)/);
  assert.match(main, /schedule\(\);/);
});

test('非首屏页面和房间面板不进入 kernel 的静态依赖图', () => {
  const runtime = source('apps/web/src/kernel/runtime.tsx');
  const surfaces = [
    ['ContactsPage', '../pages/ContactsPage'],
    ['TodosPage', '../pages/TodosPage'],
    ['CalendarPage', '../pages/CalendarPage'],
    ['WorkbenchPage', '../pages/WorkbenchPage'],
    ['SettingsPage', '../pages/SettingsPage'],
    ['DownloadsPage', '../pages/DownloadsPage'],
    ['ThreadPanel', '../components/ThreadPanel'],
    ['PinPanel', '../components/PinPanel'],
    ['StarredPanel', '../components/StarredPanel'],
    ['MembersPanel', '../components/MembersPanel'],
    ['SearchPanel', '../components/SearchPanel'],
    ['RoomInfoPanel', '../components/RoomInfoPanel'],
    ['FilesPanel', '../components/FilesPanel'],
    ['MentionsPanel', '../components/MentionsPanel'],
  ] as const;

  for (const [name, path] of surfaces) {
    assert.doesNotMatch(runtime, new RegExp(`import ${name} from ['\"]${path}['\"]`));
    assert.match(
      runtime,
      new RegExp(`const ${name} = lazyComponent\\(\\(\\) => import\\(['\"]${path}['\"]\\)\\)`),
    );
  }
});

test('performance 模式不启动旧 polling bridge，仍屏蔽 AI 相关入口与副作用', () => {
  const runtime = source('apps/web/src/kernel/runtime.tsx');
  const main = source('apps/web/src/main.tsx');
  const app = source('apps/web/src/App.tsx');
  const mainPage = source('apps/web/src/pages/MainPage.tsx');
  const chatArea = source('apps/web/src/components/ChatArea.tsx');
  const quickSwitcher = source('apps/web/src/components/QuickSwitcher.tsx');
  const settings = source('apps/web/src/pages/SettingsPage.tsx');
  const lightbox = source('apps/web/src/components/ImageLightbox.tsx');

  assert.match(runtime, /if \((?:features|runtimeFeatures\(\))\.ai\)/);
  assert.match(runtime, /if \((?:features|runtimeFeatures\(\))\.sharedAgent\)/);
  assert.match(runtime, /if \((?:features|runtimeFeatures\(\))\.routines\)/);
  assert.match(runtime, /activeKernelHost\.background\.startRoutines\(\)/);
  assert.doesNotMatch(runtime, /ButlerPollerBridge|startButlerPoller|poller bridge/i);
  assert.doesNotMatch(app, /ButlerPollerBridge/);
  assert.match(main, /runtimeFeatures\(\)\.runtimeProbes/);
  assert.doesNotMatch(mainPage, /runtimeFeatures|useCodexRuntime|\.probe\(/);
  assert.match(chatArea, /(?:features|runtimeFeatures\(\))\.butler/);
  assert.match(quickSwitcher, /runtimeFeatures\(\)\.butler/);
  assert.match(settings, /getRuntimeMode\(\) !== 'performance'/);
  assert.match(settings, /SECTIONS\.filter\([\s\S]*?\),\s*\[aiSettingsVisible\]/);
  assert.match(lightbox, /runtimeFeatures\(\)\.ocr/);
});
