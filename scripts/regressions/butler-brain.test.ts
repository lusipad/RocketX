import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexBrainAvailability,
  getButlerBrain,
  setButlerBrain,
  setButlerBrainStorage,
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

test('管家大脑按平台给默认值，并持久化显式选择', () => {
  const storage = new MemoryStorage();
  const restoreStorage = setButlerBrainStorage(storage);
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  setCodexBrainUnavailableReason(undefined);

  try {
    assert.equal(getButlerBrain(), 'codex');
    setButlerBrain('api');
    assert.equal(storage.get('rcx-butler-v1:brain'), 'api');
    assert.equal(getButlerBrain(), 'api');
  } finally {
    restorePlatform();
    restoreStorage();
  }
});

test('网页端默认 API，并明确说明 Codex 不可用原因', () => {
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restorePlatform = setButlerBrainTauriProvider(() => false);
  setCodexBrainUnavailableReason(undefined);

  try {
    assert.equal(getButlerBrain(), 'api');
    assert.deepEqual(codexBrainAvailability(), {
      available: false,
      reason: 'Codex 大脑仅桌面端可用',
    });
  } finally {
    restorePlatform();
    restoreStorage();
  }
});

test('桌面端会透传后续 Codex 检测失败原因', () => {
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  try {
    setCodexBrainUnavailableReason('Codex 大脑不可用：请先登录 Codex。');
    assert.deepEqual(codexBrainAvailability(), {
      available: false,
      reason: 'Codex 大脑不可用：请先登录 Codex。',
    });
  } finally {
    setCodexBrainUnavailableReason(undefined);
    restorePlatform();
  }
});
