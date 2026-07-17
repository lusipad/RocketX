import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../../apps/web/src/kernel/ai/anthropic';
import { OpenAiCompatibleProvider } from '../../apps/web/src/kernel/ai/openai-compatible';

function sseResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

test('OpenAI-compatible 累积跨 SSE 事件的 tool_calls，并保留混合文本', async () => {
  const provider = new OpenAiCompatibleProvider({
    id: 'openai',
    baseUrl: 'https://example.test',
    model: 'test-model',
    locality: 'external',
    fetch: async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"我来查。","tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_messages","arguments":"{\\"query\\":\\"发"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"布\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]),
  });

  const chunks = [];
  for await (const chunk of provider.chat({
    messages: [{ role: 'user', content: '查发布' }],
    tools: [{ type: 'function', function: { name: 'search_messages', parameters: {} } }],
  })) chunks.push(chunk);

  assert.deepEqual(chunks, [
    { content: '我来查。', reasoning: undefined, finishReason: undefined, usage: undefined },
    {
      content: undefined,
      reasoning: undefined,
      finishReason: 'tool_calls',
      usage: undefined,
      toolCalls: [{ id: 'call_1', name: 'search_messages', arguments: '{"query":"发布"}' }],
    },
  ]);
});

test('OpenAI-compatible 把 assistant 工具调用历史映射回 tool_calls', async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAiCompatibleProvider({
    id: 'openai',
    baseUrl: 'https://example.test',
    model: 'test-model',
    locality: 'external',
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']);
    },
  });

  for await (const _chunk of provider.chat({
    messages: [
      {
        role: 'assistant',
        content: '我来查询。',
        toolCalls: [{ id: 'call_1', name: 'list_todos', arguments: '{"query":"今天"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '[]' },
    ],
    tools: [{ type: 'function', function: { name: 'list_todos', parameters: {} } }],
  })) {
    // 消费完整流
  }

  assert.deepEqual(body.messages, [
    {
      role: 'assistant',
      content: '我来查询。',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_todos', arguments: '{"query":"今天"}' } }],
    },
    { role: 'tool', content: '[]', tool_call_id: 'call_1' },
  ]);
});

test('Anthropic 映射工具历史、合并同角色消息并解析 input_json_delta', async () => {
  let body: Record<string, unknown> = {};
  const provider = new AnthropicProvider({
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-test',
    locality: 'external',
    getApiKey: async () => 'secret',
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"list_todos"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"今"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"天\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      ]);
    },
  });

  const chunks = [];
  for await (const chunk of provider.chat({
    messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '先查' },
      { role: 'user', content: '再补充条件' },
      {
        role: 'assistant',
        content: '我来查询。',
        toolCalls: [{ id: 'call_1', name: 'list_todos', arguments: '{"query":"今天"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '[{"id":"todo_1"}]' },
      { role: 'tool', toolCallId: 'call_2', content: '[]' },
      { role: 'user', content: '请继续' },
    ],
    tools: [{ type: 'function', function: { name: 'list_todos', parameters: {} } }],
  })) chunks.push(chunk);

  assert.equal(body.system, '系统提示');
  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: '先查' },
        { type: 'text', text: '再补充条件' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我来查询。' },
        { type: 'tool_use', id: 'call_1', name: 'list_todos', input: { query: '今天' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '[{"id":"todo_1"}]' },
        { type: 'tool_result', tool_use_id: 'call_2', content: '[]' },
        { type: 'text', text: '请继续' },
      ],
    },
  ]);
  assert.deepEqual(chunks, [
    {
      usage: undefined,
      finishReason: 'tool_use',
      toolCalls: [{ id: 'tool_1', name: 'list_todos', arguments: '{"query":"今天"}' }],
    },
  ]);
});

test('Anthropic 重放非法工具参数时回退为空 input', async () => {
  let body: Record<string, unknown> = {};
  const provider = new AnthropicProvider({
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-test',
    locality: 'external',
    getApiKey: async () => 'secret',
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(['event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n']);
    },
  });

  for await (const _chunk of provider.chat({
    messages: [{
      role: 'assistant',
      content: '我来查询。',
      toolCalls: [{ id: 'call_1', name: 'list_todos', arguments: '{坏 JSON' }],
    }],
    tools: [{ type: 'function', function: { name: 'list_todos', parameters: {} } }],
  })) {
    // 消费完整流
  }

  assert.deepEqual(body.messages, [{
    role: 'assistant',
    content: [
      { type: 'text', text: '我来查询。' },
      { type: 'tool_use', id: 'call_1', name: 'list_todos', input: {} },
    ],
  }]);
});

test('两个 Provider 不传 tools 时请求体不含 tools 字段', async () => {
  let openAiBody: Record<string, unknown> = {};
  const openAi = new OpenAiCompatibleProvider({
    id: 'openai',
    baseUrl: 'https://example.test',
    model: 'test-model',
    locality: 'external',
    fetch: async (_input, init) => {
      openAiBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n']);
    },
  });
  for await (const _chunk of openAi.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
    // 消费完整流
  }

  let anthropicBody: Record<string, unknown> = {};
  const anthropic = new AnthropicProvider({
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-test',
    locality: 'external',
    getApiKey: async () => 'secret',
    fetch: async (_input, init) => {
      anthropicBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(['event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n']);
    },
  });
  for await (const _chunk of anthropic.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
    // 消费完整流
  }

  assert.equal(Object.hasOwn(openAiBody, 'tools'), false);
  assert.equal(Object.hasOwn(anthropicBody, 'tools'), false);
});
