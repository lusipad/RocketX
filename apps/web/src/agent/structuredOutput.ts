import { t } from '../i18n';

/** Codex Skill 的小型结构化输出边界，不包含独立模型 Provider。 */
export type AiCapability = 'extraction';

export interface AiChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  responseFormat?: 'text' | 'json';
  thinking?: 'enabled' | 'disabled';
  maxTokens?: number;
}

export interface AiChunk {
  content?: string;
  finishReason?: string;
}

export interface AiChatGateway {
  chat(capability: AiCapability, request: AiChatRequest): AsyncIterable<AiChunk>;
}

const SUCCESS_FINISH_REASONS = new Set(['stop', 'end_turn']);

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) throw new Error(t('agent.structuredOutput.empty'));
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error(t('agent.structuredOutput.notObject'));
    }
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(t('agent.structuredOutput.invalidJson'));
    throw error;
  }
}

/**
 * 结构化任务只有在完整消费流且收到明确的正常结束原因后才会解析结果。
 * 这样即使截断位置恰好组成合法 JSON，也不会被误报为成功。
 */
export async function collectStructuredObject(
  gateway: AiChatGateway,
  capability: AiCapability,
  request: AiChatRequest,
): Promise<unknown> {
  let content = '';
  let finishReason: string | undefined;
  for await (const chunk of gateway.chat(capability, request)) {
    content += chunk.content ?? '';
    if (chunk.finishReason) finishReason = chunk.finishReason;
  }
  if (!finishReason) throw new Error(t('agent.structuredOutput.incomplete'));
  if (!SUCCESS_FINISH_REASONS.has(finishReason)) {
    throw new Error(t('agent.structuredOutput.incompleteReason', { reason: finishReason }));
  }
  return parseJsonObject(content);
}

export function asRecord(value: unknown, label?: string): Record<string, unknown> {
  const resolvedLabel = label ?? t('agent.structuredOutput.defaultLabel');
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(t('agent.structuredOutput.mustBeObject', { label: resolvedLabel }));
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(t('agent.structuredOutput.cannotBeEmpty', { label }));
  return value.trim();
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(t('agent.structuredOutput.mustBeString', { label }));
  const result = value.trim();
  return result || undefined;
}

export function stringArray(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(t('agent.structuredOutput.mustBeStringArray', { label }));
  }
  return value.map((item) => item.trim()).filter(Boolean);
}
