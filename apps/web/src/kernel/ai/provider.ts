export type AiMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AiImageInput {
  dataUrl: string;
}

export interface AiMessage {
  role: AiMessageRole;
  content: string;
  images?: AiImageInput[];
  name?: string;
  toolCallId?: string;
  toolCalls?: AiToolCall[];
}

export interface AiToolCall {
  id: string;
  name: string;
  /** Provider 原样返回的 JSON 参数字符串。 */
  arguments: string;
}

export interface AiTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiChunk {
  content?: string;
  reasoning?: string;
  toolCalls?: AiToolCall[];
  finishReason?: string;
  usage?: AiUsage;
}

export interface AiChatRequest {
  messages: AiMessage[];
  tools?: AiTool[];
  responseFormat?: 'text' | 'json';
  thinking?: 'enabled' | 'disabled';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  maxTokens?: number;
}

export type AiProviderLocality = 'local' | 'external';

export interface AiProvider {
  id: string;
  locality: AiProviderLocality;
  model?: string;
  origin?: string;
  chat(request: AiChatRequest): AsyncIterable<AiChunk>;
}

export type AiCapability =
  | 'summary'
  | 'extraction'
  | 'daily-review'
  | 'butler-rounds'
  | 'text-tool'
  | 'agent';

export interface AiRoute {
  providerId: string;
  localOnly: boolean;
}
