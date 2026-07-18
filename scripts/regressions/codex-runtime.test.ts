import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getButlerBrain,
  setButlerBrainStorage,
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

test('桌面启动时 Codex 可用则启用，不可用则只提示一次并回退普通 AI', async () => {
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restorePlatform = setCodexRuntimePlatform(() => true);
  let result: CodexRuntimeProbe = {
    ready: true,
    version: 'codex-cli 1.2.3',
    executablePath: 'C:\\Codex\\codex.exe',
  };
  const restoreInvoker = setCodexRuntimeInvoker(async () => result as never);
  useToast.setState({ toasts: [] });
  resetCodexRuntimeForTests();

  try {
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'ready');
    assert.equal(getButlerBrain(), 'codex');
    assert.equal(useToast.getState().toasts.length, 0);

    result = { ready: false, reason: 'Codex 尚未登录' };
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'fallback');
    assert.equal(getButlerBrain(), 'api');
    assert.equal(useToast.getState().toasts.length, 1);
    assert.match(useToast.getState().toasts[0]?.message ?? '', /已切换到普通 AI/);

    await useCodexRuntime.getState().probe();
    assert.equal(useToast.getState().toasts.length, 1);
  } finally {
    resetCodexRuntimeForTests();
    useToast.setState({ toasts: [] });
    restoreInvoker();
    restorePlatform();
    restoreStorage();
  }
});
