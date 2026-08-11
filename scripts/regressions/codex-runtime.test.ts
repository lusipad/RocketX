import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCodexDiagnosticSummary,
  getCodexManualPath,
  resetCodexRuntimeForTests,
  setCodexManualPath,
  setCodexRuntimeDiagnosticWriter,
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
    candidates: [{
      source: 'manual',
      path: 'C:\\Tools\\codex.exe',
      version: '0.144.4',
      outcome: 'selected',
    }],
  };
  let invokedArgs: Record<string, unknown> | undefined;
  const diagnostics: Array<{ level: string; area: string; message: string }> = [];
  const restoreInvoker = setCodexRuntimeInvoker(async (_command, args) => {
    invokedArgs = args;
    return result as never;
  });
  const restoreDiagnosticWriter = setCodexRuntimeDiagnosticWriter(async (level, area, message) => {
    diagnostics.push({ level, area, message });
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
    assert.deepEqual(useCodexRuntime.getState().candidates, [{
      source: 'manual',
      path: 'C:\\Tools\\codex.exe',
      version: '0.144.4',
      outcome: 'selected',
    }]);
    assert.deepEqual(invokedArgs, { manualPath: 'C:\\Tools\\codex.exe' });
    assert.equal(useToast.getState().toasts.length, 0);
    assert.deepEqual(diagnostics, [{
      level: 'info',
      area: 'codex-runtime',
      message: 'candidate source=manual outcome=selected path=C:\\Tools\\codex.exe version=0.144.4',
    }]);

    result = {
      ready: true,
      version: '0.145.0',
      executablePath: 'C:\\Tools\\codex.exe',
      source: 'manual',
      protocolBaseline: '0.144.4',
      minimumCandidate: '0.140.0',
      verifiedVersions: ['0.144.4'],
      compatibilityStatus: 'untested-newer',
      candidates: [{
        source: 'manual',
        path: 'C:\\Tools\\codex.exe',
        version: '0.145.0',
        outcome: 'selected',
      }],
    };
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'ready');
    assert.equal(useCodexRuntime.getState().compatibilityStatus, 'untested-newer');
    assert.equal(useToast.getState().toasts.length, 0);

    result = {
      ready: true,
      version: '0.144.4',
      executablePath: 'C:\\Users\\alice\\AppData\\Local\\Programs\\Codex\\codex.exe',
      source: 'system',
      protocolBaseline: '0.144.4',
      minimumCandidate: '0.140.0',
      verifiedVersions: ['0.144.4'],
      compatibilityStatus: 'verified',
      candidates: [
        {
          source: 'system',
          path: 'C:\\Program Files\\Codex\\codex.exe',
          version: '0.144.1',
          outcome: 'rejected',
          reasonCode: 'outdated',
        },
        {
          source: 'system',
          path: 'C:\\Users\\alice\\AppData\\Local\\Programs\\Codex\\codex.exe',
          version: '0.144.4',
          outcome: 'selected',
        },
      ],
    };
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'ready');
    assert.equal(useToast.getState().toasts.length, 0);
    assert.equal(useCodexRuntime.getState().candidates.length, 2);
    assert.equal(diagnostics.at(-2)?.level, 'warn');
    assert.equal(diagnostics.at(-2)?.message.includes('reason=outdated'), true);

    result = {
      ready: false,
      version: '0.144.1',
      executablePath: 'C:\\Users\\alice\\AppData\\Local\\Programs\\Codex\\codex.exe',
      source: 'manual',
      protocolBaseline: '0.144.4',
      minimumCandidate: '0.140.0',
      verifiedVersions: ['0.144.4'],
      compatibilityStatus: 'blocked',
      reasonCode: 'manual-path',
      reason: '手动指定的 Codex 不可用：找到 Codex 0.144.1，但低于 RocketX 所需的协议基线 0.144.4；请升级后重新检测 token=manual-secret',
      candidates: [{
        source: 'manual',
        path: 'C:\\Users\\alice\\AppData\\Local\\Programs\\Codex\\codex.exe',
        version: '0.144.1',
        outcome: 'rejected',
        reasonCode: 'outdated',
      }],
    };
    await useCodexRuntime.getState().probe();
    assert.equal(useCodexRuntime.getState().phase, 'unavailable');
    assert.equal(useCodexRuntime.getState().compatibilityStatus, 'blocked');
    assert.equal(useCodexRuntime.getState().reasonCode, 'manual-path');
    assert.equal(useToast.getState().toasts.length, 1);
    assert.match(useToast.getState().toasts[0]?.message ?? '', /手动指定的 Codex 不可用/);

    const summary = buildCodexDiagnosticSummary(useCodexRuntime.getState());
    assert.match(summary, /protocolBaseline: 0\.144\.4/);
    assert.match(summary, /candidate\[0\]: source=manual outcome=rejected/);
    assert.equal(summary.includes('alice'), false);
    assert.equal(summary.includes('manual-secret'), false);
    assert.equal(summary.includes('0.140.0'), false);

    await useCodexRuntime.getState().probe();
    assert.equal(useToast.getState().toasts.length, 1);
  } finally {
    resetCodexRuntimeForTests();
    useToast.setState({ toasts: [] });
    restoreDiagnosticWriter();
    restoreInvoker();
    restoreRuntimeStorage();
    restorePlatform();
  }
});
