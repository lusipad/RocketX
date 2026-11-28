import '../../apps/web/src/agent/acpButlerWiring';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { NativeWorkCard } from '../../apps/web/src/platform/desktopCommands';

const workspaceRoot = 'D:/work/login';
const headSha = 'a'.repeat(40);
const ciCriterion = 'CI 构建成功';
const businessCriterion = '登录和退出业务验收';
const records = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => records.get(key) ?? null,
  setItem: (key: string, value: string) => records.set(key, String(value)),
  removeItem: (key: string) => records.delete(key),
  clear: () => records.clear(),
  key: (index: number) => [...records.keys()][index] ?? null,
  get length() { return records.size; },
} });

async function production() {
  const [host, ledger, todos, acp, workspace, auth, chat, client, bridge, supervisor, coordinator, external, rc] = await Promise.all([
    import('../../apps/web/src/agent/codexHostTools'),
    import('../../apps/web/src/stores/workLedger'),
    import('../../apps/web/src/stores/todos'),
    import('../../apps/web/src/stores/acpAgents'),
    import('../../apps/web/src/stores/codexWorkspace'),
    import('../../apps/web/src/stores/auth'),
    import('../../apps/web/src/stores/chat'),
    import('../../apps/web/src/lib/client'),
    import('../../apps/web/src/agent/superAgentBridge'),
    import('../../apps/web/src/agent/workSupervisor'),
    import('../../apps/web/src/agent/workCoordinator'),
    import('../../apps/web/src/agent/externalWorkActions'),
    import('../../packages/rc-client/src/index'),
  ]);
  return { ...host, ...ledger, ...todos, ...acp, ...workspace, ...auth, ...chat, ...client, ...bridge, ...supervisor, ...coordinator, ...external, RcApiError: rc.RcApiError };
}
type Production = Awaited<ReturnType<typeof production>>;
type StoredMessage = { _id: string; rid: string; msg: string };

function connected(p: Production) {
  p.useAuth.setState({ status: 'authed', localMode: false, user: { _id: 'alice', username: 'alice' } });
  p.useChat.setState({ subscriptions: { team: { rid: 'team', name: '团队' } as never } });
}

function supervisorFor(p: Production) {
  const executions: Promise<unknown>[] = [];
  let notices: Record<string, string> = {};
  const supervisor = p.createWorkSupervisor({
    snapshot: () => p.useWorkLedger.getState(), now: Date.now,
    updateCard: (...args) => p.useWorkLedger.getState().updateCard(...args),
    prepare: (input) => p.useWorkLedger.getState().prepareDispatchAction(input),
    transition: (input) => p.useWorkLedger.getState().transitionDispatchAction(input),
    execute: (action) => {
      const execution = p.executeSuperAgentDispatch({ action });
      executions.push(execution);
      return execution;
    },
    notify: async () => {}, readNotices: () => notices, writeNotices: (next) => { notices = next; },
  });
  return { supervisor, executions };
}

function payload(result: Awaited<ReturnType<Production['executeRocketxDynamicTool']>>) {
  assert.equal(result.success, true, result.contentItems[0]?.text);
  return JSON.parse(result.contentItems[0]?.text ?? '{}');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface RestartInput { storage: Array<[string, string]>; messages: StoredMessage[]; workId: string; reportActionId: string; }

async function verifyRestart(input: RestartInput) {
  for (const [key, value] of input.storage) records.set(key, value);
  // Fresh process: the production stores read the persisted local data themselves.
  const p = await production();
  connected(p);
  const messages = new Map(input.messages.map((message) => [message._id, message]));
  let reads = 0; let writes = 0; let workerExecutions = 0;
  p.rest.getMessage = async (id) => {
    reads += 1;
    const message = messages.get(id);
    if (!message) throw new p.RcApiError('not found', 404);
    return message as never;
  };
  p.rest.sendMessageRaw = async () => { writes += 1; throw new Error('重启对账不得重发'); };
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === 'PATCH') writes += 1;
    throw new Error('已完成 ADO 动作不应重放');
  }) as typeof fetch;
  const restore = p.setSuperAgentRuntimeDriversForTests({
    startAcpWorkerTask: async () => { workerExecutions += 1; throw new Error('不得重新执行'); },
    sendAcpSessionPrompt: async () => { workerExecutions += 1; throw new Error('不得重新执行'); },
  });
  const h = supervisorFor(p);
  try {
    assert.equal(p.useWorkLedger.getState().cards.length, 1);
    assert.equal(p.useWorkLedger.getState().cards[0].id, input.workId);
    assert.equal(p.useWorkLedger.getState().cards[0].done, true);
    await p.useWorkLedger.getState().reconcileStartupActions();
    await p.reconcileExternalWorkActions();
    await h.supervisor.tick();
    await Promise.all(h.executions);
    const report = p.useWorkLedger.getState().actions.find((action) => action.id === input.reportActionId)!;
    assert.equal(report.state, 'verifying_delivery');
    const frozen = JSON.parse(report.specJson);
    assert.ok(frozen.parts.length > input.messages.length);
    assert.deepEqual(JSON.parse(report.receiptRef!).messageIds, input.messages.map((message) => message._id));
    assert.equal(writes, 0);
    assert.equal(workerExecutions, 0);
    assert.equal(reads, frozen.parts.length);
    process.stdout.write(`WORKFLOW_RESTART:${JSON.stringify({ reads, writes, workerExecutions, workId: input.workId, state: report.state })}\n`);
  } finally { h.supervisor.stop(); restore(); }
}

if (process.env.RCX_WORKFLOW_RESTART_TEST === '1') {
  void verifyRestart(JSON.parse(readFileSync(0, 'utf8')) as RestartInput).catch((error) => {
    process.stderr.write(String(error?.stack ?? error)); process.exitCode = 1;
  });
} else {
  test('主业务贯通：持久派工、改口与原会话续发、可信 CI 和人工验收、ADO 同步、分段汇报未知及进程重启只读对账', { timeout: 45_000 }, async () => {
    records.set('rcx-server', 'https://chat.test');
    records.set('rcx-owner', 'https://chat.test:alice');
    records.set('rcx-workbench', JSON.stringify({ adoBase: 'https://ado.test/collection', auth: 'none', account: 'alice' }));
    const p = await production();
    connected(p);
    p.useTodos.setState({ todos: [] });
    p.useWorkLedger.setState({ cards: [], actions: [], evidences: [], sessions: [], links: [], events: [], hydrated: true });
    p.useCodexWorkspace.setState({ scope: 'https://chat.test:alice', workspaceRoot: workspaceRoot, activeThreadId: 'butler' });
    p.useAcpAgents.setState({ agents: [{ id: 'codex-acp', name: 'Codex', enabled: true } as never] });
    const originalFetch = globalThis.fetch;
    const originalGet = p.rest.getMessage;
    const originalSend = p.rest.sendMessageRaw;
    const originalRequest = p.rest.request;
    const releaseWorker = deferred();
    const workerStarted = deferred();
    const executions: Array<{ kind: string; workspaceRoot: string; sessionId?: string; specText: string }> = [];
    const messages = new Map<string, StoredMessage>();
    const sendAttempts: string[] = [];
    let adoRevision = 7; let adoState = 'Active'; let adoWrites = 0; let ciReads = 0;
    const restore = p.setSuperAgentRuntimeDriversForTests({
      isDesktop: () => false,
      startAcpWorkerTask: async (input) => {
        executions.push({ kind: 'create', workspaceRoot: input.workspaceRoot, specText: input.specText });
        workerStarted.resolve();
        await releaseWorker.promise;
        return { sessionId: 'original-native-session', sessionKey: 'managed-session', stopReason: 'end_turn' };
      },
      sendAcpSessionPrompt: async (input) => {
        executions.push({ kind: 'continue', workspaceRoot: input.workspaceRoot, sessionId: input.sessionId, specText: input.specText });
        return { turnMarker: 'turn-current-requirements', stopReason: 'end_turn' };
      },
      startCodexWorkerTask: async () => { throw new Error('不能误走 Pi/其他执行器'); },
      sendCodexSessionPrompt: async () => { throw new Error('不能误走 Pi/其他执行器'); },
    });
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('settings.public')) return Response.json({ settings: [{ _id: 'Message_MaxAllowedSize', value: 100 }] });
      if (String(url).includes('/_apis/build/builds/81')) {
        ciReads += 1;
        return Response.json({ id: 81, buildNumber: '81', project: { name: 'Alpha' }, definition: { id: 3, name: 'login-ci' }, status: 'completed', result: 'succeeded', sourceVersion: headSha, sourceBranch: 'refs/heads/fix/login' });
      }
      if (init?.method === 'PATCH') {
        adoWrites += 1;
        assert.deepEqual(JSON.parse(String(init.body))[0], { op: 'test', path: '/rev', value: 7 });
        adoRevision = 8; adoState = 'Resolved';
        return Response.json({ id: 42, rev: adoRevision, fields: { 'System.State': adoState, 'System.TeamProject': 'Alpha' } });
      }
      if (String(url).includes('/_apis/wit/workitems')) return Response.json({ value: [{ id: 42, rev: adoRevision, fields: { 'System.State': adoState, 'System.TeamProject': 'Alpha' } }] });
      throw new Error(`未预期的外部请求：${String(url)}`);
    }) as typeof fetch;
    p.rest.getMessage = async (id) => {
      const message = messages.get(id);
      if (!message) throw new p.RcApiError('not found', 404);
      return message as never;
    };
    p.rest.sendMessageRaw = async (message) => {
      sendAttempts.push(message._id!);
      const saved = { _id: message._id!, rid: message.rid, msg: message.msg! };
      messages.set(saved._id, saved);
      if (sendAttempts.length === 2) throw new Error('第二段已写入服务端，但回执连接断开');
      return saved as never;
    };
    p.rest.request = async () => ({ settings: [{ _id: 'Message_MaxAllowedSize', value: 100 }] }) as never;
    const h = supervisorFor(p);
    try {
      const creation = { requestId: 'ado-42-source-message', title: '修复 ADO #42 登录缺陷', goal: '修复登录缺陷并验证', acceptance: [ciCriterion], adoWorkItemId: 42, adoProject: 'Alpha', rid: 'team', mid: 'source-message', workspaceRoot };
      const work = payload(await p.executeRocketxDynamicTool({ tool: 'create_work_card', arguments: creation })).card as NativeWorkCard;
      assert.equal(payload(await p.executeRocketxDynamicTool({ tool: 'create_work_card', arguments: creation })).card.id, work.id);
      assert.equal(work.source, 'ado');
      assert.equal(p.useWorkLedger.getState().cards.length, 1);
      await p.useWorkLedger.getState().updateCard(work.id, { autonomyMode: 'autonomous', visibility: 'room_shared' });
      await p.useWorkLedger.getState().upsertLink({ todoId: work.id, kind: 'git_branch', externalId: 'fix/login', project: 'Alpha', repo: workspaceRoot, rid: 'team', headSha, title: '当前成果', webUrl: null, stateSnapshot: 'observed_workspace' });
      const dispatchArgs = { todoId: work.id, requestId: 'first-attempt', prompt: '处理缺陷并运行验证', agentId: 'codex-acp' };
      const accepted = payload(await p.executeRocketxDynamicTool({ tool: 'acp_dispatch_task', arguments: dispatchArgs }));
      assert.equal(accepted.state, 'prepared');
      assert.equal(executions.length, 0, '管家入队工具不得等待或直接执行 worker');
      assert.ok(records.get('rc_work_ledger_v1')!.includes(accepted.actionId));
      assert.equal(payload(await p.executeRocketxDynamicTool({ tool: 'acp_dispatch_task', arguments: dispatchArgs })).actionId, accepted.actionId);
      p.useCodexWorkspace.setState({ workspaceRoot: 'D:/other/focused', activeThreadId: 'unrelated-conversation' });
      await h.supervisor.tick();
      await workerStarted.promise;
      assert.equal(executions[0].workspaceRoot, workspaceRoot);
      assert.equal(p.useWorkLedger.getState().actions.find((action) => action.id === accepted.actionId)!.state, 'verifying_delivery');
      assert.equal(payload(await p.executeRocketxDynamicTool({ tool: 'list_work_cards', arguments: {} })).items[0].todoId, work.id, 'worker 未结束时管家仍可响应其他工具');
      const ciArgs = { todoId: work.id, project: 'Alpha', buildId: 81, requirementsVersion: work.state.requirementsVersion, contentVersion: work.state.contentVersion, criterionIds: [ciCriterion] };
      const oldEvidence = payload(await p.executeRocketxDynamicTool({ tool: 'verify_work_ci_evidence', arguments: ciArgs })).evidence;
      assert.equal(oldEvidence.kind, 'ci_build');
      const changed = payload(await p.executeRocketxDynamicTool({ tool: 'update_work_card', arguments: { todoId: work.id, expectedRequirementsVersion: work.state.requirementsVersion, expectedContentVersion: work.state.contentVersion, goal: '同时修复登录和退出缺陷', acceptance: [ciCriterion, businessCriterion], rework: true } }));
      assert.ok(changed.requirementsVersion > work.state.requirementsVersion!);
      assert.equal(p.useWorkLedger.getState().evidences.find((evidence) => evidence.id === oldEvidence.id)!.stale, true);
      releaseWorker.resolve();
      await Promise.all(h.executions);
      let current = p.useWorkLedger.getState().cards.find((card) => card.id === work.id)!;
      assert.equal(current.done, false, '旧要求下的执行回执不能使新要求完成');
      assert.equal(current.state.requirementsVersion, changed.requirementsVersion);
      assert.equal(p.evaluateCardCompletionGate(current, p.useWorkLedger.getState().evidences).canMarkDone, false);
      const session = p.useWorkLedger.getState().sessions.find((item) => item.todoId === work.id)!;
      assert.equal(session.runtimeStatus, 'idle', '执行器已返回 end_turn 后不能留作运行中，阻塞同目录后续派工');
      await p.useWorkLedger.getState().prepareDispatchAction({ todoId: work.id, sessionId: session.id, idempotencyKey: 'new-requirements-same-session', actionKind: 'session_prompt', specJson: JSON.stringify({ runtime: 'acp', specText: '请接受新要求，同时验证退出' }), requireConfirmation: false });
      p.useCodexWorkspace.setState({ workspaceRoot: '/another/focused/project', activeThreadId: 'third-conversation' });
      await h.supervisor.tick();
      await Promise.all(h.executions);
      assert.deepEqual(executions[1], { kind: 'continue', workspaceRoot, sessionId: 'original-native-session', specText: '请接受新要求，同时验证退出' });
      assert.equal(executions.length, 2);
      assert.equal((await p.executeRocketxDynamicTool({ tool: 'verify_work_ci_evidence', arguments: ciArgs })).success, false);
      const newEvidence = payload(await p.executeRocketxDynamicTool({ tool: 'verify_work_ci_evidence', arguments: { ...ciArgs, requirementsVersion: changed.requirementsVersion, contentVersion: changed.contentVersion } })).evidence;
      assert.equal(newEvidence.requirementsVersion, changed.requirementsVersion);
      assert.equal(ciReads, 2, '过期版本请求应在外部读取前拒绝');
      current = p.useWorkLedger.getState().cards.find((card) => card.id === work.id)!;
      assert.equal(p.evaluateCardCompletionGate(current, p.useWorkLedger.getState().evidences).canMarkDone, false, 'CI 不能冒充业务人工验收');
      await assert.rejects(p.useWorkLedger.getState().acceptWork(work.id, { actorId: 'https://chat.test:alice', criterionIds: [businessCriterion], requirementsVersion: work.state.requirementsVersion ?? 0, contentVersion: work.state.contentVersion ?? 0 }), /当前版本|已更新/);
      assert.equal(p.useWorkLedger.getState().evidences.some((evidence) => evidence.kind === 'manual_ack'), false);
      const done = await p.useWorkLedger.getState().acceptWork(work.id, { actorId: 'https://chat.test:alice', criterionIds: [businessCriterion], requirementsVersion: current.state.requirementsVersion ?? 0, contentVersion: current.state.contentVersion ?? 0 });
      assert.equal(done.done, true);
      const human = p.useWorkLedger.getState().evidences.find((evidence) => evidence.kind === 'manual_ack')!;
      assert.deepEqual(human.acceptanceScope, [businessCriterion]);
      assert.equal(done.state.maxAutoTurns, 3);
      assert.equal(done.state.autoTurnsUsed, 2);
      const conflict = payload(await p.executeRocketxDynamicTool({ tool: 'work_ado_state_sync', arguments: { todoId: work.id, operationId: 'stale-resolve-42', expectedRevision: 6, expectedState: 'Active', targetState: 'Resolved' } }));
      assert.equal(conflict.syncConfirmed, false);
      assert.equal(conflict.action.state, 'failed');
      assert.equal(JSON.parse(conflict.action.receiptRef).delivery, 'conflict');
      assert.equal(adoWrites, 0, '远端版本冲突不能用旧版本覆盖');
      const ado = payload(await p.executeRocketxDynamicTool({ tool: 'work_ado_state_sync', arguments: { todoId: work.id, operationId: 'resolve-42', expectedRevision: 7, expectedState: 'Active', targetState: 'Resolved' } }));
      assert.equal(ado.syncConfirmed, true);
      assert.equal(adoWrites, 1);
      const repeatedAdo = payload(await p.executeRocketxDynamicTool({ tool: 'work_ado_state_sync', arguments: { todoId: work.id, operationId: 'resolve-42', expectedRevision: 7, expectedState: 'Active', targetState: 'Resolved' } }));
      assert.equal(repeatedAdo.action.id, ado.action.id);
      assert.equal(adoWrites, 1, '同一稳定操作不能重复 PATCH');
      const reportResult = payload(await p.executeRocketxDynamicTool({ tool: 'workflow_report_publish', arguments: { todoId: work.id, rid: 'team', operationId: 'resolution-report' } }));
      assert.equal(reportResult.deliveryConfirmed, false);
      const report = reportResult.action;
      assert.equal(report.state, 'verifying_delivery');
      assert.equal(sendAttempts.length, 2, report.errorMessage);
      assert.equal(new Set(sendAttempts).size, 2);
      assert.ok(JSON.parse(report.specJson).parts.length > 2);
      assert.equal(p.useWorkLedger.getState().cards[0].state.autoTurnsUsed, 2, 'ADO 和汇报投递不应消耗 Agent 推进轮数');
      assert.equal(p.useWorkLedger.getState().cards[0].done, true, '投递失败不能撤销成果或重新执行工作');
      assert.equal(p.useWorkLedger.getState().actions.find((action) => action.id === ado.action.id)!.state, 'acknowledged');
      await p.reconcileExternalWorkActions();
      assert.equal(sendAttempts.length, 2);
      assert.equal(adoWrites, 1);
      const repeatedReport = payload(await p.executeRocketxDynamicTool({ tool: 'workflow_report_publish', arguments: { todoId: work.id, rid: 'team', operationId: 'resolution-report' } }));
      assert.equal(repeatedReport.action.id, report.id);
      assert.equal(repeatedReport.action.specJson, report.specJson);
      assert.equal(sendAttempts.length, 2, '再次查看同一汇报不能重发未知分段');
      const restarted = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
        env: { ...process.env, RCX_WORKFLOW_RESTART_TEST: '1' },
        input: JSON.stringify({ storage: [...records], messages: [...messages.values()], workId: work.id, reportActionId: report.id } satisfies RestartInput),
        encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(restarted.status, 0, `${restarted.stdout}\n${restarted.stderr}`);
      assert.match(restarted.stdout, /WORKFLOW_RESTART:.*"writes":0,"workerExecutions":0/);
    } finally {
      releaseWorker.resolve(); h.supervisor.stop(); restore();
      globalThis.fetch = originalFetch; p.rest.getMessage = originalGet; p.rest.sendMessageRaw = originalSend; p.rest.request = originalRequest;
    }
  });
}
