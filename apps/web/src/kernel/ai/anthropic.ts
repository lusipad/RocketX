import type {
  AiChatRequest,
  AiChunk,
  AiMessage,
  AiProvider,
  AiProviderLocality,
  AiToolCall,
  AiUsage,
} from './provider';

export interface AnthropicProviderConfig {
  id: string;
  baseUrl: string;
  model: string;
  locality: AiProviderLocality;
  getApiKey: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { id?: string; usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
}

function asUsage(input?: number, output?: number): AiUsage | undefined {
  if (input === undefined && output === undefined) return undefined;
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input !== undefined && output !== undefined ? input + output : undefined,
  };
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

function toolInput(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText || '{}');
  } catch {
    return {};
  }
}

function assistantContent(message: AiMessage): string | AnthropicContentBlock[] {
  if (!message.toolCalls?.length) return message.content;
  return [
    ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
    ...message.toolCalls.map((toolCall) => ({
      type: 'tool_use' as const,
      id: toolCall.id,
      name: toolCall.name,
      input: toolInput(toolCall.arguments),
    })),
  ];
}

function asBlocks(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function apiMessages(messages: AiMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const next: AnthropicMessage =
      message.role === 'assistant'
        ? { role: 'assistant', content: assistantContent(message) }
        : message.role === 'tool'
          ? {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content }],
            }
          : { role: 'user', content: message.content };
    const previous = result.at(-1);
    if (previous?.role === next.role) {
      previous.content = [...asBlocks(previous.content), ...asBlocks(next.content)];
    } else {
      result.push(next);
    }
  }
  return result;
}

async function* parseAnthropicSse(
  response: Response,
  parseToolCalls: boolean,
): AsyncGenerator<AiChunk> {
  if (!response.body) throw new Error('AI 流式响应没有响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = new Map<number, AiToolCall>();
  const completedToolIndexes = new Set<number>();

  const takeToolCalls = (): AiToolCall[] | undefined => {
    if (!completedToolIndexes.size) return undefined;
    const indexes = [...completedToolIndexes].sort((left, right) => left - right);
    const result = indexes
      .map((index) => toolCalls.get(index))
      .filter((toolCall): toolCall is AiToolCall => !!toolCall);
    completedToolIndexes.clear();
    for (const index of indexes) toolCalls.delete(index);
    return result.length ? result : undefined;
  };

  const consume = function* (event: string): Generator<AiChunk> {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const payload = JSON.parse(data) as AnthropicEvent;
    if (payload.type === 'error') throw new Error(payload.error?.message ?? 'Anthropic 流返回错误');
    if (payload.type === 'message_start') {
      const tokenUsage = asUsage(payload.message?.usage?.input_tokens, undefined);
      if (tokenUsage) yield { usage: tokenUsage };
      return;
    }
    if (parseToolCalls && payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
      toolCalls.set(payload.index ?? -1, {
        id: payload.content_block.id ?? '',
        name: payload.content_block.name ?? '',
        arguments: '',
      });
      return;
    }
    if (payload.type === 'content_block_delta') {
      if (payload.delta?.type === 'text_delta' && payload.delta.text) {
        yield { content: payload.delta.text };
      } else if (payload.delta?.type === 'thinking_delta' && payload.delta.thinking) {
        yield { reasoning: payload.delta.thinking };
      } else if (parseToolCalls && payload.delta?.type === 'input_json_delta') {
        const index = payload.index ?? -1;
        const toolCall = toolCalls.get(index);
        if (toolCall) toolCall.arguments += payload.delta.partial_json ?? '';
      }
      return;
    }
    if (parseToolCalls && payload.type === 'content_block_stop') {
      const index = payload.index ?? -1;
      if (toolCalls.has(index)) completedToolIndexes.add(index);
      return;
    }
    if (payload.type === 'message_delta') {
      const tokenUsage = asUsage(undefined, payload.usage?.output_tokens);
      const finishReason = payload.delta?.stop_reason ?? undefined;
      const completedToolCalls = finishReason ? takeToolCalls() : undefined;
      if (tokenUsage || finishReason) {
        if (completedToolCalls) {
          yield { usage: tokenUsage, finishReason, toolCalls: completedToolCalls };
        } else {
          yield { usage: tokenUsage, finishReason };
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) yield* consume(event);
      if (done) break;
    }
    if (buffer.trim()) yield* consume(buffer);
    const completedToolCalls = takeToolCalls();
    if (completedToolCalls) yield { toolCalls: completedToolCalls };
  } finally {
    reader.releaseLock();
  }
}

export class AnthropicProvider implements AiProvider {
  readonly id: string;
  readonly locality: AiProviderLocality;
  readonly model: string;
  readonly origin: string;

  constructor(private readonly config: AnthropicProviderConfig) {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('AI Provider 地址必须是无凭据的 http/https URL');
    }
    this.id = config.id;
    this.locality = config.locality;
    this.model = config.model;
    this.origin = url.origin;
  }

  async *chat(request: AiChatRequest): AsyncGenerator<AiChunk> {
    const apiKey = await this.config.getApiKey();
    if (!apiKey) throw new Error(`Provider ${this.id} 尚未配置 API 密钥`);
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const messages = apiMessages(request.messages);
    const tools = request.tools?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    const response = await (this.config.fetch ?? fetch)(endpoint(this.config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: request.maxTokens ?? 4096,
        stream: true,
        ...(system ? { system } : {}),
        messages,
        ...(tools?.length ? { tools } : {}),
        ...(request.thinking === 'enabled'
          ? { thinking: { type: 'enabled', budget_tokens: Math.max(1024, request.maxTokens ?? 4096) } }
          : {}),
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000).trim();
      throw new Error(`AI 请求失败（HTTP ${response.status}）${detail ? `: ${detail}` : ''}`);
    }
    yield* parseAnthropicSse(response, !!request.tools?.length);
  }
}
