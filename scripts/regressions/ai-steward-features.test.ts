import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMessageAction,
  toTodoPrefill,
  toWorkItemPrefill,
} from '../../apps/web/src/agent/messageActionExtraction';
import type {
  AiChatGateway,
  AiChatRequest,
  AiChunk,
} from '../../apps/web/src/agent/structuredOutput';

function gateway(chunks: AiChunk[], inspect?: (request: AiChatRequest) => void): AiChatGateway {
  return {
    async *chat(_capability, request) {
      inspect?.(request);
      for (const chunk of chunks) yield chunk;
    },
  };
}

test('消息提取完整消费 Codex Skill JSON 流并生成待办/工作项预填', async () => {
  let request: AiChatRequest | undefined;
  const draft = await extractMessageAction(
    {
      rid: 'r1', mid: 'm1', roomName: '项目群', author: 'Alice',
      text: '明天修好登录 401，建一个 Bug 并打生产标签',
      context: [
        { author: 'Alice', text: '先确认生产环境的登录问题', sentAt: '2026-07-17T08:00:00.000Z' },
        { author: 'Bob', text: '明天修好登录 401，建一个 Bug 并打生产标签', sentAt: '2026-07-17T09:00:00.000Z' },
      ],
      now: new Date(2026, 6, 17, 9),
      availableWorkItemTypes: ['Task', 'Bug'],
    },
    gateway([
      { content: '{"title":"修复登录 401","description":"检查生产日志",' },
      { content: '"due":"2026-07-18","workItemType":"Bug","tags":["生产"]}' },
      { finishReason: 'stop' },
    ], (value) => { request = value; }),
  );

  assert.equal(request?.responseFormat, 'json');
  assert.match(request?.messages[0].content ?? '', /JSON 示例：\{/);
  assert.doesNotMatch(request?.messages[0].content ?? '', /Task、Bug/);
  assert.match(request?.messages[1].content ?? '', /"availableWorkItemTypes":\["Task","Bug"\]/);
  assert.match(request?.messages[1].content ?? '', /"context":\[\{"author":"Alice"/);
  assert.deepEqual(draft, {
    source: { rid: 'r1', mid: 'm1', roomName: '项目群', author: 'Alice' },
    title: '修复登录 401',
    description: '检查生产日志',
    due: '2026-07-18',
    workItemType: 'Bug',
    tags: ['生产'],
  });
  assert.deepEqual(toTodoPrefill(draft, '原始消息'), {
    rid: 'r1', mid: 'm1', roomName: '项目群', author: 'Alice',
    excerpt: '原始消息', note: '修复登录 401', due: '2026-07-18',
  });
  assert.deepEqual(toWorkItemPrefill(draft), {
    title: '修复登录 401', description: '检查生产日志', due: '2026-07-18',
    type: 'Bug', tags: '生产',
  });
});

test('合法 JSON 只要被模型标记截断也不能伪装成功', async () => {
  await assert.rejects(
    () => extractMessageAction(
      { rid: 'r', mid: 'm', roomName: '群', author: 'A', text: '做事' },
      gateway([{ content: '{"title":"做事","tags":[]}' }, { finishReason: 'length' }]),
    ),
    /未完整生成（length）/,
  );
});

test('空响应和无结束标记均明确失败', async () => {
  const input = { rid: 'r', mid: 'm', roomName: '群', author: 'A', text: '做事' };
  await assert.rejects(() => extractMessageAction(input, gateway([{ finishReason: 'stop' }])), /空内容/);
  await assert.rejects(() => extractMessageAction(input, gateway([{ content: '{"title":"做事"}' }])), /未完整结束/);
});
