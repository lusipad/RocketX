import type { AiCapability, AiChatRequest, AiChunk } from '../provider';

export interface AiChatGateway {
  chat(capability: AiCapability, request: AiChatRequest): AsyncIterable<AiChunk>;
}

const SUCCESS_FINISH_REASONS = new Set(['stop', 'end_turn']);

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('AI 返回了空内容');
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('AI 返回的 JSON 不是对象');
    }
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('AI 返回了无效 JSON');
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
  if (!finishReason) throw new Error('AI 响应未完整结束');
  if (!SUCCESS_FINISH_REASONS.has(finishReason)) {
    throw new Error(`AI 响应未完整生成（${finishReason}）`);
  }
  return parseJsonObject(content);
}

export function asRecord(value: unknown, label = '结果'): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  const result = value.trim();
  return result || undefined;
}

export function stringArray(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label}必须是字符串数组`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}
