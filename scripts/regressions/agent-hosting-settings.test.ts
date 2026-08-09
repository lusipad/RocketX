import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  AGENT_HOSTING_CODEX_EFFORTS,
  AGENT_HOSTING_PERMISSION_PRESETS,
  getAgentHostingCodexSettings,
  setAgentHostingCodexSettings,
  setAgentHostingSettingsStorage,
  type AgentHostingSettingsStorage,
} from '../../apps/web/src/lib/agentHostingSettings';

class MemoryStorage implements AgentHostingSettingsStorage {
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
  const restore = setAgentHostingSettingsStorage(storage);
  try {
    run(storage);
  } finally {
    restore();
  }
}

test('AI 托管 Codex 设置独立持久化，默认 high 与替我审批，非法值回退默认档', () => {
  withStorage((storage) => {
    assert.deepEqual(AGENT_HOSTING_CODEX_EFFORTS, [
      'default',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    assert.deepEqual(AGENT_HOSTING_PERMISSION_PRESETS, ['ask', 'auto', 'full']);
    assert.deepEqual(getAgentHostingCodexSettings(), {
      model: '',
      effort: 'high',
      permissionPreset: 'auto',
    });

    setAgentHostingCodexSettings({ model: ' gpt-5.4 ', effort: 'ultra', permissionPreset: 'full' });
    assert.deepEqual(getAgentHostingCodexSettings(), {
      model: 'gpt-5.4',
      effort: 'ultra',
      permissionPreset: 'full',
    });
    assert.equal(storage.get('rcx-agent-hosting-v1:codex-model'), 'gpt-5.4');
    assert.equal(storage.get('rcx-agent-hosting-v1:codex-effort'), 'ultra');
    assert.equal(storage.get('rcx-agent-hosting-v1:codex-permission'), 'full');

    storage.set('rcx-agent-hosting-v1:codex-effort', 'unsupported');
    storage.set('rcx-agent-hosting-v1:codex-permission', 'unsupported');
    assert.deepEqual(getAgentHostingCodexSettings(), {
      model: 'gpt-5.4',
      effort: 'high',
      permissionPreset: 'auto',
    });
  });
});

test('设置页只暴露独立 AI 托管配置，不再迁移或展示旧管家模型配置', () => {
  const source = readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');
  assert.match(source, /label="AI 托管 Codex 模型"/);
  assert.match(source, /label="AI 托管 Codex 推理强度"/);
  assert.match(source, /label="AI 托管 Codex 权限"/);
  assert.doesNotMatch(source, /label="管家 Codex 模型"/);
  assert.doesNotMatch(source, /label="管家推理强度"/);
  assert.doesNotMatch(source, /getButlerCodexSettings|setButlerCodexSettings|setButlerBrainStorage/);
});
