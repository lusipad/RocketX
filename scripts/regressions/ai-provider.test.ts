import test from 'node:test';
import assert from 'node:assert/strict';
import { AiBus, type AiAuditEntry } from '../../apps/web/src/kernel/ai/bus';
import { OpenAiCompatibleProvider } from '../../apps/web/src/kernel/ai/openai-compatible';
import { AnthropicProvider } from '../../apps/web/src/kernel/ai/anthropic';
import type { AiProvider } from '../../apps/web/src/kernel/ai/provider';
import { readFile } from 'node:fs/promises';

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

test('DeepSeek V4 走 OpenAI-compatible 流并解析跨分片 reasoning、正文和 usage', async () => {
  let url = '';
  let authorization = '';
  let body: Record<string, unknown> = {};
  const provider = new OpenAiCompatibleProvider({
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    locality: 'external',
    getApiKey: async () => 'secret-value',
    fetch: async (input, init) => {
      url = input.toString();
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"先想"},"finish_reason":null}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"答"},"finish_reason":null}]}\n',
        '\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
  });

  const chunks = [];
  for await (const chunk of provider.chat({
    messages: [{ role: 'user', content: '测试' }],
    responseFormat: 'json',
    thinking: 'enabled',
    reasoningEffort: 'high',
  })) chunks.push(chunk);

  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(authorization, 'Bearer secret-value');
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.deepEqual(chunks, [
    { content: undefined, reasoning: '先想', finishReason: undefined, usage: undefined },
    { content: '答', reasoning: undefined, finishReason: undefined, usage: undefined },
    {
      content: undefined,
      reasoning: undefined,
      finishReason: undefined,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    },
  ]);
});

test('DeepSeek 未配置 embedding 模型时不伪造其不存在的 embeddings 能力', async () => {
  const provider = new OpenAiCompatibleProvider({
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    locality: 'external',
  });
  await assert.rejects(() => provider.embed(['hello']), /未配置 embedding 模型/);
});

test('Azure OpenAI v1 使用 api-key 且保留部署名作为 model', async () => {
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const provider = new OpenAiCompatibleProvider({
    id: 'azure',
    baseUrl: 'https://example.openai.azure.com/openai/v1',
    model: 'summary-deployment',
    locality: 'external',
    apiKeyHeader: 'api-key',
    getApiKey: async () => 'azure-secret',
    fetch: async (input, init) => {
      assert.equal(input.toString(), 'https://example.openai.azure.com/openai/v1/chat/completions');
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n']);
    },
  });
  for await (const _chunk of provider.chat({ messages: [{ role: 'user', content: 'test' }] })) {
    // 消费完整流
  }
  assert.equal(headers.get('api-key'), 'azure-secret');
  assert.equal(headers.has('authorization'), false);
  assert.equal(body.model, 'summary-deployment');
});

test('Anthropic 适配器把 system 提到顶层并解析命名 SSE 事件', async () => {
  let body: Record<string, unknown> = {};
  const provider = new AnthropicProvider({
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet',
    locality: 'external',
    getApiKey: async () => 'anthropic-secret',
    fetch: async (input, init) => {
      assert.equal(input.toString(), 'https://api.anthropic.com/v1/messages');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('x-api-key'), 'anthropic-secret');
      assert.equal(headers.get('anthropic-version'), '2023-06-01');
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
        'event: ping\ndata: {"type":"ping"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    },
  });
  const chunks = [];
  for await (const chunk of provider.chat({
    messages: [
      { role: 'system', content: 'system text' },
      { role: 'user', content: 'hello' },
    ],
  })) chunks.push(chunk);
  assert.equal(body.system, 'system text');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(chunks, [
    { usage: { promptTokens: 4, completionTokens: undefined, totalTokens: undefined } },
    { content: 'OK' },
    {
      usage: { promptTokens: undefined, completionTokens: 1, totalTokens: undefined },
      finishReason: 'end_turn',
    },
  ]);
});

test('仅本地路由在调用 Provider 前拒绝外部模型且审计不包含 prompt', async () => {
  let called = false;
  const external: AiProvider = {
    id: 'deepseek',
    locality: 'external',
    async *chat() {
      called = true;
      yield { content: '不应到达' };
    },
  };
  const audits: AiAuditEntry[] = [];
  const bus = new AiBus((entry) => audits.push(entry));
  bus.register(external);
  bus.setRoute('summary', { providerId: 'deepseek', localOnly: true });

  await assert.rejects(async () => {
    for await (const _chunk of bus.chat('summary', {
      messages: [{ role: 'user', content: '绝不能落审计的秘密 prompt' }],
    })) {
      // 不应产出
    }
  }, /仅允许本地模型/);

  assert.equal(called, false);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].allowed, false);
  assert.equal(JSON.stringify(audits).includes('秘密 prompt'), false);
});

test('AI 总线流式转发并记录成功审计', async () => {
  const provider: AiProvider = {
    id: 'local',
    locality: 'local',
    async *chat() {
      yield { content: 'A' };
      yield { content: 'B' };
    },
  };
  const audits: AiAuditEntry[] = [];
  const bus = new AiBus((entry) => audits.push(entry));
  bus.register(provider);
  bus.setRoute('summary', { providerId: 'local', localOnly: true });

  let content = '';
  for await (const chunk of bus.chat('summary', { messages: [{ role: 'user', content: 'hi' }] })) {
    content += chunk.content ?? '';
  }
  assert.equal(content, 'AB');
  assert.equal(audits.length, 1);
  assert.deepEqual(
    { action: audits[0].action, allowed: audits[0].allowed, providerId: audits[0].providerId },
    { action: 'ai.chat', allowed: true, providerId: 'local' },
  );
});

test('AI 密钥只通过系统钥匙串命令，前端没有持久化明文回退', async () => {
  const source = await readFile('apps/web/src/kernel/ai/secrets.ts', 'utf8');
  assert.match(source, /invoke\('ai_secret_set'/);
  assert.match(source, /invoke<string \| null>\('ai_secret_get'/);
  assert.match(source, /invoke\('ai_secret_delete'/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
});

test('$codex 宿主命令固定 read-only + ephemeral 且 prompt 只走 stdin', async () => {
  const source = await readFile('apps/desktop/src-tauri/src/main.rs', 'utf8');
  assert.match(source, /"--sandbox",\s*"read-only"/);
  assert.match(source, /"--ephemeral"/);
  assert.match(source, /"--ignore-user-config"/);
  assert.match(source, /\.arg\("-"\)/);
  assert.match(source, /write_all\(prompt\.as_bytes\(\)\)/);
  assert.doesNotMatch(source, /dangerously-bypass-approvals-and-sandbox/);
});
