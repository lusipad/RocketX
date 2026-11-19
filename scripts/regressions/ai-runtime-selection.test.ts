import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getAiRuntimeStartupResolution,
  initializeStartupAiRuntimeProvider,
} from '../../apps/web/src/lib/aiRuntimeBootstrap';
import {
  AI_RUNTIME_PROVIDER_STORAGE_KEY,
  PI_MIGRATED_STORAGE_KEY,
  activateAiRuntimeProvider,
  getAiRuntimeProvider,
  normalizeAiRuntimeProvider,
  persistAiRuntimeProvider,
  persistRuntimeMode,
  readAiRuntimeProvider,
  readConfiguredAiRuntimeProvider,
  resetAiRuntimeProviderForTests,
  resetRuntimeModeForTests,
  runtimeFeatures,
  selectStartupAiRuntimeProvider,
  type RuntimeModeStorage,
} from '../../apps/web/src/lib/runtimeMode';

function memoryStorage(initial: Record<string, string> = {}): RuntimeModeStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

test('AI 运行时只收敛为 Pi 与无 AI，历史 Codex/DeepSeek 配置自动迁移为 Pi', () => {
  assert.equal(normalizeAiRuntimeProvider('pi'), 'pi');
  assert.equal(normalizeAiRuntimeProvider('none'), 'none');
  assert.equal(normalizeAiRuntimeProvider('codex'), 'pi');
  assert.equal(normalizeAiRuntimeProvider('deepseek'), 'pi');
  assert.equal(normalizeAiRuntimeProvider('unknown'), 'pi');

  const empty = memoryStorage();
  assert.equal(readConfiguredAiRuntimeProvider(empty), undefined);
  assert.equal(readAiRuntimeProvider(empty), 'pi');

  const legacyCodex = memoryStorage({ [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'codex' });
  assert.equal(readConfiguredAiRuntimeProvider(legacyCodex), 'pi');
  assert.equal(readAiRuntimeProvider(legacyCodex), 'pi');

  const legacyDsh = memoryStorage({ [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'deepseek' });
  assert.equal(readConfiguredAiRuntimeProvider(legacyDsh), 'pi');
  assert.equal(readAiRuntimeProvider(legacyDsh), 'pi');

  const disabled = memoryStorage({ [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'none' });
  assert.equal(readConfiguredAiRuntimeProvider(disabled), 'none');
  assert.equal(readAiRuntimeProvider(disabled), 'none');
});

test('启动 AI 运行时只在未禁用时选择 Pi 并按真实就绪状态决定启用或安全降级', () => {
  assert.equal(selectStartupAiRuntimeProvider(undefined, { pi: true }), 'pi');
  assert.equal(selectStartupAiRuntimeProvider(undefined, { pi: false }), 'none');
  assert.equal(selectStartupAiRuntimeProvider('pi', { pi: true }), 'pi');
  assert.equal(selectStartupAiRuntimeProvider('pi', { pi: false }), 'none');
  assert.equal(selectStartupAiRuntimeProvider('none', { pi: true }), 'none');
  assert.equal(selectStartupAiRuntimeProvider('none', { pi: false }), 'none');
});

test('桌面首次启动与历史配置仅探测 pi_runtime_probe，就绪时启用 Pi，不可用时不静默切换别家运行时', async () => {
  const previous = getAiRuntimeProvider();
  try {
    resetRuntimeModeForTests();
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const freshStorage = memoryStorage();
    const freshSelected = await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage: freshStorage,
      invokeRuntime: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ command, args });
        return { ready: true } as T;
      },
    });
    assert.equal(freshSelected, 'pi');
    assert.deepEqual(calls, [{ command: 'pi_runtime_probe', args: { manualPath: null } }]);
    assert.equal(freshStorage.getItem(AI_RUNTIME_PROVIDER_STORAGE_KEY), null);
    assert.equal(getAiRuntimeStartupResolution().source, 'automatic');

    const legacyStorage = memoryStorage({ [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'deepseek' });
    const unavailable = await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage: legacyStorage,
      invokeRuntime: async <T>(command: string): Promise<T> => {
        calls.push({ command });
        return { ready: false, reason: 'Pi Sidecar 尚未初始化' } as T;
      },
    });
    assert.equal(unavailable, 'none');
    assert.equal(legacyStorage.getItem(AI_RUNTIME_PROVIDER_STORAGE_KEY), 'deepseek');
    assert.deepEqual(getAiRuntimeStartupResolution(), {
      active: 'none',
      configured: 'pi',
      profile: 'unknown',
      reason: 'Pi Sidecar 尚未初始化',
      source: 'explicit-unavailable',
    });
  } finally {
    resetRuntimeModeForTests();
    resetAiRuntimeProviderForTests(previous);
  }
});

test('web 进程与显式无 AI 都不执行 Pi 探活，且保留下次桌面启动偏好', async () => {
  const previous = getAiRuntimeProvider();
  try {
    resetRuntimeModeForTests();
    const storage = memoryStorage({ [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'pi' });
    let invoked = 0;

    const webSelected = await initializeStartupAiRuntimeProvider({
      desktop: false,
      storage,
      invokeRuntime: async () => {
        invoked += 1;
        return { ready: true } as never;
      },
    });
    assert.equal(webSelected, 'none');
    assert.equal(invoked, 0);
    assert.equal(storage.getItem(AI_RUNTIME_PROVIDER_STORAGE_KEY), 'pi');
    assert.equal(getAiRuntimeStartupResolution().source, 'web');

    const disabledStorage = memoryStorage({ [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'none' });
    const disabledSelected = await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage: disabledStorage,
      invokeRuntime: async () => {
        invoked += 1;
        return { ready: true } as never;
      },
    });
    assert.equal(disabledSelected, 'none');
    assert.equal(invoked, 0);
    assert.equal(getAiRuntimeStartupResolution().source, 'explicit');

    persistRuntimeMode('performance', memoryStorage());
    const perfSelected = await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage,
      invokeRuntime: async () => {
        invoked += 1;
        return { ready: true } as never;
      },
    });
    assert.equal(perfSelected, 'none');
    assert.equal(invoked, 0);
    assert.equal(getAiRuntimeStartupResolution().source, 'mode-disabled');
  } finally {
    resetRuntimeModeForTests();
    resetAiRuntimeProviderForTests(previous);
  }
});

test('启动探测不阻塞首屏，在内核初始化前完成，且修改设置只持久化下次启动选择', () => {
  const previous = getAiRuntimeProvider();
  try {
    resetRuntimeModeForTests();
    const storage = memoryStorage({ [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'pi' });
    activateAiRuntimeProvider('pi');

    const persisted = persistAiRuntimeProvider('none', storage);
    assert.equal(persisted, 'none');
    assert.equal(storage.getItem(AI_RUNTIME_PROVIDER_STORAGE_KEY), 'none');
    assert.equal(storage.getItem(PI_MIGRATED_STORAGE_KEY), '1');
    assert.equal(getAiRuntimeProvider(), 'pi');

    const piFeatures = runtimeFeatures('standard', 'pi');
    assert.equal(piFeatures.ai, true);
    assert.equal(piFeatures.butler, true);
    assert.equal(piFeatures.ocr, true);
    assert.equal(piFeatures.routines, true);
    assert.equal(piFeatures.runtimeProbes, true);
    assert.equal(piFeatures.sharedAgent, true);

    const disabledFeatures = runtimeFeatures('standard', 'none');
    assert.equal(disabledFeatures.ai, false);
    assert.equal(disabledFeatures.butler, true);
    assert.equal(disabledFeatures.ocr, false);
    assert.equal(disabledFeatures.routines, false);
    assert.equal(disabledFeatures.runtimeProbes, false);
    assert.equal(disabledFeatures.sharedAgent, true);
  } finally {
    resetRuntimeModeForTests();
    resetAiRuntimeProviderForTests(previous);
  }

  const bootstrap = readFileSync('apps/web/src/main.tsx', 'utf8');
  const settings = readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');
  const waitRuntime = bootstrap.indexOf('await runtimeProviderReady;');
  const bootKernel = bootstrap.indexOf('await initializeKernel(');
  const selection = bootstrap.indexOf('initializeStartupAiRuntimeProvider({');
  const rootRender = bootstrap.indexOf('ReactDOM.createRoot(');

  assert.ok(waitRuntime >= 0 && bootKernel > waitRuntime);
  assert.ok(selection >= 0 && rootRender > selection);
  assert.doesNotMatch(settings, /setAiRuntimeProvider/);
  assert.match(settings, /const selectAiRuntime = \(provider: AiRuntimeProvider\): void => \{\s*setSelectedAiRuntime\(persistAiRuntimeProvider\(provider\)\);\s*\}/);
  assert.match(settings, /Pi（内建通用引擎）/);
  assert.match(settings, /无 AI/);
});
