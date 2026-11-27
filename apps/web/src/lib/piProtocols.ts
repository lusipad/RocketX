import type { MessageKey } from '../i18n';
import type { PiApiProtocol } from '../platform/desktopCommands';

export interface PiProtocolOptionMeta {
  id: PiApiProtocol;
  labelKey: MessageKey;
  shortLabel: string;
  descKey: MessageKey;
  primary?: boolean;
}

export const PI_API_PROTOCOL_OPTIONS: readonly PiProtocolOptionMeta[] = [
  {
    id: 'auto',
    labelKey: 'settings.ai.protocol.auto.label',
    shortLabel: 'Auto',
    descKey: 'settings.ai.protocol.auto.desc',
    primary: true,
  },
  {
    id: 'openai-responses',
    labelKey: 'settings.ai.protocol.openaiResponses.label',
    shortLabel: 'Responses',
    descKey: 'settings.ai.protocol.openaiResponses.desc',
    primary: true,
  },
  {
    id: 'openai-completions',
    labelKey: 'settings.ai.protocol.openaiCompletions.label',
    shortLabel: 'Chat Completions',
    descKey: 'settings.ai.protocol.openaiCompletions.desc',
    primary: true,
  },
  {
    id: 'anthropic-messages',
    labelKey: 'settings.ai.protocol.anthropicMessages.label',
    shortLabel: 'Anthropic',
    descKey: 'settings.ai.protocol.anthropicMessages.desc',
    primary: true,
  },
  {
    id: 'google-generative-ai',
    labelKey: 'settings.ai.protocol.googleGemini.label',
    shortLabel: 'Gemini',
    descKey: 'settings.ai.protocol.googleGemini.desc',
    primary: true,
  },
  {
    id: 'azure-openai-responses',
    labelKey: 'settings.ai.protocol.azureResponses.label',
    shortLabel: 'Azure',
    descKey: 'settings.ai.protocol.azureResponses.desc',
    primary: true,
  },
  {
    id: 'mistral-conversations',
    labelKey: 'settings.ai.protocol.mistral.label',
    shortLabel: 'Mistral',
    descKey: 'settings.ai.protocol.mistral.desc',
    primary: false,
  },
  {
    id: 'bedrock-converse-stream',
    labelKey: 'settings.ai.protocol.bedrock.label',
    shortLabel: 'Bedrock',
    descKey: 'settings.ai.protocol.bedrock.desc',
    primary: false,
  },
] as const;

export function inferProtocolHintFromInput(
  baseUrl: string,
  apiKey: string,
): { protocol: PiApiProtocol; reason: 'url' | 'key' | 'default' } {
  const lowerUrl = baseUrl.trim().toLowerCase();
  const trimmedKey = apiKey.trim();

  if (
    lowerUrl.includes('.openai.azure.com')
    || lowerUrl.includes('.cognitiveservices.azure.com')
    || lowerUrl.includes('.ai.azure.com')
  ) {
    return { protocol: 'azure-openai-responses', reason: 'url' };
  }
  if (/\/responses\/?$/i.test(lowerUrl) || lowerUrl.includes('api.openai.com')) {
    return { protocol: 'openai-responses', reason: 'url' };
  }
  if (/\/chat\/completions\/?$/i.test(lowerUrl)) {
    return { protocol: 'openai-completions', reason: 'url' };
  }
  if (
    lowerUrl.includes('api.anthropic.com')
    || /\/v1\/messages\/?$/i.test(lowerUrl)
    || /\/messages\/?$/i.test(lowerUrl)
  ) {
    return { protocol: 'anthropic-messages', reason: 'url' };
  }
  if (lowerUrl.includes('generativelanguage.googleapis.com')) {
    return lowerUrl.includes('/openai')
      ? { protocol: 'openai-completions', reason: 'url' }
      : { protocol: 'google-generative-ai', reason: 'url' };
  }
  if (lowerUrl.includes('api.mistral.ai')) {
    return { protocol: 'mistral-conversations', reason: 'url' };
  }
  if (trimmedKey.startsWith('sk-ant-')) {
    return { protocol: 'anthropic-messages', reason: 'key' };
  }
  if (trimmedKey.startsWith('AIza')) {
    return { protocol: 'google-generative-ai', reason: 'key' };
  }
  if (lowerUrl.includes(':3425')) {
    return { protocol: 'openai-responses', reason: 'url' };
  }
  return { protocol: 'auto', reason: 'default' };
}

export function mergeDiscoveredModels(
  currentDefault: string,
  currentExtra: string,
  discovered: string[],
  suggested?: string | null,
): { defaultModel: string; extraModels: string } {
  const cleanDiscovered = Array.from(
    new Set(discovered.map((m) => m.trim()).filter(Boolean)),
  );
  if (cleanDiscovered.length === 0) {
    return {
      defaultModel: currentDefault.trim(),
      extraModels: currentExtra.trim(),
    };
  }
  const cleanCurrent = currentDefault.trim();
  const nextDefault = cleanCurrent && cleanDiscovered.includes(cleanCurrent)
    ? cleanCurrent
    : (suggested?.trim() && cleanDiscovered.includes(suggested.trim())
      ? suggested.trim()
      : cleanDiscovered[0]);

  const existingExtra = currentExtra
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = Array.from(
    new Set([...cleanDiscovered, ...existingExtra]),
  )
    .filter((id) => id !== nextDefault)
    .slice(0, 12);

  return {
    defaultModel: nextDefault,
    extraModels: merged.join(', '),
  };
}

export function normalizeOpenAiBaseUrl(rawUrl: string): string {
  const clean = rawUrl
    .trim()
    .replace(/\/+$/g, '')
    .replace(/\/(?:chat\/completions|responses)$/i, '')
    .replace(/\/+$/g, '');
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (!parsed.pathname || parsed.pathname === '/')) {
      return `${clean}/v1`;
    }
  } catch {
    return clean;
  }
  return clean;
}

/**
 * 解析 NewAPI / OneAPI 等网关导出的 JSON 连接串（如 `{"_type":"newapi_channel_conn","key":"...","url":"..."}`），
 * 让用户粘贴到 Base URL 或 API Key 任意输入框即可一次性回填连接地址与密钥。
 */
export function parseConnectionSnippet(
  raw: string,
): { baseUrl: string; apiKey: string; model?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const rawUrl =
      typeof obj.url === 'string'
        ? obj.url
        : typeof obj.baseUrl === 'string'
          ? obj.baseUrl
          : typeof obj.base_url === 'string'
            ? obj.base_url
            : '';
    const rawKey =
      typeof obj.key === 'string'
        ? obj.key
        : typeof obj.apiKey === 'string'
          ? obj.apiKey
          : typeof obj.api_key === 'string'
            ? obj.api_key
            : '';
    const baseUrl = normalizeOpenAiBaseUrl(rawUrl);
    const apiKey = rawKey.trim();
    if (!baseUrl || !apiKey) return null;
    const model =
      typeof obj.model === 'string' && obj.model.trim()
        ? obj.model.trim()
        : typeof obj.defaultModel === 'string' && obj.defaultModel.trim()
          ? obj.defaultModel.trim()
          : undefined;
    return { baseUrl, apiKey, ...(model ? { model } : {}) };
  } catch {
    return null;
  }
}
