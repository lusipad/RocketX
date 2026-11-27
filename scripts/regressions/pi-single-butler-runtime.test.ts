import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';
import {
  AI_RUNTIME_PROVIDER_STORAGE_KEY,
  readAiRuntimeProvider,
  readConfiguredAiRuntimeProvider,
  type RuntimeModeStorage,
} from '../../apps/web/src/lib/runtimeMode';

function memoryStorage(initial: Record<string, string> = {}): RuntimeModeStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

test('已移除独立 DSH / Codex 管家运行时模块与陈旧测试文件', () => {
  const retiredPaths = [
    'apps/web/src/components/DshConversation.tsx',
    'apps/web/src/components/DshQuestionCard.tsx',
    'apps/web/src/stores/privateRoomDsh.ts',
    'apps/web/src/stores/codexRuntime.ts',
    'apps/web/src/agent/dsh',
  ];
  for (const target of retiredPaths) {
    assert.equal(existsSync(target), false, `${target} 应该已被删除`);
  }
});

test('旧版 persisted codex 与 deepseek 偏好在单 Pi 架构下透明迁移为 pi', () => {
  const codexStorage = memoryStorage({ [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'codex' });
  const deepseekStorage = memoryStorage({ [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'deepseek' });

  assert.equal(readConfiguredAiRuntimeProvider(codexStorage), 'pi');
  assert.equal(readAiRuntimeProvider(codexStorage), 'pi');
  assert.equal(readConfiguredAiRuntimeProvider(deepseekStorage), 'pi');
  assert.equal(readAiRuntimeProvider(deepseekStorage), 'pi');
});

test('AiSettings 只保留 Pi 引擎、无 AI 选项与 ACP 客户端管理，不再暴露旧版 Codex/DSH 配置块', () => {
  const settings = readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');

  assert.match(settings, /label: t\('settings\.ai\.runtimePiOptionLabel'\)/);
  assert.equal(zhCN['settings.ai.runtimePiOptionLabel'], 'Pi（内建通用引擎）');
  assert.ok(enUS['settings.ai.runtimePiOptionLabel'].length > 0);
  assert.match(settings, /label: t\('settings\.ai\.runtimeNoneName'\)/);
  assert.equal(zhCN['settings.ai.runtimeNoneName'], '无 AI');
  assert.ok(enUS['settings.ai.runtimeNoneName'].length > 0);
  assert.match(settings, /<AcpClientsSettingsSection \/>/);
  assert.doesNotMatch(settings, /手动 Codex 路径|打开 DSH 配置|useCodexRuntime/);
  assert.equal(Object.values(zhCN).some((value) => /手动 Codex 路径|打开 DSH 配置/.test(value)), false);
});

test('AgentPanel 收敛到 Pi 托管与历史 DeepSeek 只读展示', () => {
  const agentPanel = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');

  assert.match(agentPanel, /const selectedBackend: AgentBackend \| null = configuredProvider === 'pi' \? 'codex' : null;/);
  assert.match(agentPanel, /backend === 'deepseek' \? rawT\('agent\.panel\.backendDeepseek'\) : 'Pi'/);
  assert.equal(zhCN['agent.panel.backendDeepseek'], 'DeepSeek (历史)');
  assert.ok(enUS['agent.panel.backendDeepseek'].length > 0);
  assert.doesNotMatch(agentPanel, /DshQuestionCard|prepareSharedDshStartConfiguration|dshQuestions/);
});
