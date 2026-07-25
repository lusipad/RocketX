import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexBrainAvailability,
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  type ButlerBrainStorage,
} from '../../apps/web/src/lib/butlerBrain';
import {
  resetCodexRuntimeForTests,
  setCodexRuntimeInvoker,
  setCodexRuntimePlatform,
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
  let result: CodexRuntimeProbe = {
    ready: true,
    version: 'codex-cli 1.2.3',
    executablePath: 'C:\\Codex\\codex.exe',
    source: 'bundled',
  };
  const restoreInvoker = setCodexRuntimeInvoker(async () => result as never);
  useToast.setState({ toasts: [] });
  resetCodexRuntimeForTests();

  try {
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'ready');
    assert.equal(useCodexRuntime.getState().source, 'bundled');
    assert.deepEqual(codexBrainAvailability(), { available: true });
    assert.equal(useToast.getState().toasts.length, 0);

    result = { ready: false, reason: 'Codex 尚未登录' };
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'unavailable');
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
    restoreStorage();
  }
});
