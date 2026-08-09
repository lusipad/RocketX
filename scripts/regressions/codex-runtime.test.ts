import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCodexManualPath,
  resetCodexRuntimeForTests,
  setCodexManualPath,
  setCodexRuntimeInvoker,
  setCodexRuntimePlatform,
  setCodexRuntimeStorage,
  useCodexRuntime,
  type CodexRuntimeProbe,
  type CodexRuntimeStorage,
} from '../../apps/web/src/stores/codexRuntime';
import { useToast } from '../../apps/web/src/stores/toast';

class MemoryStorage implements CodexRuntimeStorage {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

test('桌面启动时 Codex probe 只保留路径/版本门禁，不再耦合旧 Butler 大脑', async () => {
  const runtimeStorage = new MemoryStorage();
  const restorePlatform = setCodexRuntimePlatform(() => true);
  const restoreRuntimeStorage = setCodexRuntimeStorage(runtimeStorage);
  setCodexManualPath(' C:\\Tools\\codex.exe ');
  assert.equal(getCodexManualPath(), 'C:\\Tools\\codex.exe');

  let result: CodexRuntimeProbe = {
    ready: true,
    version: '0.144.4',
    executablePath: 'C:\\Tools\\codex.exe',
    source: 'manual',
    protocolBaseline: '0.144.4',
    minimumCandidate: '0.140.0',
    verifiedVersions: ['0.144.4'],
    compatibilityStatus: 'verified',
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
    assert.equal(useCodexRuntime.getState().compatibilityStatus, 'verified');
    assert.equal(useCodexRuntime.getState().protocolBaseline, '0.144.4');
    assert.equal(useCodexRuntime.getState().minimumCandidate, '0.140.0');
    assert.deepEqual(useCodexRuntime.getState().verifiedVersions, ['0.144.4']);
    assert.deepEqual(invokedArgs, { manualPath: 'C:\\Tools\\codex.exe' });
    assert.equal(useToast.getState().toasts.length, 0);

    result = {
      ready: true,
      version: '0.145.0',
      executablePath: 'C:\\Tools\\codex.exe',
      source: 'manual',
      protocolBaseline: '0.144.4',
      minimumCandidate: '0.140.0',
      verifiedVersions: ['0.144.4'],
      compatibilityStatus: 'untested-newer',
    };
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'ready');
    assert.equal(useCodexRuntime.getState().compatibilityStatus, 'untested-newer');
    assert.equal(useToast.getState().toasts.length, 0);

    result = {
      ready: false,
      version: '0.140.0',
      protocolBaseline: '0.144.4',
      minimumCandidate: '0.140.0',
      verifiedVersions: ['0.144.4'],
      compatibilityStatus: 'blocked',
      reasonCode: 'outdated',
      reason: 'Codex 0.140.0 尚未通过 RocketX 兼容认证',
    };
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'unavailable');
    assert.equal(useCodexRuntime.getState().compatibilityStatus, 'blocked');
    assert.equal(useCodexRuntime.getState().reasonCode, 'outdated');
    assert.equal(
      useCodexRuntime.getState().reason,
      'Codex 0.140.0 尚未通过 RocketX 兼容认证',
    );
    assert.equal(useToast.getState().toasts.length, 1);
    assert.match(useToast.getState().toasts[0]?.message ?? '', /尚未通过 RocketX 兼容认证/);

    await useCodexRuntime.getState().probe();
    assert.equal(useToast.getState().toasts.length, 1);
  } finally {
    resetCodexRuntimeForTests();
    useToast.setState({ toasts: [] });
    restoreInvoker();
    restoreRuntimeStorage();
    restorePlatform();
  }
});
