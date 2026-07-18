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
    tmid: 'thread-1',
    hostUserId: 'user-1',
    hostUsername: 'alice',
    hostDeviceId: 'device-1',
    leaseExpiresAt: 1_800_000_000_000,
    status: 'active' as const,
  };
  const rendered = renderAgentSessionCard(card);
  assert.match(rendered, /AI 托管已开启/);
  assert.match(rendered, /@alice/);
  assert.match(rendered, /房间成员：使用 `@ai` 提问/);
  assert.deepEqual(parseAgentSessionCard(rendered), card);
  const visible = stripAgentSessionMarker(rendered);
  assert.match(visible, /AI 托管已开启/);
  assert.doesNotMatch(visible, /rocketx-agent|hostDeviceId|%22/);
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
