import type {
  AiChatRequest,
  AiChunk,
  AiMessage,
  AiProvider,
  AiProviderLocality,
  AiToolCall,
  AiUsage,
} from './provider';

export interface OpenAiCompatibleConfig {
  id: string;
  baseUrl: string;
  model: string;
  locality: AiProviderLocality;
  embeddingModel?: string;
  getApiKey?: () => Promise<string | undefined>;
  apiKeyHeader?: 'authorization' | 'api-key';
  fetch?: typeof fetch;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiChunkPayload {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage | null;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function usage(value: OpenAiUsage | null | undefined): AiUsage | undefined {
  if (!value) return undefined;
  return {
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
  };
}

function apiMessages(messages: AiMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.role === 'assistant' && message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments },
          })),
        }
      : {}),
  }));
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.text()).slice(0, 2_000).trim();
  return `AI 请求失败（HTTP ${response.status}）${body ? `: ${body}` : ''}`;
}

async function* parseSse(response: Response, parseToolCalls: boolean): AsyncGenerator<AiChunk> {
  if (!response.body) throw new Error('AI 流式响应没有响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = new Map<number, AiToolCall>();

  const takeToolCalls = (): AiToolCall[] | undefined => {
    if (!toolCalls.size) return undefined;
    const result = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCall);
    toolCalls.clear();
    return result;
  };

  const consume = function* (event: string): Generator<AiChunk> {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trimStart();
      if (!data || data === '[DONE]') continue;
      const payload = JSON.parse(data) as OpenAiChunkPayload;
      const choice = payload.choices?.[0];
      const content = choice?.delta?.content ?? undefined;
      const reasoning = choice?.delta?.reasoning_content ?? undefined;
      const finishReason = choice?.finish_reason ?? undefined;
      const tokenUsage = usage(payload.usage);
      if (parseToolCalls) {
        for (const partial of choice?.delta?.tool_calls ?? []) {
          const current = toolCalls.get(partial.index) ?? { id: '', name: '', arguments: '' };
          toolCalls.set(partial.index, {
            id: partial.id ?? current.id,
            name: partial.function?.name ?? current.name,
            arguments: current.arguments + (partial.function?.arguments ?? ''),
          });
        }
      }
      const completedToolCalls = finishReason ? takeToolCalls() : undefined;
      if (content || reasoning || finishReason || tokenUsage) {
        if (completedToolCalls) {
          yield { content, reasoning, finishReason, usage: tokenUsage, toolCalls: completedToolCalls };
        } else {
          yield { content, reasoning, finishReason, usage: tokenUsage };
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

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  readonly locality: AiProviderLocality;
  readonly model: string;
  readonly origin: string;
  readonly embeddingModel?: string;
  private readonly config: OpenAiCompatibleConfig;

  constructor(config: OpenAiCompatibleConfig) {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('AI Provider 地址必须是无凭据的 http/https URL');
    }
    this.id = config.id;
    this.locality = config.locality;
    this.model = config.model;
    this.origin = url.origin;
    this.embeddingModel = config.embeddingModel;
    this.config = config;
  }

  async *chat(request: AiChatRequest): AsyncGenerator<AiChunk> {
    const apiKey = await this.config.getApiKey?.();
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (apiKey) {
      if (this.config.apiKeyHeader === 'api-key') headers.set('api-key', apiKey);
      else headers.set('Authorization', `Bearer ${apiKey}`);
    }
    const response = await (this.config.fetch ?? fetch)(
      endpoint(this.config.baseUrl, '/chat/completions'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: apiMessages(request.messages),
          stream: true,
          stream_options: { include_usage: true },
          ...(request.tools?.length ? { tools: request.tools } : {}),
          ...(request.responseFormat === 'json'
            ? { response_format: { type: 'json_object' } }
            : {}),
          ...(request.thinking ? { thinking: { type: request.thinking } } : {}),
          ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        }),
      },
    );
    if (!response.ok) throw new Error(await errorMessage(response));
    yield* parseSse(response, !!request.tools?.length);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.config.embeddingModel) throw new Error(`Provider ${this.id} 未配置 embedding 模型`);
    const apiKey = await this.config.getApiKey?.();
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (apiKey) {
      if (this.config.apiKeyHeader === 'api-key') headers.set('api-key', apiKey);
      else headers.set('Authorization', `Bearer ${apiKey}`);
    }
    const response = await (this.config.fetch ?? fetch)(
      endpoint(this.config.baseUrl, '/embeddings'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.config.embeddingModel, input: texts }),
      },
    );
    if (!response.ok) throw new Error(await errorMessage(response));
    const payload = (await response.json()) as { data?: Array<{ index: number; embedding: number[] }> };
    const rows = [...(payload.data ?? [])].sort((left, right) => left.index - right.index);
    if (rows.length !== texts.length || rows.some((row) => !Array.isArray(row.embedding))) {
      throw new Error('embedding 响应数量与请求不一致');
    }
    return rows.map((row) => row.embedding);
  }
}
