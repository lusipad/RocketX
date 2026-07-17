import type { RcxStore } from '@rcx/rcx-store';
import { ensureHttpOrigin, httpFetch } from '../../lib/http';
import { AiBus } from './bus';
import { loadAiSettings, type AiProviderConfig } from './config';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { AnthropicProvider } from './anthropic';
import { getAiSecret } from './secrets';
import type { AiChatRequest, AiProvider } from './provider';

let bus: AiBus | undefined;
let store: RcxStore | undefined;

const aiFetch: typeof fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : input.toString();
  await ensureHttpOrigin(rawUrl);
  return httpFetch(input, init);
};

function createProvider(config: AiProviderConfig): AiProvider {
  if (config.kind === 'anthropic') {
    return new AnthropicProvider({
      id: config.id,
      baseUrl: config.baseUrl,
      model: config.model,
      locality: config.locality,
      getApiKey: () => getAiSecret(config.id),
      fetch: aiFetch,
    });
  }
  return new OpenAiCompatibleProvider({
    id: config.id,
    baseUrl: config.baseUrl,
    model: config.model,
    locality: config.locality,
    embeddingModel: config.embeddingModel,
    getApiKey: () => getAiSecret(config.id),
    apiKeyHeader: config.kind === 'azure-openai' ? 'api-key' : 'authorization',
    fetch: aiFetch,
  });
}

export function reloadAiRuntime(): AiBus {
  if (!store) throw new Error('AI 运行时尚未初始化');
  const next = new AiBus((entry) => store?.audit.append(entry).then(() => {}));
  const settings = loadAiSettings();
  for (const provider of settings.providers) next.register(createProvider(provider));
  for (const [capability, route] of Object.entries(settings.routes)) {
    next.setRoute(capability as keyof typeof settings.routes, route);
  }
  bus = next;
  return next;
}

export function initializeAiRuntime(rcxStore: RcxStore): void {
  store = rcxStore;
  reloadAiRuntime();
  window.addEventListener('rcx-ai-settings-changed', reloadAiRuntime);
}

export function getAiBus(): AiBus {
  if (!bus) throw new Error('AI 运行时尚未初始化');
  return bus;
}

export async function testAiProvider(providerId: string): Promise<string> {
  const request: AiChatRequest = {
    messages: [
      { role: 'system', content: '你是连接测试。只回复 OK。' },
      { role: 'user', content: '请回复 OK。' },
    ],
    thinking: 'disabled',
    maxTokens: 16,
  };
  let content = '';
  for await (const chunk of getAiBus().chatProvider(providerId, 'summary', request, false)) {
    content += chunk.content ?? '';
  }
  if (!content.trim()) throw new Error('Provider 返回了空内容');
  return content.trim();
}
