import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentSessionCardMatchesMessage,
  parseAgentSessionCard,
  renderAgentSessionCard,
  stripAgentSessionMarker,
} from '../../apps/web/src/agent/card';

test('共享 Agent 状态卡可由官方客户端阅读并由 RocketX 解析租约', () => {
  const card = {
    version: 1 as const,
    sessionId: 'session-1',
    rid: 'room-general',
    tmid: 'thread-1',
    roomNameSnapshot: '研发讨论',
    hostUserId: 'user-1',
    hostUsername: 'alice',
    hostDeviceId: 'device-1',
    leaseExpiresAt: 1_800_000_000_000,
    status: 'active' as const,
    environmentName: '火箭项目',
    currentTaskLabel: '检查原版客户端显示',
  };
  const rendered = renderAgentSessionCard(card);
  assert.match(rendered, /AI 托管已开启/);
  assert.match(rendered, /@alice/);
  assert.match(rendered, /房间成员：使用 `@ai` 提问/);
  assert.doesNotMatch(rendered, /<!--|rocketx-agent|%22|hostDeviceId/);
  assert.deepEqual(parseAgentSessionCard(rendered), card);
  const visible = stripAgentSessionMarker(rendered);
  const officialClientVisible = rendered.replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  assert.equal(officialClientVisible, visible);
  assert.match(visible, /AI 托管已开启/);
  assert.doesNotMatch(visible, /rocketx-agent|hostDeviceId|%22/);
});

test('共享 Agent 状态卡对房间成员隐藏 provider，但保留后端信息', () => {
  const card = {
    version: 1 as const,
    sessionId: 'session-2',
    tmid: 'thread-2',
    hostUserId: 'user-2',
    hostUsername: 'bob',
    hostDeviceId: 'device-2',
    leaseExpiresAt: 1_800_000_000_000,
    status: 'active' as const,
    backend: 'deepseek' as const,
  };
  const rendered = renderAgentSessionCard(card);
  const visible = stripAgentSessionMarker(rendered);
  assert.match(visible, /AI 管家会话控制/);
  assert.doesNotMatch(visible, /Codex|DeepSeek/);
  assert.deepEqual(parseAgentSessionCard(rendered), card);
});

test('共享 Agent 状态卡携带全局托管总览所需的房间、项目和当前任务快照', () => {
  const card = {
    version: 1 as const,
    sessionId: 'session-overview',
    rid: 'room-general',
    tmid: 'room:room-general',
    roomNameSnapshot: 'General',
    hostUserId: 'user-1',
    hostUsername: 'alice',
    hostDeviceId: 'device-1',
    leaseExpiresAt: 1_800_000_000_000,
    status: 'active' as const,
    backend: 'deepseek' as const,
    environmentName: 'RocketX',
    currentTaskLabel: '检查发布门禁',
  };

  assert.deepEqual(parseAgentSessionCard(renderAgentSessionCard(card)), card);
});

test('Discussion 顶层状态卡按 room 会话键匹配，不依赖消息 tmid', () => {
  const card = {
    version: 1 as const,
    sessionId: 'session-room',
    tmid: 'room:discussion-128',
    hostUserId: 'user-1',
    hostUsername: 'alice',
    hostDeviceId: 'device-1',
    leaseExpiresAt: 1_800_000_000_000,
    status: 'active' as const,
  };
  assert.equal(agentSessionCardMatchesMessage(card, { rid: 'discussion-128' }), true);
  assert.equal(agentSessionCardMatchesMessage(card, { rid: 'other-room' }), false);
  assert.equal(agentSessionCardMatchesMessage({ ...card, tmid: 'thread-1' }, { rid: 'discussion-128', tmid: 'thread-1' }), true);
});

test('伪造或损坏的状态卡不被解析', () => {
  assert.equal(parseAgentSessionCard('普通消息'), null);
  assert.equal(parseAgentSessionCard('<!--rocketx-agent:%7Bbad-->'), null);
  assert.equal(parseAgentSessionCard('<!--rocketx-agent:%7B%22version%22%3A2%7D-->'), null);
});

test('旧共享 Agent 状态卡缺少 backend 时仍按 Codex 兼容解析', () => {
  const encoded = encodeURIComponent(JSON.stringify({
    version: 1,
    sessionId: 'legacy-session',
    tmid: 'thread-legacy',
    hostUserId: 'user-legacy',
    hostUsername: 'alice',
    hostDeviceId: 'device-legacy',
    leaseExpiresAt: 1_800_000_000_000,
    status: 'active',
  }));
  const legacy = `🤖 **AI 托管已开启**\n<!--rocketx-agent:${encoded}-->`;
  assert.deepEqual(parseAgentSessionCard(legacy), {
    version: 1,
    sessionId: 'legacy-session',
    tmid: 'thread-legacy',
    hostUserId: 'user-legacy',
    hostUsername: 'alice',
    hostDeviceId: 'device-legacy',
    leaseExpiresAt: 1_800_000_000_000,
    status: 'active',
  });
  assert.equal(stripAgentSessionMarker(legacy), '🤖 **AI 托管已开启**');
});
