import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexBrainAvailability,
  getButlerCodexSettings,
  setButlerBrainStorage,
  setButlerCodexSettings,
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
  type ButlerBrainStorage,
} from '../../apps/web/src/lib/butlerBrain';

class MemoryStorage implements ButlerBrainStorage {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

test('Codex 模型和推理强度可配置，非法存储值安全回退', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setButlerBrainStorage(storage);
  try {
    assert.deepEqual(getButlerCodexSettings(), { model: '', effort: 'medium' });
    setButlerCodexSettings({ model: ' gpt-5.4 ', effort: 'high' });
    assert.deepEqual(getButlerCodexSettings(), { model: 'gpt-5.4', effort: 'high' });
    assert.equal(storage.get('rcx-butler-v1:codex-model'), 'gpt-5.4');
    assert.equal(storage.get('rcx-butler-v1:codex-effort'), 'high');

    storage.set('rcx-butler-v1:codex-effort', 'unsupported');
    assert.deepEqual(getButlerCodexSettings(), { model: 'gpt-5.4', effort: 'medium' });
  } finally {
    restoreStorage();
  }
});

test('网页端明说管家在桌面端，而不是留一个残缺的对话框', () => {
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restorePlatform = setButlerBrainTauriProvider(() => false);
  setCodexBrainUnavailableReason(undefined);

  try {
    const availability = codexBrainAvailability();
    assert.equal(availability.available, false);
    assert.match(availability.reason ?? '', /桌面端/);
  } finally {
    restorePlatform();
    restoreStorage();
  }
});

test('桌面端会透传后续 Codex 检测失败原因', () => {
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  try {
    setCodexBrainUnavailableReason('Codex 不可用：请先登录 Codex。');
    assert.deepEqual(codexBrainAvailability(), {
      available: false,
      reason: 'Codex 不可用：请先登录 Codex。',
    });
  } finally {
    setCodexBrainUnavailableReason(undefined);
    restorePlatform();
  }
});
