import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '@rcx/rc-client';
import { renderAgentSessionCard } from '../../apps/web/src/agent/card';
import {
  projectHostedConversation,
} from '../../apps/web/src/agent/hostedConversation';
import type { AgentSession } from '../../apps/web/src/agent/session';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 'agent-session',
    serverId: 'https://chat.example',
    ownerUserId: 'host',
    rid: 'room-release',
    tmid: 'room:room-release',
    host: { userId: 'host', deviceId: 'device', heartbeatAt: 1, expiresAt: 100 },
    access: 'room-members',
    approvedMemberIds: [],
    status: 'ready',
    workspaceRoots: ['D:/Repos/demo'],
    sandboxMode: 'read-only',
    updatedAt: 99_999,
    ...overrides,
  };
}

function message(
  id: string,
  msg: string,
  at: number,
  overrides: Partial<RcMessage> = {},
): RcMessage {
  return {
    _id: id,
    rid: 'room-release',
    msg,
    ts: new Date(at).toISOString(),
    u: { _id: 'member', username: 'zhangsan', name: '张三' },
    ...overrides,
  };
}

test('房间 AI 托管只投影指令和 Codex 回复，并使用真实消息时间', () => {
  const agent = session();
  const card = renderAgentSessionCard({
    version: 1,
    sessionId: agent.sessionId,
    tmid: agent.tmid,
    hostUserId: 'host',
    hostUsername: 'host',
    hostDeviceId: 'device',
    leaseExpiresAt: 100,
    status: 'active',
  });
  const projected = projectHostedConversation(agent, '发布讨论', [
    message('reply', '🤖 Codex\n已经定位到签名步骤。', 3_000, {
      u: { _id: 'ai', username: 'ai', name: 'RocketX AI' },
    }),
    message('normal', '今天几点发布？', 2_500),
    message('card', card, 1_500),
    message('ask', '@ai 检查发布失败原因', 2_000),
    message('pending', '@ai 还没发出', 4_000, { pending: true }),
  ]);

  assert.ok(projected);
  assert.equal(projected.id, 'hosted:room:room-release');
  assert.equal(projected.title, '发布讨论 · 检查发布失败原因');
  assert.equal(projected.preview, '已经定位到签名步骤。');
  assert.equal(projected.updatedAt, 3_000);
  assert.deepEqual(
    projected.lines.map(({ id, role, text, speaker }) => ({ id, role, text, speaker })),
    [
      { id: 'ask', role: 'user', text: '检查发布失败原因', speaker: '张三' },
      { id: 'reply', role: 'assistant', text: '已经定位到签名步骤。', speaker: 'AI 托管' },
    ],
  );
});

test('DeepSeek 托管回复投影时去掉后端署名', () => {
  const agent = session({ backend: 'deepseek' });
  const projected = projectHostedConversation(agent, '研发群', [
    message('question-deepseek', '@ai 检查构建', 1_000),
    message('reply-deepseek', '🤖 DeepSeek\n构建正常。', 2_000),
  ]);

  assert.equal(projected?.lines.at(-1)?.text, '构建正常。');
});

test('话题托管不会混入同房间其他话题，投影身份保持稳定', () => {
  const agent = session({ tmid: 'thread-42', replyTmid: 'thread-42' });
  const input = [
    message('thread-42', '@ai 分析这条失败日志', 1_000),
    message('reply-42', '🤖 Codex\n根因在构建脚本。', 2_000, {
      tmid: 'thread-42',
      u: { _id: 'ai', username: 'ai' },
    }),
    message('other', '@ai 另一个问题', 3_000, { tmid: 'thread-other' }),
  ];

  const first = projectHostedConversation(agent, '构建问题', input);
  const second = projectHostedConversation(agent, '构建问题', [...input].reverse());
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.id, second.id);
  assert.deepEqual(first.lines, second.lines);
  assert.equal(first.lines.some((line) => line.id === 'other'), false);
});

test('只有租约卡而没有真实交流时不生成历史项', () => {
  const agent = session();
  const card = renderAgentSessionCard({
    version: 1,
    sessionId: agent.sessionId,
    tmid: agent.tmid,
    hostUserId: 'host',
    hostUsername: 'host',
    hostDeviceId: 'device',
    leaseExpiresAt: 100,
    status: 'active',
  });
  assert.equal(projectHostedConversation(agent, '发布讨论', [message('card', card, 1_000)]), null);
});
