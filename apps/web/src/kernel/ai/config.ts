import type { AiCapability, AiProviderLocality, AiRoute } from './provider';
import { isTauri } from '../../lib/http';

/**
 * 管家大脑二选一（决策 11）：显式开关、不静默回退。
 * codex = 桌面主路径（本机 codex app-server），api = AiBus Agent 循环（Web / 内网）。
 * 独立于 AiSettings 存储，避免搅动 provider 校验链。
 */
export type ButlerBrain = 'codex' | 'api';

const BUTLER_BRAIN_KEY = 'rcx-butler-brain-v1';

export function defaultButlerBrain(): ButlerBrain {
  return isTauri ? 'codex' : 'api';
}

export function getButlerBrain(): ButlerBrain {
  try {
    const raw = localStorage.getItem(BUTLER_BRAIN_KEY);
    if (raw === 'codex' || raw === 'api') return raw;
  } catch {
    // localStorage 不可用时按平台默认
  }
  return defaultButlerBrain();
}

/** Codex 大脑在当前环境不可用时的统一文案（不静默回退，指引用户显式切换）。 */
export const CODEX_BRAIN_UNAVAILABLE_MESSAGE =
  '当前大脑设置为 Codex，但此环境不可用。请在 设置 → AI 管家 中切换为 API 大脑。';

export function setButlerBrain(brain: ButlerBrain): void {
  localStorage.setItem(BUTLER_BRAIN_KEY, brain);
  window.dispatchEvent(new CustomEvent('rcx-butler-brain-changed'));
}

export interface AiProviderConfig {
  id: string;
  kind: 'openai-compatible' | 'anthropic' | 'azure-openai';
  name: string;
  baseUrl: string;
  model: string;
  embeddingModel?: string;
  locality: AiProviderLocality;
  hasSecret: boolean;
}

export interface AiSettings {
  providers: AiProviderConfig[];
  routes: Record<AiCapability, AiRoute>;
}

export const AI_CAPABILITIES: Array<{ id: AiCapability; label: string }> = [
  { id: 'summary', label: '会话总结' },
  { id: 'extraction', label: '待办 / 工作项提取' },
  { id: 'daily-review', label: '晨报 / 晚间回顾' },
  { id: 'semantic-search', label: '语义搜索' },
  { id: 'text-tool', label: '翻译 / 润色' },
  { id: 'agent', label: 'Agent' },
];

const STORAGE_KEY = 'rcx-ai-settings-v1';

export function defaultAiSettings(): AiSettings {
  const routes = Object.fromEntries(
    AI_CAPABILITIES.map(({ id }) => [id, { providerId: 'deepseek', localOnly: false }]),
  ) as Record<AiCapability, AiRoute>;
  return {
    providers: [
      {
        id: 'deepseek',
        kind: 'openai-compatible',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        locality: 'external',
        hasSecret: false,
      },
    ],
    routes,
  };
}

function validProvider(value: unknown): value is AiProviderConfig {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Partial<AiProviderConfig>;
  return (
    typeof provider.id === 'string' &&
    !!provider.id &&
    ['openai-compatible', 'anthropic', 'azure-openai'].includes(provider.kind ?? '') &&
    typeof provider.name === 'string' &&
    !!provider.name.trim() &&
    typeof provider.baseUrl === 'string' &&
    !!provider.baseUrl.trim() &&
    typeof provider.model === 'string' &&
    !!provider.model.trim() &&
    ['local', 'external'].includes(provider.locality ?? '') &&
    typeof provider.hasSecret === 'boolean'
  );
}

export function validateAiSettings(settings: AiSettings): AiSettings {
  if (!settings.providers.length) throw new Error('至少需要一个 AI Provider');
  const ids = new Set<string>();
  for (const provider of settings.providers) {
    if (!validProvider(provider)) throw new Error('AI Provider 配置无效');
    if (ids.has(provider.id)) throw new Error(`AI Provider ID 重复: ${provider.id}`);
    ids.add(provider.id);
    const url = new URL(provider.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${provider.name} 的地址必须是无凭据的 http/https URL`);
    }
  }
  for (const { id } of AI_CAPABILITIES) {
    const route = settings.routes[id];
    if (!route || !ids.has(route.providerId)) throw new Error(`${id} 的 Provider 路由无效`);
  }
  return settings;
}

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultAiSettings();
    return validateAiSettings(JSON.parse(raw) as AiSettings);
  } catch {
    return defaultAiSettings();
  }
}

export function saveAiSettings(settings: AiSettings): void {
  const valid = validateAiSettings(settings);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(valid));
  window.dispatchEvent(new CustomEvent('rcx-ai-settings-changed'));
}
