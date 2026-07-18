import { getAiBus } from './runtime';
import type { AiChatRequest, AiChunk, AiMessage, AiTool, AiToolCall } from './provider';

export interface ButlerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export type AgentLoopEvent =
  | { type: 'content'; content: string }
  | { type: 'reasoning'; reasoning: string }
  | { type: 'tool-call'; toolCall: AiToolCall }
  | { type: 'tool-result'; toolCallId: string; content: string };

export interface AgentLoopGateway {
  chat(capability: 'agent', request: AiChatRequest): AsyncIterable<AiChunk>;
}

export function toAiTools(tools: readonly ButlerTool[]): AiTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Agent 循环已中止');
}

function asArguments(argumentsText: string): Record<string, unknown> {
  const value: unknown = JSON.parse(argumentsText);
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('参数必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

async function executeToolCall(
  toolCall: AiToolCall,
  tools: ReadonlyMap<string, ButlerTool>,
): Promise<string> {
  const tool = tools.get(toolCall.name);
  if (!tool) return `未知工具：${toolCall.name}`;

  let args: Record<string, unknown>;
  try {
    args = asArguments(toolCall.arguments);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `工具参数无效：${message}`;
  }

  try {
    return await tool.execute(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `工具执行失败：${message}`;
  }
}

export async function runAgentLoop(options: {
  gateway?: AgentLoopGateway;
  messages: AiMessage[];
  tools: ButlerTool[];
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
}): Promise<{ text: string; messages: AiMessage[] }> {
  const gateway = options.gateway ?? getAiBus();
  const messages = [...options.messages];
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const maxRounds = Math.max(0, Math.floor(options.maxRounds ?? 6));
  let text = '';

  for (let round = 0; round < maxRounds; round++) {
    throwIfAborted(options.signal);
    const toolCalls: AiToolCall[] = [];
    let roundText = '';
    for await (const chunk of gateway.chat('agent', { messages, tools: toAiTools(options.tools) })) {
      throwIfAborted(options.signal);
      if (chunk.content) {
        text += chunk.content;
        roundText += chunk.content;
        options.onEvent?.({ type: 'content', content: chunk.content });
      }
      if (chunk.reasoning) options.onEvent?.({ type: 'reasoning', reasoning: chunk.reasoning });
      for (const toolCall of chunk.toolCalls ?? []) {
        toolCalls.push(toolCall);
        options.onEvent?.({ type: 'tool-call', toolCall });
      }
    }

    if (!toolCalls.length) return { text, messages };

    messages.push({ role: 'assistant', content: roundText, toolCalls });
    for (const toolCall of toolCalls) {
      throwIfAborted(options.signal);
      const content = await executeToolCall(toolCall, tools);
      throwIfAborted(options.signal);
      messages.push({ role: 'tool', toolCallId: toolCall.id, content });
      options.onEvent?.({ type: 'tool-result', toolCallId: toolCall.id, content });
    }
  }

  return { text, messages };
}
