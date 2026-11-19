import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkflowExecutionReport } from '../../apps/web/src/agent/workflowReport';
import type { NativeWorkCard, NativeWorkEvidence, NativeWorkLink, NativeWorkSessionRecord } from '../../apps/web/src/platform/desktopCommands';
import type { AcpManagedSessionState } from '../../apps/web/src/stores/acpAgents';
import { resolvePortalWorkContext, workContextPathKey } from '../../apps/web/src/lib/workContext';

function card(id = 'work-a', stage: NativeWorkCard['state']['stage'] = 'in_progress'): NativeWorkCard {
  return {
    id, title: id, note: null, done: stage === 'done', updatedAt: 1,
    state: { stage, acceptance: ['必须通过测试'], waitState: 'none', consecutiveFailures: 0 },
  } as NativeWorkCard;
}

function session(todoId: string | null = 'work-a'): AcpManagedSessionState {
  return {
    sessionKey: 'acp-a', acpSessionId: 'native-a', linkedTodoId: todoId,
    title: '会话 A', status: 'running', turnCount: 1, workspaceRoot: 'D:/project-a',
    plan: [], toolCalls: [], messages: [], pendingPermissions: [], error: null,
  } as unknown as AcpManagedSessionState;
}

test('没有结构化计划时仅报告状态，不用阶段或轮次伪造百分比', () => {
  for (const stage of ['triage', 'ready', 'in_progress', 'verifying', 'done'] as const) {
    const report = buildWorkflowExecutionReport({ card: card('work-a', stage), acpSession: session() });
    assert.equal(report.progressPercent, null, stage);
    assert.doesNotMatch(report.markdown, /\d+%/);
    assert.ok(report.planBreakdown.every((step) => step.status === 'pending'));
  }
  assert.equal(buildWorkflowExecutionReport({ acpSession: session(null) }).progressPercent, null);
  assert.equal(buildWorkflowExecutionReport({}).progressPercent, null);
});

test('计划进度只统计明确完成的步骤，不把执行中折算为一半', () => {
  const acp = session();
  acp.plan = [
    { content: '检查', priority: 'medium', status: 'completed' },
    { content: '修改', priority: 'medium', status: 'completed' },
    { content: '测试', priority: 'high', status: 'in_progress' },
  ];
  const report = buildWorkflowExecutionReport({ card: card(), acpSession: acp });
  assert.equal(report.progressPercent, 67);
  assert.match(report.summary, /计划完成 2\/3 项/);
  const doneCardReport = buildWorkflowExecutionReport({ card: card('work-a', 'done'), acpSession: acp });
  assert.equal(doneCardReport.progressPercent, 67);
});

test('汇报拒绝混入其他工作的会话、结论、证据和关联', () => {
  const unrelated = session('work-b');
  unrelated.error = 'B 的错误';
  unrelated.status = 'error';
  unrelated.messages = [{ id: 'b', role: 'assistant', text: 'B 的私人结论' }];
  const report = buildWorkflowExecutionReport({
    card: card(), acpSession: unrelated,
    sessions: [{ id: 'ledger-b', todoId: 'work-b', workspaceRoot: 'D:/project-b' } as NativeWorkSessionRecord],
    evidences: [{ id: 'b', todoId: 'work-b', title: 'B 的证据', passed: true } as NativeWorkEvidence],
    links: [{ id: 'b', todoId: 'work-b', title: 'B 的链接' } as NativeWorkLink],
  });
  assert.equal(report.status, 'in_progress');
  assert.equal(report.workspaceRoot, null);
  assert.equal(report.sessionId, null);
  assert.equal(report.evidences.length, 0);
  assert.doesNotMatch(report.markdown, /B 的|project-b/);
});

test('会话匹配同时核对运行时和工作区，无会话时不选第一张卡或全局 ACP', () => {
  const cards = [card('work-b'), card()];
  const record = (runtime: 'pi' | 'codex', todoId: string, workspaceRoot = 'D:/project-a') => ({
    runtime, nativeSessionId: 'thread-a', todoId, workspaceRoot,
  } as NativeWorkSessionRecord);
  const base = {
    cards, sessions: [record('codex', 'work-b'), record('pi', 'work-b', 'D:/other'), record('pi', 'work-a')],
    acpSessions: [session('work-b')], currentRuntime: 'pi' as const,
    activeThreadId: 'thread-a', activeWorkspaceRoot: 'd:\\project-a', selectedCardId: null,
  };
  const result = resolvePortalWorkContext(base);
  assert.equal(result.card?.id, 'work-a');
  assert.equal(result.acpSession, null);
  assert.equal(resolvePortalWorkContext({ ...base, activeThreadId: null }).card, null);
  assert.equal(resolvePortalWorkContext({ ...base, activeThreadId: null }).acpSession, null);
  assert.equal(resolvePortalWorkContext({ ...base, sessions: [] }).card, null);
  assert.equal(resolvePortalWorkContext({ ...base, sessions: [record('pi', 'work-a'), record('pi', 'work-b')] }).card, null);
});

test('显式工作选择不随排序变化，删除后返回空态而不跳到当前会话工作', () => {
  const base = {
    cards: [card(), card('work-b')], sessions: [] as NativeWorkSessionRecord[],
    acpSessions: [session('work-b')], currentRuntime: 'pi' as const, selectedCardId: 'work-b',
  };
  assert.equal(resolvePortalWorkContext(base).card?.id, 'work-b');
  assert.equal(resolvePortalWorkContext({ ...base, cards: [...base.cards].reverse() }).card?.id, 'work-b');
  const deleted = resolvePortalWorkContext({ ...base, cards: [card()] });
  assert.equal(deleted.card, null);
  assert.equal(deleted.acpSession, null);
  assert.equal(deleted.showsCurrentConversation, false);
});

test('根目录仍保留路径身份，Windows 大小写一致，POSIX 大小写不混用', () => {
  assert.equal(workContextPathKey('C:\\'), workContextPathKey('c:/'));
  assert.equal(workContextPathKey('C:\\'), 'c:/');
  assert.equal(workContextPathKey('/'), '/');
  assert.notEqual(workContextPathKey('/'), workContextPathKey(''));
  assert.notEqual(workContextPathKey('/Project'), workContextPathKey('/project'));
  const base = {
    cards: [card(), card('work-b')], acpSessions: [], currentRuntime: 'pi' as const,
    activeThreadId: 'root-thread', selectedCardId: null,
    sessions: [
      { runtime: 'pi', nativeSessionId: 'root-thread', todoId: 'work-b', workspaceRoot: 'D:\\' },
      { runtime: 'pi', nativeSessionId: 'root-thread', todoId: 'work-a', workspaceRoot: 'C:\\' },
    ] as NativeWorkSessionRecord[],
  };
  assert.equal(resolvePortalWorkContext({ ...base, activeWorkspaceRoot: 'c:/' }).card?.id, 'work-a');
  assert.equal(resolvePortalWorkContext({ ...base, activeWorkspaceRoot: '/' }).card, null);
});
