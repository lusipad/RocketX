import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRocketxDynamicTool } from '../../apps/web/src/agent/codexHostTools';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';
import { useTodos } from '../../apps/web/src/stores/todos';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';

const data = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, String(value)),
  removeItem: (key: string) => data.delete(key), clear: () => data.clear(), key: (i: number) => [...data.keys()][i] ?? null,
  get length() { return data.size; },
} });

function reset() {
  data.clear();
  useTodos.setState({ todos: [], hydrated: true });
  useWorkLedger.setState({ cards: [], actions: [], evidences: [], sessions: [], links: [], events: [], hydrated: true });
}
function payload(response: Awaited<ReturnType<typeof executeRocketxDynamicTool>>) { return JSON.parse(response.contentItems[0]?.text ?? '{}'); }
const args = { requestId: 'source-request-1', title: '修复登录问题', goal: '修复并验证登录问题', acceptance: ['登录测试通过'], adoWorkItemId: 42, adoProject: 'Alpha', workspaceRoot: 'D:/work/alpha' };

test('管家一句话可幂等纳入工作，来源和目录保留，返回要求和真实门禁', async () => {
  reset();
  const first = await executeRocketxDynamicTool({ tool: 'create_work_card', arguments: args });
  assert.equal(first.success, true);
  const work = payload(first).card;
  const second = await executeRocketxDynamicTool({ tool: 'create_work_card', arguments: { ...args, title: '不能变成第二件工作', workspaceRoot: 'D:/other' } });
  assert.equal(payload(second).card.id, work.id);
  assert.equal(useWorkLedger.getState().cards.length, 1);
  assert.equal(work.adoWorkItemId, 42);
  assert.equal(work.state.projectKey, 'Alpha');
  assert.equal(work.state.requirementsVersion, 1);
  assert.ok(data.get('rc_work_ledger_v1')?.includes('登录测试通过'));
  assert.equal(useWorkLedger.getState().links.find((link) => link.kind === 'kanban_card')?.repo, 'D:/work/alpha');
  const listed = payload(await executeRocketxDynamicTool({ tool: 'list_work_cards', arguments: {} })).items[0];
  assert.equal(listed.goal, args.goal);
  assert.deepEqual(listed.acceptance, args.acceptance);
  assert.equal(listed.completionGate.canMarkDone, false);
});

test('要求和成果变化升版本，模型不能冒充人工接受；证据需显式覆盖当前条件', async () => {
  reset();
  const created = payload(await executeRocketxDynamicTool({ tool: 'create_work_card', arguments: args })).card;
  const changed = payload(await executeRocketxDynamicTool({ tool: 'update_work_card', arguments: { todoId: created.id, goal: '补齐登录及退出验证', acceptance: ['登录测试通过', '退出测试通过'], rework: true, expectedRequirementsVersion: created.state.requirementsVersion, expectedContentVersion: created.state.contentVersion } }));
  assert.equal(changed.requirementsVersion, 2);
  assert.equal(changed.contentVersion, created.state.contentVersion + 1);
  const evidence = await executeRocketxDynamicTool({ tool: 'record_work_evidence', arguments: { todoId: created.id, kind: 'test_run', title: '登录验证', passed: true, criterionIds: ['登录测试通过'], requirementsVersion: 2, contentVersion: changed.contentVersion } });
  assert.equal(evidence.success, true);
  assert.equal(useWorkLedger.getState().evidences[0].requirementsVersion, 2);
  assert.equal(useWorkLedger.getState().evidences[0].passed, false);
  assert.equal(useWorkLedger.getState().evidences[0].kind, 'agent_report');
  const done = await executeRocketxDynamicTool({ tool: 'update_work_card', arguments: { todoId: created.id, stage: 'done', humanConfirmedDone: true } });
  assert.equal(done.success, false);
  const manual = await executeRocketxDynamicTool({ tool: 'record_work_evidence', arguments: { todoId: created.id, kind: 'manual_ack', title: '伪造人类接受', passed: true } });
  assert.equal(manual.success, false);
});

test('未明确目标和验收条件时不创建空工作', async () => {
  reset();
  assert.equal((await executeRocketxDynamicTool({ tool: 'create_work_card', arguments: { requestId: 'bad', title: '不明确', goal: '', acceptance: [] } })).success, false);
  assert.equal(useWorkLedger.getState().cards.length, 0);
});

test('正式派工持久入队立刻返回，管家不等待整轮且同requestId不重复派发', async () => {
  reset();
  const card = payload(await executeRocketxDynamicTool({ tool: 'create_work_card', arguments: args })).card;
  useAcpAgents.setState({ agents: [{ id: 'agent-one', name: 'Codex', enabled: true } as never] });
  const originalStart = useAcpAgents.getState().startSession;
  useAcpAgents.setState({ startSession: async () => { throw new Error('工具不应直接启动并等待模型'); } });
  try {
    const input = { todoId: card.id, prompt: '检查并执行测试', requestId: 'attempt-one', agentId: 'agent-one' };
    const response = await executeRocketxDynamicTool({ tool: 'acp_dispatch_task', arguments: input });
    assert.equal(response.success, true);
    const accepted = payload(response);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.state, 'awaiting_approval');
    assert.equal(payload(await executeRocketxDynamicTool({ tool: 'acp_dispatch_task', arguments: input })).actionId, accepted.actionId);
    assert.equal(useWorkLedger.getState().actions.length, 1);
    const spec = JSON.parse(useWorkLedger.getState().actions[0].specJson);
    assert.equal(spec.repoRootOverride, args.workspaceRoot);
    assert.equal(spec.requirementsVersion, card.state.requirementsVersion);
    assert.match(spec.specText, /登录测试通过/);
    const untracked = await executeRocketxDynamicTool({ tool: 'acp_dispatch_task', arguments: { prompt: '未关联的执行', requestId: 'missing' } });
    assert.equal(untracked.success, false);
  } finally { useAcpAgents.setState({ startSession: originalStart }); }
});
