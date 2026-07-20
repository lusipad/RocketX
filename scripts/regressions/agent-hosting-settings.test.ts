import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getAgentHostingCodexSettings,
  setAgentHostingCodexSettings,
  setAgentHostingSettingsStorage,
} from '../../apps/web/src/lib/agentHostingSettings';
import {
  getButlerCodexSettings,
  setButlerBrainStorage,
  setButlerCodexSettings,
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

function withStorage(run: (storage: MemoryStorage) => void): void {
  const storage = new MemoryStorage();
  const restoreButler = setButlerBrainStorage(storage);
  const restoreHosting = setAgentHostingSettingsStorage(storage);
  try {
    run(storage);
  } finally {
    restoreHosting();
    restoreButler();
  }
}

test('新安装的 AI 托管默认使用 high，管家仍保持 medium', () => {
  withStorage((storage) => {
    assert.deepEqual(getButlerCodexSettings(), { model: '', effort: 'medium' });
    assert.deepEqual(getAgentHostingCodexSettings(), { model: '', effort: 'high' });
    assert.equal(storage.get('rcx-agent-hosting-v1:codex-model'), '');
    assert.equal(storage.get('rcx-agent-hosting-v1:codex-effort'), 'high');
  });
});

test('设置页分别呈现管家和 AI 托管的模型与推理强度', () => {
  const source = readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');
  assert.match(source, /label="管家 Codex 模型"/);
  assert.match(source, /label="管家推理强度"/);
  assert.match(source, /label="AI 托管 Codex 模型"/);
  assert.match(source, /label="AI 托管推理强度"/);
});

test('升级时仅首次复制已有管家配置，之后两套设置互不影响', () => {
  withStorage(() => {
    setButlerCodexSettings({ model: 'gpt-5.4', effort: 'xhigh' });
    assert.deepEqual(getAgentHostingCodexSettings(), { model: 'gpt-5.4', effort: 'xhigh' });

    setButlerCodexSettings({ model: 'gpt-5.4-mini', effort: 'low' });
    assert.deepEqual(getAgentHostingCodexSettings(), { model: 'gpt-5.4', effort: 'xhigh' });
  });
});

test('AI 托管设置独立持久化，并安全回退非法推理强度', () => {
  withStorage((storage) => {
    setAgentHostingCodexSettings({ model: ' gpt-5.4 ', effort: 'ultra' });
    assert.deepEqual(getAgentHostingCodexSettings(), { model: 'gpt-5.4', effort: 'ultra' });

    storage.set('rcx-agent-hosting-v1:codex-effort', 'unsupported');
    assert.deepEqual(getAgentHostingCodexSettings(), { model: 'gpt-5.4', effort: 'high' });
  });
});
