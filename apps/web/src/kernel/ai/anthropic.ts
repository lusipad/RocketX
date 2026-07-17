import type {
  AiChatRequest,
  AiChunk,
  AiProvider,
  AiProviderLocality,
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
  message?: { id?: string; usage?: { input_tokens?: number } };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
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

async function* parseAnthropicSse(response: Response): AsyncGenerator<AiChunk> {
  if (!response.body) throw new Error('AI 流式响应没有响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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
    if (payload.type === 'content_block_delta') {
      if (payload.delta?.type === 'text_delta' && payload.delta.text) {
        yield { content: payload.delta.text };
      } else if (payload.delta?.type === 'thinking_delta' && payload.delta.thinking) {
        yield { reasoning: payload.delta.thinking };
      }
      return;
    }
    if (payload.type === 'message_delta') {
      const tokenUsage = asUsage(undefined, payload.usage?.output_tokens);
      const finishReason = payload.delta?.stop_reason ?? undefined;
      if (tokenUsage || finishReason) yield { usage: tokenUsage, finishReason };
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
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));
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
    yield* parseAnthropicSse(response);
  }
}
