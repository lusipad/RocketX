import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SerialCommandQueue,
  approveMember,
  assertHost,
  commandAccess,
  interruptSession,
  restoreSession,
  resumeSession,
  takeHostLease,
  type AgentSession,
} from '../../apps/web/src/agent/session';
import {
  assertAllowedWorkspacePath,
  commandMentionsSensitivePath,
  commandRequestMentionsSensitivePath,
  pathIsSensitive,
  permissionRequestSummary,
  redactAgentOutput,
  validateApprovalPaths,
  validatePermissionRequest,
} from '../../apps/web/src/agent/safety';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 'session-1',
    serverId: 'https://chat.example',
    ownerUserId: 'host',
    rid: 'room-1',
    tmid: 'thread-1',
    host: { userId: 'host', deviceId: 'device-a', heartbeatAt: 900, expiresAt: 2_000 },
    access: 'room-members',
    approvedMemberIds: [],
    status: 'ready',
    workspaceRoots: ['C:/work/repo'],
    sandboxMode: 'read-only',
    updatedAt: 900,
    ...overrides,
  };
}

test('活跃租约拒绝另一设备抢占，超时后可接管', () => {
  assert.throws(
    () => takeHostLease(session(), { userId: 'host', deviceId: 'device-b' }, 1_000, 30_000),
    /已有活跃宿主/,
  );
  const taken = takeHostLease(session(), { userId: 'other', deviceId: 'device-b' }, 2_001, 30_000);
  assert.equal(taken.host.userId, 'other');
  assert.equal(taken.host.expiresAt, 32_001);
});

test('非宿主首次指挥需放行，仅宿主设备可放行和审批', () => {
  const value = session();
  assert.equal(commandAccess(value, 'member'), 'requires-host-approval');
  assert.throws(
    () => approveMember(value, { userId: 'host', deviceId: 'wrong-device' }, 'member', 1_000),
    /只有当前宿主设备/,
  );
  const approved = approveMember(value, { userId: 'host', deviceId: 'device-a' }, 'member', 1_000);
  assert.equal(commandAccess(approved, 'member'), 'allowed');
  assert.doesNotThrow(() => assertHost(approved, { userId: 'host', deviceId: 'device-a' }, 1_000));
  assert.equal(commandAccess({ ...approved, access: 'host-only' }, 'another'), 'denied');
});

test('工作项 Discussion 默认允许房间成员提问，但宿主仍掌握执行审批', () => {
  assert.equal(commandAccess(session({ tmid: 'room:discussion-128' }), 'member'), 'allowed');
  assert.equal(commandAccess(session({ tmid: 'room:discussion-128', access: 'host-only' }), 'member'), 'denied');
});

test('共享 Agent 自动复用现有 Codex 模型和推理强度设置', () => {
  const source = readFileSync('apps/web/src/stores/sharedAgent.ts', 'utf8');
  assert.match(source, /getButlerCodexSettings\(\)/);
  assert.match(source, /codexSettings\.model \? \{ model: codexSettings\.model \}/);
  assert.match(source, /codexSettings\.effort === 'default' \? \{\} : \{ effort: codexSettings\.effort \}/);
});

test('中断会话保留 threadId，只有原宿主可进入恢复态', () => {
  const interrupted = interruptSession(session({ codexThreadId: 'codex-thread', activeTurnId: 'turn' }), 1_100);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.activeTurnId, undefined);
  const resumed = resumeSession(interrupted, { userId: 'host', deviceId: 'device-a' }, 1_200);
  assert.equal(resumed.status, 'starting');
  assert.equal(resumed.codexThreadId, 'codex-thread');
});

test('恢复时标记中断，超过孤儿超时则自动结束', () => {
  const value = session({ codexThreadId: 'codex-thread', activeTurnId: 'turn' });
  assert.equal(restoreSession(value, 2_500, 10_000).status, 'interrupted');
  const ended = restoreSession(value, 12_000, 10_000);
  assert.equal(ended.status, 'ended');
  assert.equal(ended.activeTurnId, undefined);
});

test('指令队列严格串行，失败不会阻断后一条', async () => {
  const queue = new SerialCommandQueue();
  const order: string[] = [];
  let release!: () => void;
  const first = queue.enqueue(
    () =>
      new Promise<void>((resolve) => {
        order.push('first-start');
        release = () => {
          order.push('first-end');
          resolve();
        };
      }),
  );
  const second = queue.enqueue(async () => {
    order.push('second');
    throw new Error('expected');
  });
  const third = queue.enqueue(async () => order.push('third'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  release();
  await first;
  await assert.rejects(() => second, /expected/);
  await third;
  assert.deepEqual(order, ['first-start', 'first-end', 'second', 'third']);
  assert.equal(queue.size, 0);
});

test('工作区白名单拒绝越界和敏感文件', () => {
  assert.doesNotThrow(() => assertAllowedWorkspacePath('C:/work/repo/src/main.ts', ['C:/work/repo']));
  assert.throws(() => assertAllowedWorkspacePath('C:/work/repository/secret.txt', ['C:/work/repo']), /白名单/);
  assert.throws(() => assertAllowedWorkspacePath('C:/work/repo/.env', ['C:/work/repo']), /敏感路径/);
  assert.equal(pathIsSensitive('C:\\Users\\me\\.ssh\\id_ed25519'), true);
  assert.equal(commandMentionsSensitivePath('type .env'), true);
  assert.equal(commandMentionsSensitivePath('git diff src/environment.ts'), false);
  assert.equal(commandRequestMentionsSensitivePath(['cmd', '/c', 'type', '.env']), true);
});

test('回帖前脱敏常见密钥、Bearer、JWT 和键值凭据', () => {
  const source = [
    `sk-${'1234567890abcdef'.repeat(2)}`,
    'Bearer abcdefghijklmnopqrstuvwxyz',
    'eyJabcdefgh.abcdefghijkl.abcdefghijkl',
    'password: super-secret-value',
  ].join('\n');
  const result = redactAgentOutput(source);
  assert.equal(result.redacted, 4);
  assert.equal(result.text.includes('super-secret-value'), false);
  assert.equal(result.text.includes('sk-1234'), false);
});

test('增量权限只允许工作区内明确路径并拒绝网络与敏感文件', () => {
  const requested = {
    network: null,
    fileSystem: {
      read: null,
      write: ['/workspace/approved.txt'],
      entries: [{ path: { type: 'path' as const, path: '/workspace/approved.txt' }, access: 'write' as const }],
    },
  };
  assert.deepEqual(validatePermissionRequest(requested, ['/workspace']), { fileSystem: requested.fileSystem });
  assert.deepEqual(permissionRequestSummary(requested), ['写入：/workspace/approved.txt']);
  assert.throws(
    () => validatePermissionRequest({ network: { enabled: true }, fileSystem: null }, ['/workspace']),
    /网络访问/,
  );
  assert.throws(
    () =>
      validatePermissionRequest(
        { network: null, fileSystem: { read: null, write: ['/workspace/.env'] } },
        ['/workspace'],
      ),
    /敏感路径/,
  );
  assert.throws(
    () =>
      validatePermissionRequest(
        { network: null, fileSystem: { read: null, write: ['/outside/file.txt'] } },
        ['/workspace'],
      ),
    /白名单/,
  );
  assert.doesNotThrow(() =>
    validateApprovalPaths({ cwd: '/workspace', fileChanges: { '/workspace/src/main.ts': true } }, ['/workspace']),
  );
  assert.throws(
    () => validateApprovalPaths({ grantRoot: '/home/node/.codex' }, ['/workspace']),
    /白名单/,
  );
  assert.throws(
    () => validateApprovalPaths({ fileChanges: { '/workspace/.env': true } }, ['/workspace']),
    /敏感路径/,
  );
});
