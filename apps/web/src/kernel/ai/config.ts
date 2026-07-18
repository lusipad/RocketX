import type { AiCapability, AiProviderLocality, AiRoute } from './provider';

export interface AiProviderConfig {
  id: string;
  kind: 'openai-compatible' | 'anthropic' | 'azure-openai';
  name: string;
  baseUrl: string;
  model: string;
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
