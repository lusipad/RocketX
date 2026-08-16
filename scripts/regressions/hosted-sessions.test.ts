import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSessionCard } from '../../apps/web/src/agent/card';
import type { AgentSession } from '../../apps/web/src/agent/session';
import { hostedSessionItems } from '../../apps/web/src/lib/hostedSessions';

const NOW = 10_000;
const KEY = 'room:general';

function localSession(status: AgentSession['status'], expiresAt: number): AgentSession {
  return {
    sessionId: 'local-session',
    serverId: 'same-origin',
    ownerUserId: 'host-user',
    rid: 'general',
    tmid: KEY,
    host: { userId: 'host-user', deviceId: 'local-device', heartbeatAt: NOW - 1_000, expiresAt },
    access: 'room-members',
    approvedMemberIds: [],
    status,
    backend: 'codex',
    codexThreadId: 'local-thread',
    workspaceRoots: ['D:/Repos/local'],
    updatedAt: NOW - 1_000,
  };
}

function remoteCard(leaseExpiresAt: number): AgentSessionCard {
  return {
    version: 1,
    sessionId: 'remote-session',
    rid: 'general',
    tmid: KEY,
    hostUserId: 'remote-user',
    hostUsername: 'alice',
    hostDeviceId: 'remote-device',
    leaseExpiresAt,
    status: 'active',
    backend: 'deepseek',
    environmentName: 'Remote project',
  };
}

test('有效远端租约优先于本机中断或过期的同 key 会话', () => {
  for (const local of [
    localSession('interrupted', NOW + 60_000),
    localSession('ready', NOW - 1),
  ]) {
    const [item] = hostedSessionItems({ [KEY]: local }, { [KEY]: remoteCard(NOW + 60_000) }, NOW);
    assert.equal(item.local, undefined);
    assert.equal(item.remote?.sessionId, 'remote-session');
    assert.equal(item.backend, 'deepseek');
    assert.equal(item.status, 'running');
  }
});

test('远端租约到期后不再显示为正在工作，本机有效宿主仍保持权威', () => {
  const expiredOnly = hostedSessionItems({}, { [KEY]: remoteCard(NOW - 1) }, NOW)[0];
  assert.equal(expiredOnly.status, 'interrupted');

  const local = localSession('ready', NOW + 60_000);
  const [localWins] = hostedSessionItems({ [KEY]: local }, { [KEY]: remoteCard(NOW + 120_000) }, NOW);
  assert.equal(localWins.local?.sessionId, 'local-session');
  assert.equal(localWins.remote, undefined);

  const [remoteTakesOver] = hostedSessionItems(
    { [KEY]: local },
    { [KEY]: remoteCard(NOW + 120_000) },
    NOW + 60_001,
  );
  assert.equal(remoteTakesOver.remote?.sessionId, 'remote-session');
});

test('两台设备同时持有有效声明时按稳定 claim 只选出一个宿主', () => {
  const local = localSession('running', NOW + 60_000);
  const lowerRemote = { ...remoteCard(NOW + 60_000), hostDeviceId: 'aaa-remote' };
  const higherRemote = { ...remoteCard(NOW + 60_000), hostDeviceId: 'zzz-remote' };

  assert.equal(
    hostedSessionItems({ [KEY]: local }, { [KEY]: lowerRemote }, NOW)[0].remote?.hostDeviceId,
    'aaa-remote',
  );
  assert.equal(
    hostedSessionItems({ [KEY]: local }, { [KEY]: higherRemote }, NOW)[0].local?.sessionId,
    'local-session',
  );
});
