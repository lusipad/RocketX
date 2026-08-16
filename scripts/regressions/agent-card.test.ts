import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentSessionCardAuthority,
  agentSessionLeaseCustomFields,
  createAgentSessionLeaseMessageId,
  isAgentSessionLeaseMessageId,
  agentSessionCardSupersedesLocal,
  agentSessionCardMatchesMessage,
  parseAgentSessionCard,
  renderAgentSessionCard,
  stripAgentSessionMarker,
} from '../../apps/web/src/agent/card';

function leaseMessage(input: {
  id: string;
  rid: string;
  tmid?: string;
  userId: string;
  username: string;
  customFields?: Record<string, unknown>;
}) {
  return {
    _id: input.id,
    rid: input.rid,
    ...(input.tmid ? { tmid: input.tmid } : {}),
    u: { _id: input.userId, username: input.username },
    ...(input.customFields ? { customFields: input.customFields } : {}),
  };
}

function historicalInvisibleMarker(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const payload = Array.from(bytes, (byte) =>
    String.fromCodePoint(byte < 16 ? 0xfe00 + byte : 0xe0100 + byte - 16),
  ).join('');
  return `\u2063\u2063${payload}\u2063`;
}

test('共享 Agent 状态卡可由官方客户端阅读并由 RocketX 解析租约', () => {
  const card = {
    version: 1 as const,
    sessionId: 'session-1',
    rid: 'room-general',
    tmid: 'thread-1',
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
  assert.deepEqual(parseAgentSessionCard(rendered, leaseMessage({
    id: 'lease-message-1',
    rid: 'room-general',
    tmid: 'thread-1',
    userId: 'user-1',
    username: 'alice',
  })), {
    ...card,
    sessionId: 'lease-message-1',
    claimId: 'lease-message-1',
    hostDeviceId: 'lease-message-1',
    backend: 'codex',
  });
  const visible = stripAgentSessionMarker(rendered);
  assert.equal(rendered, visible);
  assert.doesNotMatch(rendered, /\p{Default_Ignorable_Code_Point}/u);
  assert.match(visible, /AI 托管已开启/);
  assert.doesNotMatch(visible, /rocketx-agent|hostDeviceId|%22/);
});

test('RocketX 专用租约消息 id 必须同时满足前缀和校验', () => {
  const messageId = createAgentSessionLeaseMessageId();
  assert.equal(isAgentSessionLeaseMessageId(messageId), true);
  assert.equal(isAgentSessionLeaseMessageId(`plain${messageId.slice(5)}`), false);
  assert.equal(isAgentSessionLeaseMessageId(`${messageId.slice(0, 16)}2`), false);
});

test('纯可见状态卡默认只展示不仲裁，专用租约消息 id 或 customFields 才可信', () => {
  const card = {
    version: 1 as const,
    sessionId: 'session-authority',
    rid: 'room-general',
    tmid: 'thread-authority',
    hostUserId: 'user-1',
    hostUsername: 'alice',
    hostDeviceId: 'device-1',
    leaseExpiresAt: 1_800_000_000_000,
    status: 'active' as const,
    backend: 'deepseek' as const,
    environmentName: 'RocketX',
    currentTaskLabel: '检查权威边界',
  };
  const rendered = renderAgentSessionCard(card);
  const plainVisible = leaseMessage({
    id: 'plain-visible-message',
    rid: 'room-general',
    tmid: 'thread-authority',
    userId: 'user-1',
    username: 'alice',
  });
  assert.equal(agentSessionCardAuthority(rendered, plainVisible), 'visible');
  assert.equal(agentSessionCardAuthority(rendered, {
    ...plainVisible,
    _id: createAgentSessionLeaseMessageId(),
  }), 'lease-message-id');
  assert.equal(agentSessionCardAuthority(rendered, leaseMessage({
    id: 'plain-message-with-metadata',
    rid: 'room-general',
    tmid: 'thread-authority',
    userId: 'user-1',
    username: 'alice',
    customFields: agentSessionLeaseCustomFields(card),
  })), 'custom-fields');
  assert.deepEqual(parseAgentSessionCard(rendered, leaseMessage({
    id: 'plain-message-with-metadata',
    rid: 'room-general',
    tmid: 'thread-authority',
    userId: 'user-1',
    username: 'alice',
    customFields: agentSessionLeaseCustomFields(card),
  })), {
    ...card,
    claimId: 'plain-message-with-metadata',
    hostDeviceId: 'plain-message-with-metadata',
  });
});

test('共享 Agent 状态卡用稳定可读字段向所有客户端展示执行引擎', () => {
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
  assert.match(visible, /^执行引擎：DeepSeek$/mu);
  assert.deepEqual(parseAgentSessionCard(rendered, leaseMessage({
    id: 'lease-message-2',
    rid: 'room-2',
    tmid: 'thread-2',
    userId: 'user-2',
    username: 'bob',
  })), {
    ...card,
    sessionId: 'lease-message-2',
    claimId: 'lease-message-2',
    rid: 'room-2',
    hostDeviceId: 'lease-message-2',
    environmentName: '未指定项目',
    currentTaskLabel: '等待房间指令',
  });
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

  const parsed = parseAgentSessionCard(renderAgentSessionCard(card), leaseMessage({
    id: 'lease-overview',
    rid: 'room-general',
    userId: 'user-1',
    username: 'alice',
  }));
  assert.equal(parsed?.environmentName, 'RocketX');
  assert.equal(parsed?.currentTaskLabel, '检查发布门禁');
  assert.equal(parsed?.backend, 'deepseek');
  assert.equal(parsed?.sessionId, 'lease-overview');
  assert.equal(parsed?.tmid, 'room:room-general');
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
  assert.equal(parseAgentSessionCard('🤖 **AI 托管已开启**', leaseMessage({
    id: 'broken-card',
    rid: 'room-broken',
    userId: 'user-1',
    username: 'alice',
  })), null);
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
  assert.equal(agentSessionCardAuthority(legacy), 'legacy-marker');
});

test('短暂使用过的隐形状态标记只读兼容，新的状态卡不再写入', () => {
  const card = {
    version: 1 as const,
    sessionId: 'historical-session',
    rid: 'historical-room',
    tmid: 'room:historical-room',
    hostUserId: 'historical-user',
    hostUsername: 'alice',
    hostDeviceId: 'historical-device',
    leaseExpiresAt: 1_800_000_000_000,
    status: 'active' as const,
    backend: 'deepseek' as const,
  };
  const historical = `🤖 **AI 托管已开启**${historicalInvisibleMarker(card)}`;
  assert.deepEqual(parseAgentSessionCard(historical), card);
  assert.equal(stripAgentSessionMarker(historical), '🤖 **AI 托管已开启**');
  assert.doesNotMatch(renderAgentSessionCard(card), /\p{Default_Ignorable_Code_Point}/u);
  assert.equal(agentSessionCardAuthority(historical), 'legacy-marker');
});

test('消息 ID 作为租约 claim 时两个设备会选出同一个赢家', () => {
  const now = 1_800_000_000_000;
  const local = {
    sessionId: 'native-local-session',
    serverId: 'same-origin',
    tmid: 'room:general',
    rid: 'general',
    workspaceRoots: ['C:/workspace'],
    ownerUserId: 'user-local',
    host: { userId: 'user-local', deviceId: 'device-local', heartbeatAt: now, expiresAt: now + 60_000 },
    access: 'room-members' as const,
    approvedMemberIds: [],
    leaseMessageId: 'lease-b',
    status: 'ready' as const,
    updatedAt: now,
  };
  const remote = {
    version: 1 as const,
    sessionId: 'lease-a',
    claimId: 'lease-a',
    tmid: 'room:general',
    hostUserId: 'user-remote',
    hostUsername: 'bob',
    hostDeviceId: 'lease-a',
    leaseExpiresAt: now + 60_000,
    status: 'active' as const,
  };
  assert.equal(agentSessionCardSupersedesLocal(local, remote, now), true);
  assert.equal(agentSessionCardSupersedesLocal(
    { ...local, leaseMessageId: 'lease-a' },
    { ...remote, sessionId: 'lease-b', claimId: 'lease-b', hostDeviceId: 'lease-b' },
    now,
  ), false);
});
