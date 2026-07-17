import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiChatRequest, AiChunk } from '../../apps/web/src/kernel/ai/provider';
import {
  extractMessageAction,
  toTodoPrefill,
  toWorkItemPrefill,
} from '../../apps/web/src/kernel/ai/features/message-extraction';
import {
  generateDailyReview,
  renderDailyReviewMarkdown,
} from '../../apps/web/src/kernel/ai/features/daily-review';
import type { AiChatGateway } from '../../apps/web/src/kernel/ai/features/structured-output';
import type { TodayItem } from '../../apps/web/src/lib/today';

function gateway(chunks: AiChunk[], inspect?: (request: AiChatRequest) => void): AiChatGateway {
  return {
    async *chat(_capability, request) {
      inspect?.(request);
      for (const chunk of chunks) yield chunk;
    },
  };
}

test('消息提取完整消费 DeepSeek JSON 流并生成待办/工作项预填', async () => {
  let request: AiChatRequest | undefined;
  const draft = await extractMessageAction(
    {
      rid: 'r1', mid: 'm1', roomName: '项目群', author: 'Alice',
      text: '明天修好登录 401，建一个 Bug 并打生产标签',
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

const todayItems: TodayItem[] = [
  {
    key: 'todo:1', kind: 'todo', title: '修复生产故障', meta: '项目群', urgency: 0, processed: false,
    todo: { id: '1', rid: 'r', mid: 'm', roomName: '项目群', excerpt: '故障', author: 'A', due: '2026-07-17', done: false, createdAt: 1 },
  },
  {
    key: 'rc:1', kind: 'mention', title: '请确认发布窗口', meta: '发布群', urgency: 1, processed: false,
    roomName: '发布群', message: { _id: 'm2', rid: 'r2', msg: '请确认发布窗口', ts: '2026-07-17T08:00:00Z', u: { _id: 'u', username: 'alice' } },
  },
];

test('晨报只接受真实今日条目引用并能渲染为可读文本', async () => {
  let prompt = '';
  let input = '';
  const review = await generateDailyReview('morning', todayItems, gateway([
    { content: '{"headline":"先处理故障","summary":"今天有两件事。","priorities":[' },
    { content: '{"itemKey":"todo:1","action":"立即排查","reason":"今天到期"}],"risks":["发布窗口待确认"],"carryOvers":[]}' },
    { finishReason: 'stop' },
  ], (request) => {
    prompt = request.messages[0].content;
    input = request.messages[1].content;
  }), new Date(2026, 6, 17, 9, 30));

  assert.match(prompt, /这是晨报/);
  assert.match(prompt, /JSON 示例：\{/);
  assert.match(input, /"localTime":"2026-07-17 09:30"/);
  assert.equal(review.priorities[0].itemKey, 'todo:1');
  assert.match(renderDailyReviewMarkdown(review), /## 先处理故障[\s\S]*立即排查/);
});

test('晚间回顾拒绝 AI 虚构的条目键', async () => {
  await assert.rejects(
    () => generateDailyReview('evening', todayItems, gateway([
      { content: '{"headline":"收尾","summary":"仍有事项。","priorities":[],"risks":[],"carryOvers":[{"itemKey":"invented","recommendation":"defer","reason":"明天做"}]}' },
      { finishReason: 'end_turn' },
    ])),
    /不存在的今日条目: invented/,
  );
});
