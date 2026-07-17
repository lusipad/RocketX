import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentSessionCard, renderAgentSessionCard } from '../../apps/web/src/agent/card';

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
  assert.match(rendered, /Codex 共享会话/);
  assert.match(rendered, /@alice/);
  assert.deepEqual(parseAgentSessionCard(rendered), card);
});

test('伪造或损坏的状态卡不被解析', () => {
  assert.equal(parseAgentSessionCard('普通消息'), null);
  assert.equal(parseAgentSessionCard('<!--rocketx-agent:%7Bbad-->'), null);
  assert.equal(parseAgentSessionCard('<!--rocketx-agent:%7B%22version%22%3A2%7D-->'), null);
});
