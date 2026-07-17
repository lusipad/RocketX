export type AgentSessionStatus =
  | 'starting'
  | 'ready'
  | 'running'
  | 'waiting-approval'
  | 'interrupted'
  | 'ended';

export interface AgentHostLease {
  userId: string;
  deviceId: string;
  heartbeatAt: number;
  expiresAt: number;
}

export interface AgentCommand {
  messageId: string;
  userId: string;
  username: string;
  text: string;
  createdAt: number;
}

export interface AgentSession {
  sessionId: string;
  serverId: string;
  ownerUserId: string;
  rid: string;
  tmid: string;
  host: AgentHostLease;
  access: 'room-members' | 'host-only';
  approvedMemberIds: string[];
  status: AgentSessionStatus;
  codexThreadId?: string;
  leaseMessageId?: string;
  activeTurnId?: string;
  workspaceRoots: string[];
  sandboxMode: 'read-only' | 'workspace-write';
  updatedAt: number;
}

export type CommandAccess = 'allowed' | 'requires-host-approval' | 'denied';

export function leaseIsActive(session: AgentSession, now = Date.now()): boolean {
  return session.status !== 'ended' && session.host.expiresAt > now;
}

export function takeHostLease(
  session: AgentSession,
  host: Pick<AgentHostLease, 'userId' | 'deviceId'>,
  now: number,
  leaseMs: number,
): AgentSession {
  if (leaseMs <= 0) throw new Error('宿主租约时长必须大于 0');
  if (
    leaseIsActive(session, now) &&
    (session.host.userId !== host.userId || session.host.deviceId !== host.deviceId)
  ) {
    throw new Error('该 Agent 会话已有活跃宿主，请等待租约超时后接管');
  }
  return {
    ...session,
    host: { ...host, heartbeatAt: now, expiresAt: now + leaseMs },
    status: session.status === 'ended' ? 'starting' : session.status,
    updatedAt: now,
  };
}

export function commandAccess(session: AgentSession, userId: string): CommandAccess {
  if (session.status === 'ended') return 'denied';
  if (userId === session.host.userId) return 'allowed';
  if (session.access === 'host-only') return 'denied';
  return session.approvedMemberIds.includes(userId) ? 'allowed' : 'requires-host-approval';
}

export function approveMember(
  session: AgentSession,
  actor: Pick<AgentHostLease, 'userId' | 'deviceId'>,
  memberId: string,
  now = Date.now(),
): AgentSession {
  assertHost(session, actor, now);
  if (!memberId) throw new Error('成员 ID 不能为空');
  if (session.approvedMemberIds.includes(memberId)) return session;
  return {
    ...session,
    approvedMemberIds: [...session.approvedMemberIds, memberId],
    updatedAt: now,
  };
}

export function assertHost(
  session: AgentSession,
  actor: Pick<AgentHostLease, 'userId' | 'deviceId'>,
  now = Date.now(),
): void {
  if (
    !leaseIsActive(session, now) ||
    actor.userId !== session.host.userId ||
    actor.deviceId !== session.host.deviceId
  ) {
    throw new Error('只有当前宿主设备可以审批 Agent 请求');
  }
}

export function interruptSession(session: AgentSession, now = Date.now()): AgentSession {
  if (session.status === 'ended') return session;
  return { ...session, status: 'interrupted', activeTurnId: undefined, updatedAt: now };
}

export function restoreSession(
  session: AgentSession,
  now: number,
  orphanTimeoutMs: number,
): AgentSession {
  if (session.status === 'ended') return session;
  if (now >= session.host.expiresAt + orphanTimeoutMs) {
    return { ...session, status: 'ended', activeTurnId: undefined, updatedAt: now };
  }
  return interruptSession(session, now);
}

export function resumeSession(
  session: AgentSession,
  actor: Pick<AgentHostLease, 'userId' | 'deviceId'>,
  now = Date.now(),
): AgentSession {
  assertHost(session, actor, now);
  if (!session.codexThreadId) throw new Error('缺少可恢复的 Codex threadId');
  if (session.status !== 'interrupted') throw new Error('只有已中断会话可以恢复');
  return { ...session, status: 'starting', updatedAt: now };
}

export class SerialCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  get size(): number {
    return this.queued;
  }

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.queued -= 1;
    });
  }
}
