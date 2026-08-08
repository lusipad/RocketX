import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppServerClient,
} from '../apps/web/src/agent/protocol';
import {
  codexInvocation,
  codexRuntimeSourceFromArgs,
  NodeCodexTransport,
  removeSpikeTempRoot,
  type CodexInvocation,
} from './lib/codex-app-server-spike';

type Notification = { method: string; params: unknown };
type NotificationPredicate = (params: unknown) => boolean;

class NotificationLog {
  readonly entries: Notification[] = [];
  private readonly waiters: Array<{
    method: string;
    predicate: NotificationPredicate;
    resolve: (params: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  push(method: string, params: unknown): void {
    const entry = { method, params };
    this.entries.push(entry);
    const index = this.waiters.findIndex(
      (waiter) => waiter.method === method && waiter.predicate(params),
    );
    if (index < 0) return;
    const waiter = this.waiters.splice(index, 1)[0];
    clearTimeout(waiter.timer);
    waiter.resolve(params);
  }

  wait(
    method: string,
    predicate: NotificationPredicate,
    timeoutMs = 90_000,
  ): Promise<unknown> {
    const existing = this.entries.find(
      (entry) => entry.method === method && predicate(entry.params),
    );
    if (existing) return Promise.resolve(existing.params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`等待 Codex 通知超时：${method}`));
      }, timeoutMs);
      timer.unref();
      this.waiters.push({ method, predicate, resolve, reject, timer });
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function turnIdFromNotification(params: unknown): string | undefined {
  const turn = record(record(params).turn);
  return typeof turn.id === 'string' ? turn.id : undefined;
}

function turnStatusFromNotification(params: unknown): string | undefined {
  const turn = record(record(params).turn);
  return typeof turn.status === 'string' ? turn.status : undefined;
}

function turnStartParams(
  threadId: string,
  workspace: string,
  text: string,
): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
    cwd: workspace,
    runtimeWorkspaceRoots: [workspace],
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  };
}

function threadParams(workspace: string): Record<string, unknown> {
  return {
    cwd: workspace,
    runtimeWorkspaceRoots: [workspace],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    developerInstructions: [
      '这是 RocketX 的真实生命周期验收。',
      '不得调用工具、访问网络、修改文件或等待用户输入。',
      '只处理测试发送的文本消息。',
    ].join('\n'),
  };
}

function createClient(
  workspace: string,
  invocation: CodexInvocation,
  log: NotificationLog,
  onInterrupted: (error: Error) => void,
): { client: AppServerClient; transport: NodeCodexTransport } {
  const transport = new NodeCodexTransport(workspace, invocation);
  const client = new AppServerClient(transport, {
    onNotification: (method, params) => log.push(method, params),
    onInterrupted,
  });
  return { client, transport };
}

async function archiveThread(
  client: AppServerClient | undefined,
  threadId: string | undefined,
): Promise<boolean> {
  if (!client || !threadId) return false;
  try {
    await client.request('thread/archive', { threadId });
    return true;
  } catch {
    return false;
  }
}

async function interruptActiveTurn(
  client: AppServerClient,
  log: NotificationLog,
  threadId: string,
  initialRead: Awaited<ReturnType<AppServerClient['request']>> & { thread: { turns: Array<{ id: string; status: string }> } },
): Promise<{ id: string; status: string | undefined } | undefined> {
  let read = initialRead;
  const attemptedIds: string[] = [];
  let lastError = '';
  let nextActiveTurnId: string | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const activeTurn = read.thread.turns.find((turn) => turn.status === 'inProgress');
    const activeTurnId = nextActiveTurnId ?? activeTurn?.id;
    if (!activeTurnId) return undefined;
    nextActiveTurnId = undefined;
    attemptedIds.push(activeTurnId);
    try {
      await client.request('turn/interrupt', { threadId, turnId: activeTurnId });
    } catch (error) {
      if (!(error instanceof Error) || !/expected active turn id/i.test(error.message)) throw error;
      lastError = error.message;
      nextActiveTurnId = /found ([0-9a-f-]+)/i.exec(error.message)?.[1];
      read = await client.request('thread/read', { threadId, includeTurns: true });
      continue;
    }
    const completedParams = await log.wait(
      'turn/completed',
      (params) => record(params).threadId === threadId
        && turnIdFromNotification(params) === activeTurnId,
    );
    return { id: activeTurnId, status: turnStatusFromNotification(completedParams) };
  }
  throw new Error(`无法稳定中断恢复期间自动启动的 Codex turn：${attemptedIds.join(',')}；${lastError}`);
}

async function main(): Promise<void> {
  const runtimeSource = codexRuntimeSourceFromArgs();
  const invocation = codexInvocation(runtimeSource);
  const tempRoot = await mkdtemp(join(tmpdir(), 'rocketx-codex-lifecycle-'));
  const workspace = join(tempRoot, 'workspace');
  await mkdir(workspace);

  const firstLog = new NotificationLog();
  const secondLog = new NotificationLog();
  let interruptedError: Error | undefined;
  let resolveInterrupted: ((error: Error) => void) | undefined;
  const interrupted = new Promise<Error>((resolve) => {
    resolveInterrupted = resolve;
  });
  const first = createClient(workspace, invocation, firstLog, (error) => {
    interruptedError = error;
    resolveInterrupted?.(error);
  });
  let second: ReturnType<typeof createClient> | undefined;
  let threadId: string | undefined;
  let archived = false;

  const report: Record<string, unknown> = {
    runtime: {
      source: runtimeSource,
      version: invocation.version,
      path: invocation.displayPath,
    },
    workspace,
  };

  try {
    const firstProcess = await first.client.start();
    report.firstProcessId = firstProcess.processId;
    const startedThread = await first.client.request('thread/start', {
      ...threadParams(workspace),
      ephemeral: false,
    });
    threadId = startedThread.thread.id;
    report.threadId = threadId;
    const goal = await first.client.request('thread/goal/set', {
      threadId,
      objective: '完成一次不产生外部副作用的生命周期验收',
      status: 'active',
    });
    report.goalCreated = {
      threadId: goal.goal.threadId,
      status: goal.goal.status,
      objective: goal.goal.objective,
    };

    const firstTurnStarted = firstLog.wait(
      'turn/started',
      (params) => record(params).threadId === threadId,
    );
    const firstTurnRequest = first.client.request(
      'turn/start',
      turnStartParams(threadId, workspace, '开始验收。不要使用工具，只保持本轮可恢复。'),
    ).catch(() => undefined);
    const firstStartedParams = await firstTurnStarted;
    const firstTurnId = turnIdFromNotification(firstStartedParams);
    assert.ok(firstTurnId, 'turn/started 缺少首个 turn.id');
    await first.transport.terminateUnexpectedly();
    await firstTurnRequest;
    const interruption = await Promise.race([
      interrupted,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 app-server 中断通知超时')), 10_000);
        timer.unref();
      }),
    ]);
    assert.match(interruption.message, /Codex app-server 已退出/);
    report.interruption = {
      observed: true,
      message: interruptedError?.message,
      firstTurnId,
    };
    await first.client.stop();

    const secondInterrupted: Error[] = [];
    second = createClient(workspace, invocation, secondLog, (error) => {
      secondInterrupted.push(error);
    });
    const secondProcess = await second.client.start();
    report.secondProcessId = secondProcess.processId;
    const resumed = await second.client.request('thread/resume', {
      threadId,
      ...threadParams(workspace),
      excludeTurns: false,
    });
    assert.equal(resumed.thread.id, threadId, 'resume 返回了不同的 thread.id');
    const resumedGoal = await second.client.request('thread/goal/get', { threadId });
    assert.ok(resumedGoal.goal, 'resume 后没有恢复 Goal');
    assert.equal(resumedGoal.goal.threadId, threadId);
    assert.equal(resumedGoal.goal.objective, '完成一次不产生外部副作用的生命周期验收');
    await second.client.request('thread/goal/set', { threadId, status: 'paused' });
    const beforeContinuation = await second.client.request('thread/read', {
      threadId,
      includeTurns: true,
    });
    const oldTurn = beforeContinuation.thread.turns.find((turn) => turn.id === firstTurnId);
    assert.ok(oldTurn, 'resume 后 thread/read 没有首个 turn');
    const automaticTurnStarts = second.transport.outbound.filter(
      (message) => message.method === 'turn/start',
    );
    assert.equal(automaticTurnStarts.length, 0, 'resume 自动重放了 turn');

    const serverResumeTurnIds = [
      ...new Set(
        secondLog.entries
          .filter((entry) => entry.method === 'turn/started')
          .map((entry) => record(entry.params))
          .filter((params) => params.threadId === threadId)
          .map((params) => turnIdFromNotification(params))
          .filter((id): id is string => !!id && id !== firstTurnId),
      ),
    ];
    const interruptedResumeTurn = await interruptActiveTurn(
      second.client,
      secondLog,
      threadId,
      beforeContinuation as Awaited<ReturnType<AppServerClient['request']>> & {
        thread: { turns: Array<{ id: string; status: string }> };
      },
    );
    if (interruptedResumeTurn) assert.equal(interruptedResumeTurn.status, 'interrupted');

    const continuationResponse = await second.client.request(
      'turn/start',
      turnStartParams(threadId, workspace, '这是唯一一次显式续跑。只回复 RCX_LIFECYCLE_OK。'),
    );
    const continuationStartedParams = await secondLog.wait(
      'turn/started',
      (params) => record(params).threadId === threadId
        && turnIdFromNotification(params) === continuationResponse.turn.id,
    );
    const continuationTurnId = turnIdFromNotification(continuationStartedParams);
    assert.equal(continuationResponse.turn.id, continuationTurnId);
    const completedParams = await secondLog.wait(
      'turn/completed',
      (params) => record(params).threadId === threadId
        && turnIdFromNotification(params) === continuationTurnId,
    );
    const continuationStatus = turnStatusFromNotification(completedParams);
    assert.ok(continuationStatus && continuationStatus !== 'inProgress');
    const afterContinuation = await second.client.request('thread/read', {
      threadId,
      includeTurns: true,
    });
    const newTurn = afterContinuation.thread.turns.find((turn) => turn.id === continuationTurnId);
    assert.ok(newTurn, 'thread/read 没有唯一显式续跑 turn');
    assert.equal(
      second.transport.outbound.filter((message) => message.method === 'turn/start').length,
      1,
      '第二进程不应额外自动启动 turn',
    );
    report.goalRecovered = {
      threadId: resumedGoal.goal.threadId,
      status: resumedGoal.goal.status,
      objective: resumedGoal.goal.objective,
    };
    report.turns = {
      oldTurn: { id: oldTurn.id, status: oldTurn.status },
      explicitContinuation: { id: newTurn.id, status: newTurn.status },
      automaticContinuationCount: 0,
      explicitContinuationCount: 1,
    };
    report.resumeSafety = {
      serverResumeTurnIds,
      interruptedResumeTurn: interruptedResumeTurn ?? null,
      clientTurnStartsBeforeExplicitContinuation: 0,
    };
    archived = await archiveThread(second.client, threadId);
    assert.equal(archived, true, '验收线程归档失败');
    report.cleanup = { archived, tempRootRemoved: true, secondInterrupted: secondInterrupted.length };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (!archived) archived = await archiveThread(second?.client, threadId);
    await second?.client.stop().catch(() => undefined);
    await first.client.stop().catch(() => undefined);
    await removeSpikeTempRoot(tempRoot, 'rocketx-codex-lifecycle-');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
