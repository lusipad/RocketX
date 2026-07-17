export type AiMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AiMessage {
  role: AiMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
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
  embeddingModel?: string;
  chat(request: AiChatRequest): AsyncIterable<AiChunk>;
  embed?(texts: string[]): Promise<number[][]>;
}

export type AiCapability =
  | 'summary'
  | 'extraction'
  | 'daily-review'
  | 'semantic-search'
  | 'text-tool'
  | 'agent';

export interface AiRoute {
  providerId: string;
  localOnly: boolean;
}
