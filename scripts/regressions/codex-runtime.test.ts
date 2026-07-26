import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexBrainAvailability,
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  type ButlerBrainStorage,
} from '../../apps/web/src/lib/butlerBrain';
import {
  getCodexManualPath,
  resetCodexRuntimeForTests,
  setCodexRuntimeInvoker,
  setCodexRuntimePlatform,
  setCodexRuntimeStorage,
  setCodexManualPath,
  useCodexRuntime,
  type CodexRuntimeProbe,
} from '../../apps/web/src/stores/codexRuntime';
import { useToast } from '../../apps/web/src/stores/toast';

class MemoryStorage implements ButlerBrainStorage {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

test('桌面启动时 Codex 可用则就绪；不可用时只提示一次原因，绝不静默换大脑', async () => {
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restorePlatform = setCodexRuntimePlatform(() => true);
  const restoreBrainPlatform = setButlerBrainTauriProvider(() => true);
  const runtimeStorage = new MemoryStorage();
  const restoreRuntimeStorage = setCodexRuntimeStorage(runtimeStorage);
  setCodexManualPath(' C:\\Tools\\codex.exe ');
  assert.equal(getCodexManualPath(), 'C:\\Tools\\codex.exe');
  let result: CodexRuntimeProbe = {
    ready: true,
    version: '0.145.0',
    executablePath: 'C:\\Tools\\codex.exe',
    source: 'manual',
  };
  let invokedArgs: Record<string, unknown> | undefined;
  const restoreInvoker = setCodexRuntimeInvoker(async (_command, args) => {
    invokedArgs = args;
    return result as never;
  });
  useToast.setState({ toasts: [] });
  resetCodexRuntimeForTests();

  try {
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'ready');
    assert.equal(useCodexRuntime.getState().source, 'manual');
    assert.deepEqual(invokedArgs, { manualPath: 'C:\\Tools\\codex.exe' });
    assert.deepEqual(codexBrainAvailability(), { available: true });
    assert.equal(useToast.getState().toasts.length, 0);

    result = { ready: false, reasonCode: 'not-logged-in', reason: 'Codex 尚未登录' };
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'unavailable');
    assert.equal(useCodexRuntime.getState().reasonCode, 'not-logged-in');
    // 决策 13：不可用就是不可用，原因透传给 UI，没有备胎大脑
    assert.deepEqual(codexBrainAvailability(), { available: false, reason: 'Codex 尚未登录' });
    assert.equal(useToast.getState().toasts.length, 1);
    assert.match(useToast.getState().toasts[0]?.message ?? '', /Codex 尚未登录/);

    await useCodexRuntime.getState().probe();
    assert.equal(useToast.getState().toasts.length, 1);
  } finally {
    resetCodexRuntimeForTests();
    useToast.setState({ toasts: [] });
    restoreInvoker();
    restoreBrainPlatform();
    restorePlatform();
    restoreRuntimeStorage();
    restoreStorage();
  }
});
