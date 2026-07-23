import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runAgentLoop,
  type AgentLoopGateway,
  type ButlerTool,
} from '../../apps/web/src/kernel/ai/agent-loop';
import type { AiChunk, AiChatRequest } from '../../apps/web/src/kernel/ai/provider';
import {
  defineButlerTool,
  type ButlerToolCheckpoint,
  type ButlerToolResult,
} from '../../apps/web/src/lib/butlerToolRuntime';

function scriptedGateway(rounds: AiChunk[][]): { gateway: AgentLoopGateway; requests: AiChatRequest[] } {
  const requests: AiChatRequest[] = [];
  let index = 0;
  return {
    requests,
    gateway: {
      async *chat(_capability, request) {
        requests.push(request);
        for (const chunk of rounds[index++] ?? []) yield chunk;
      },
    },
  };
}

function tool(
  name: string,
  invokeImpl: (args: Record<string, unknown>) => Promise<string> | string,
): ButlerTool {
  return {
    name,
    description: `${name} 工具`,
    parameters: { type: 'object' },
    effect: 'read',
    capability: `test.${name}`,
    invoke: async (args): Promise<ButlerToolResult> => ({
      status: 'completed',
      toolName: name,
      effect: 'read',
      capability: `test.${name}`,
      content: await invokeImpl(args),
    }),
  };
}

test('Agent 循环执行工具并把结果回填到下一轮消息', async () => {
  const { gateway, requests } = scriptedGateway([
    [{ content: '我先查一下。', toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"query":"发布"}' }] }],
    [{ content: '查到了。' }],
  ]);
  const events: string[] = [];
  const result = await runAgentLoop({
    gateway,
    messages: [{ role: 'system', content: '你是管家' }, { role: 'user', content: '查发布' }],
    tools: [tool('lookup', async (args) => `结果：${args.query}`)],
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(result.text, '我先查一下。查到了。');
  assert.deepEqual(result.messages.slice(-2), [
    {
      role: 'assistant',
      content: '我先查一下。',
      toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"query":"发布"}' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: '结果：发布' },
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1)?.role, 'tool');
  assert.deepEqual(events, ['content', 'tool-call', 'tool-result', 'content']);
});

test('Agent 循环把未知工具、无效参数和工具异常作为结果回喂，并继续下一轮', async () => {
  const { gateway } = scriptedGateway([
    [{
      toolCalls: [
        { id: 'unknown', name: 'missing', arguments: '{}' },
        { id: 'invalid', name: 'broken', arguments: '{' },
        { id: 'throws', name: 'broken', arguments: '{}' },
      ],
    }],
    [{ content: '已处理。' }],
  ]);
  const result = await runAgentLoop({
    gateway,
    messages: [{ role: 'user', content: '处理' }],
    tools: [tool('broken', async () => { throw new Error('后端不可用'); })],
  });

  const toolResults = result.messages.slice(-3);
  assert.deepEqual(toolResults[0], { role: 'tool', toolCallId: 'unknown', content: '未知工具：missing' });
  assert.equal(toolResults[1].role, 'tool');
  assert.equal(toolResults[1].toolCallId, 'invalid');
  assert.match(toolResults[1].content, /^工具参数无效：/);
  assert.deepEqual(toolResults[2], { role: 'tool', toolCallId: 'throws', content: '工具执行失败：后端不可用' });
  assert.equal(result.text, '已处理。');
});

test('Agent 循环在达到 maxRounds 后停止，不启动下一轮', async () => {
  const { gateway, requests } = scriptedGateway([
    [{ content: '处理中。', toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{}' }] }],
    [{ content: '不应出现。' }],
  ]);
  const result = await runAgentLoop({
    gateway,
    messages: [{ role: 'user', content: '查' }],
    tools: [tool('lookup', async () => '结果')],
    maxRounds: 1,
  });

  assert.equal(requests.length, 1);
  assert.equal(result.text, '处理中。');
  assert.equal(result.messages.at(-1)?.role, 'tool');
});

test('Agent 循环响应 AbortSignal，且不吞掉网关错误', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const gateway: AgentLoopGateway = {
    async *chat() {
      called = true;
      yield { content: '不应出现' };
    },
  };
  await assert.rejects(
    () => runAgentLoop({ gateway, messages: [{ role: 'user', content: '查' }], tools: [], signal: controller.signal }),
    /中止|aborted/,
  );
  assert.equal(called, false);

  const failingGateway: AgentLoopGateway = {
    async *chat() {
      throw new Error('网关失败');
    },
  };
  await assert.rejects(
    () => runAgentLoop({ gateway: failingGateway, messages: [{ role: 'user', content: '查' }], tools: [] }),
    /网关失败/,
  );
});

test('API Agent 写工具只生成审批 checkpoint，不会绕过 runtime 直接执行', async () => {
  const { gateway } = scriptedGateway([
    [{ toolCalls: [{ id: 'remember-1', name: 'remember', arguments: '{"fact":"偏好简短回复"}' }] }],
    [{ content: '已提交确认。' }],
  ]);
  const checkpoints = new Map<string, ButlerToolCheckpoint>();
  let writes = 0;
  const remember = defineButlerTool({
    name: 'remember',
    description: '记忆草案',
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string' } },
      required: ['fact'],
      additionalProperties: false,
    },
    effect: 'write',
    capability: 'memory.write',
    preview: (args) => `写入长期记忆：${String(args.fact)}`,
    execute: async () => {
      writes += 1;
      return '已记住';
    },
  });
  const result = await runAgentLoop({
    gateway,
    messages: [{ role: 'user', content: '记住我偏好简短回复' }],
    tools: [remember],
    toolRuntimeContext: () => ({
      taskId: 'task-1',
      loadCheckpoint: (id) => checkpoints.get(id),
      saveCheckpoint: (checkpoint) => checkpoints.set(checkpoint.id, checkpoint),
      writeAudit: () => undefined,
    }),
  });

  assert.equal(writes, 0);
  assert.equal([...checkpoints.values()][0]?.status, 'approval-required');
  assert.match(
    result.messages.find((message) => message.role === 'tool')?.content ?? '',
    /approval-required.*尚未执行/,
  );
});
