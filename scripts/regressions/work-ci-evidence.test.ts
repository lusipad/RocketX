import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRocketxDynamicTool } from '../../apps/web/src/agent/codexHostTools';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';
import { useTodos } from '../../apps/web/src/stores/todos';
import { verifyWorkCiEvidence } from '../../apps/web/src/agent/workCiEvidence';
import { observeWorkArtifacts } from '../../apps/web/src/agent/workArtifacts';
import type { NativeWorkCard, NativeWorkLink, NativeWorkSessionRecord } from '../../apps/web/src/platform/desktopCommands';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
  key: (index: number) => [...storage.keys()][index] ?? null, get length() { return storage.size; },
} });
const originalFetch = globalThis.fetch;
const sha = 'a'.repeat(40);
const input = { workId: 'work', project: 'Alpha', buildId: 123, requirementsVersion: 2, contentVersion: 1, criterionIds: ['CI 构建通过'] };
let reads = 0;

function setup(buildOverrides: Record<string, unknown> = {}) {
  storage.clear(); reads = 0;
  storage.set('rcx-workbench', JSON.stringify({ adoBase: 'https://ado.test/collection', account: 'alice', auth: 'none' }));
  useTodos.setState({ todos: [{ id: 'work', title: '工作', source: 'ado', adoWorkItemId: 42, adoProject: 'Alpha', done: false, createdAt: 1 }], hydrated: true });
  const card = { id: 'work', title: '工作', adoProject: 'Alpha', adoWorkItemId: 42,
    state: { goal: '交付变更', acceptance: ['CI 构建通过', '用户确认业务效果'], requirementsVersion: 2, contentVersion: 1, stage: 'verifying', waitState: 'none', ownerKind: 'ai_dispatched', boundaries: [], dependsOn: [] } } as unknown as NativeWorkCard;
  useWorkLedger.setState({ cards: [card], evidences: [], sessions: [], actions: [], events: [], links: [{ id: 'head', todoId: 'work', kind: 'git_branch', externalId: 'feature', headSha: sha, project: 'Alpha', lastVerifiedAt: 5 } as NativeWorkLink] });
  const build = { id: 123, project: { name: 'Alpha' }, status: 'completed', result: 'succeeded', sourceVersion: sha, sourceBranch: 'refs/heads/feature', buildNumber: '20261115.1', definition: { id: 7, name: 'CI' }, ...buildOverrides };
  globalThis.fetch = (async (url, options) => {
    reads += 1;
    assert.match(String(url), /\/Alpha\/_apis\/build\/builds\/123\?/);
    assert.equal(options?.method ?? 'GET', 'GET');
    return new Response(JSON.stringify(build), { status: 200 });
  }) as typeof fetch;
  return card;
}
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('可信CI来源由宿主HTTP读取，冻结构建定义/源提交/结果并幂等保存', async () => {
  setup();
  const evidence = await verifyWorkCiEvidence(input);
  assert.equal(evidence.kind, 'ci_build'); assert.equal(evidence.passed, true); assert.equal(evidence.stale, false);
  assert.equal(evidence.headSha, sha); assert.deepEqual(evidence.criterionIds, input.criterionIds);
  const receipt = JSON.parse(evidence.summary!.split('\n')[1]);
  assert.deepEqual([receipt.project, receipt.buildId, receipt.definitionId, receipt.definition, receipt.sourceVersion, receipt.status, receipt.result], ['Alpha', 123, 7, 'CI', sha, 'completed', 'succeeded']);
  assert.match(evidence.summary!, /不代表业务人工验收/);
  assert.equal((await verifyWorkCiEvidence(input)).id, evidence.id);
  assert.equal(useWorkLedger.getState().evidences.length, 1);
  assert.equal(reads, 2);
});

test('失败、未完成、部分成功、错提交及缺定义的构建不能登记通过证据', async () => {
  for (const build of [{ result: 'failed' }, { status: 'inProgress' }, { result: 'partiallySucceeded' }, { sourceVersion: 'b'.repeat(40) }, { definition: { name: 'CI' } }, { project: { name: 'Other' } }]) {
    setup(build);
    await assert.rejects(verifyWorkCiEvidence(input), /未确认成功|不匹配|不一致/);
    assert.equal(useWorkLedger.getState().evidences.length, 0);
  }
});

test('错项目/旧工作版本/未声明条件/业务人工条件在读取前拒绝', async () => {
  setup();
  for (const invalid of [{ project: 'Other' }, { requirementsVersion: 1 }, { contentVersion: 0 }, { criterionIds: ['不存在'] }, { criterionIds: ['用户确认业务效果'] }]) {
    await assert.rejects(verifyWorkCiEvidence({ ...input, ...invalid }));
  }
  assert.equal(reads, 0); assert.equal(useWorkLedger.getState().evidences.length, 0);
});

test('读取CI期间要求/成果/HEAD改变时不把旧验证结果绑定新版本', async () => {
  for (const change of ['requirements', 'content', 'head']) {
    setup(); const fetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const response = await fetch(...args);
      if (change === 'head') useWorkLedger.setState({ links: useWorkLedger.getState().links.map((link) => ({ ...link, headSha: 'b'.repeat(40) })) });
      else useWorkLedger.setState({ cards: useWorkLedger.getState().cards.map((card) => ({ ...card, state: { ...card.state, [change === 'requirements' ? 'requirementsVersion' : 'contentVersion']: 3 } })) });
      return response;
    }) as typeof fetch;
    await assert.rejects(verifyWorkCiEvidence(input), /期间工作或连接已改变/);
    assert.equal(useWorkLedger.getState().evidences.length, 0);
  }
});

test('桌面实时核对工作目录，脏文件拒绝；HEAD变更先使旧证据失效再接受新版本核对', async () => {
  setup();
  useWorkLedger.setState({ sessions: [{ id: 'session', todoId: 'work', workspaceRoot: 'D:/Alpha', updatedAt: 1 } as NativeWorkSessionRecord] });
  const git = { contentFingerprint: 'dirty-a', workspaceRoot: 'D:/Alpha', repoTopLevel: 'D:/Alpha', headSha: sha, branch: 'feature', dirtyFiles: ['src/change.ts'], isWorktree: false, diffStat: null, recentCommits: [] };
  await assert.rejects(verifyWorkCiEvidence(input, async () => git), /未提交修改/);
  assert.equal(reads, 0);
  const nextSha = 'c'.repeat(40);
  await assert.rejects(verifyWorkCiEvidence(input, async () => ({ ...git, contentFingerprint: 'clean-c', headSha: nextSha, dirtyFiles: [] })), /重新读取|已刷新实际 HEAD/);
  assert.equal(useWorkLedger.getState().cards[0].state.contentVersion, 2);
  assert.equal(useWorkLedger.getState().links.find((link) => link.kind === 'git_branch')?.headSha, nextSha);
  assert.equal(reads, 0);
});

test('桌面在CI回读期间HEAD或未提交内容变化不会登记证据', async () => {
  setup();
  useWorkLedger.setState({ sessions: [{ id: 'session', todoId: 'work', workspaceRoot: 'D:/Alpha', updatedAt: 1 } as NativeWorkSessionRecord] });
  let checks = 0;
  await assert.rejects(verifyWorkCiEvidence(input, async () => ({ contentFingerprint: checks > 0 ? 'dirty-new' : 'clean-a', workspaceRoot: 'D:/Alpha', repoTopLevel: 'D:/Alpha', headSha: sha, branch: 'feature', dirtyFiles: ++checks > 1 ? ['new.ts'] : [], isWorktree: false, diffStat: null, recentCommits: [] })), /期间工作目录已改变/);
  assert.equal(checks, 2); assert.equal(useWorkLedger.getState().evidences.length, 0);
});

test('真实CI入证前建立fingerprint基线；相同观察保留证据，之后同HEAD实际变化使其失效', async () => {
  setup();
  useWorkLedger.setState({ sessions: [{ id: 'session', todoId: 'work', workspaceRoot: 'D:/Alpha', updatedAt: 1 } as NativeWorkSessionRecord] });
  const clean = { contentFingerprint: 'clean-baseline', workspaceRoot: 'D:/Alpha', repoTopLevel: 'D:/Alpha', headSha: sha, branch: 'feature', dirtyFiles: [], isWorktree: false, diffStat: null, recentCommits: [] };
  let inspections = 0;
  const evidence = await verifyWorkCiEvidence(input, async () => { inspections += 1; return clean; });
  assert.equal(inspections, 2, 'observer复用已读取快照，不重复读原生Git');
  assert.equal(evidence.stale, false);
  assert.ok(useWorkLedger.getState().links.some((link) => link.stateSnapshot === 'content:clean-baseline'));
  await observeWorkArtifacts('work', { workspaceRoot: 'D:/Alpha', inspect: async () => clean });
  assert.equal(useWorkLedger.getState().cards[0].state.contentVersion, 1);
  assert.equal(useWorkLedger.getState().evidences.find((item) => item.id === evidence.id)?.stale, false);
  await observeWorkArtifacts('work', { workspaceRoot: 'D:/Alpha', inspect: async () => ({ ...clean, contentFingerprint: 'changed-at-same-head', dirtyFiles: ['src/changed.ts'] }) });
  assert.equal(useWorkLedger.getState().cards[0].state.contentVersion, 2);
  assert.equal(useWorkLedger.getState().evidences.find((item) => item.id === evidence.id)?.stale, true);
});

test('模型声明成功测试只保存为自述，不能冒充机械证据；CI工具才返回可核对来源', async () => {
  setup();
  const declaration = await executeRocketxDynamicTool({ tool: 'record_work_evidence', arguments: { todoId: 'work', kind: 'test_run', title: '模型声称通过', passed: true, criterionIds: ['CI 构建通过'], requirementsVersion: 2, contentVersion: 1 } });
  assert.equal(declaration.success, true);
  assert.equal(useWorkLedger.getState().evidences[0].kind, 'agent_report');
  assert.equal(useWorkLedger.getState().evidences[0].passed, false);
  const verified = await executeRocketxDynamicTool({ tool: 'verify_work_ci_evidence', arguments: { todoId: 'work', project: 'Alpha', buildId: 123, requirementsVersion: 2, contentVersion: 1, criterionIds: ['CI 构建通过'] } });
  assert.equal(verified.success, true);
  assert.equal(useWorkLedger.getState().evidences[0].kind, 'ci_build');
});

test('要求修改必须显式使用预读版本，旧worker不能覆盖用户新要求', async () => {
  setup();
  const missing = await executeRocketxDynamicTool({ tool: 'update_work_card', arguments: { todoId: 'work', goal: '新目标' } });
  assert.equal(missing.success, false);
  const current = await executeRocketxDynamicTool({ tool: 'update_work_card', arguments: { todoId: 'work', goal: '用户已修订目标', expectedRequirementsVersion: 2, expectedContentVersion: 1 } });
  assert.equal(current.success, true);
  const old = await executeRocketxDynamicTool({ tool: 'update_work_card', arguments: { todoId: 'work', goal: '旧worker覆盖', expectedRequirementsVersion: 2, expectedContentVersion: 1 } });
  assert.equal(old.success, false);
  assert.equal(useWorkLedger.getState().cards[0].state.goal, '用户已修订目标');
});
