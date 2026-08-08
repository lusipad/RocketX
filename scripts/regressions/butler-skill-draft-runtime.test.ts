import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createButlerEfficiencyExtension,
  type ButlerEfficiencyApi,
} from '../../apps/web/src/butler/extensions/learning/efficiencyExtension';
import {
  BUTLER_OPERATION_JOURNAL_EXTENSION_ID,
  createButlerOperationJournalExtension,
} from '../../apps/web/src/butler/extensions/learning/operationJournalExtension';
import type { ButlerSkillDraft } from '../../apps/web/src/butler/extensions/learning/skillDraft';
import {
  butlerEfficiency,
  createExplicitButlerSkillDraft,
} from '../../apps/web/src/butler/extensions/learning/runtime';
import type { ButlerTaskState } from '../../apps/web/src/lib/butlerTaskContext';
import {
  ButlerExtensionHost,
  type ButlerExtensionStateStore,
} from '../../apps/web/src/kernel/butlerExtensions';

function draft(name = 'release-risk-check'): ButlerSkillDraft {
  return {
    id: 'skill-draft:task-1',
    proposalId: 'proposal-repeat-1',
    name,
    title: '候选版本评审',
    description: '按固定顺序检查候选版本风险。',
    mode: 'auto',
    status: 'draft',
    createdAt: 1,
    whenToUse: ['准备候选版本时使用。'],
    procedure: ['读取发布范围。', '检查风险。'],
    reads: ['只读发布信息。'],
    produces: ['生成评审结论。'],
    confirmations: ['写操作需要确认。'],
    pitfalls: ['不要把缺少证据当成没有风险。'],
    verification: ['逐项核对来源。'],
    effect: 'read',
    source: {
      sessionId: 'session-1',
      lineIds: ['line-1'],
      scenario: 'workflow',
    },
  };
}

function completedTask(): ButlerTaskState {
  return {
    id: 'task-1',
    goal: '不应进入草稿的原始目标',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    manifest: {
      schemaVersion: 1,
      scenario: 'workflow',
      capabilityPreflight: { available: [], missing: [] },
      sourcePlan: [],
      clarification: { required: false, missing: [] },
      prohibitedActions: [],
      recovery: '重新执行',
    },
    sources: [],
  };
}

test('Skill 草稿由效率扩展持久化，确认后才写入既有 Skill 目录', () => {
  const namespaces = new Map<string, unknown>();
  const storage: ButlerExtensionStateStore = {
    read: <T>(id: string) => namespaces.get(id) as T | undefined,
    write: <T>(id: string, state: T) => namespaces.set(id, state),
  };
  const host = new ButlerExtensionHost(storage);
  host.load(createButlerOperationJournalExtension());
  const installed: Array<{ name: string; description: string; body: string }> = [];
  const efficiency = host.load<ButlerEfficiencyApi>(createButlerEfficiencyExtension({
    names: () => installed.map((item) => item.name),
    install: (skill) => installed.push(skill),
  }));

  const created = efficiency.upsertDraft(draft(' release-risk-check '));
  assert.equal(created.id, 'skill-draft:task-1');
  assert.equal(efficiency.store.getState().drafts.length, 1);
  assert.equal(
    (namespaces.get('rocketx.butler.efficiency') as { drafts: ButlerSkillDraft[] }).drafts.length,
    1,
  );

  efficiency.saveDraft({ ...created, title: '候选版本发布评审' });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].name, 'release-risk-check');
  assert.equal(installed[0].description, '按固定顺序检查候选版本风险。');
  assert.match(installed[0].body, /## 何时使用/);
  assert.match(installed[0].body, /候选版本发布评审/);
  assert.equal(efficiency.store.getState().drafts.length, 0);
  assert.equal(
    efficiency.store.getState().proposals.find((item) => item.id === created.proposalId)?.status,
    undefined,
  );
  host.dispose();
});

test('确认草稿不会静默覆盖同名 Skill', () => {
  const host = new ButlerExtensionHost({
    read: () => undefined,
    write: () => undefined,
  });
  host.load(createButlerOperationJournalExtension());
  const efficiency = host.load<ButlerEfficiencyApi>(createButlerEfficiencyExtension({
    names: () => ['release-risk-check'],
    install: () => assert.fail('同名 Skill 不应被覆盖'),
  }));
  const created = efficiency.upsertDraft(draft(' release-risk-check '));

  assert.throws(
    () => efficiency.saveDraft(created),
    /同名 Skill 已存在/,
  );
  assert.equal(efficiency.store.getState().drafts.length, 1);
  host.dispose();
});

test('宿主存储就绪后会恢复待确认 Skill 草稿', () => {
  const namespaces = new Map<string, unknown>([[
    'rocketx.butler.efficiency',
    { candidates: [], proposals: [], drafts: [draft()] },
  ]]);
  const host = new ButlerExtensionHost({
    read: <T>(id: string) => namespaces.get(id) as T | undefined,
    write: <T>(id: string, state: T) => namespaces.set(id, state),
  });
  host.load(createButlerOperationJournalExtension());
  const efficiency = host.load<ButlerEfficiencyApi>(createButlerEfficiencyExtension({
    names: () => [],
    install: () => undefined,
  }));

  efficiency.store.setState({ drafts: [] });
  host.dispatch('host.storage-ready', undefined);
  assert.equal(efficiency.store.getState().drafts[0]?.name, 'release-risk-check');
  assert.ok(host.get(BUTLER_OPERATION_JOURNAL_EXTENSION_ID));
  host.dispose();
});

test('先忽略自动建议后，显式保存会脱离旧建议并重新显示草稿', () => {
  butlerEfficiency.store.setState({
    candidates: [],
    proposals: [{
      id: 'proposal-repeat-1',
      candidateId: 'repeat-1',
      target: 'micro-skill',
      title: '形成一个 Skill',
      rationale: '重复出现。',
      preview: [],
      skillName: 'release-risk-check',
      status: 'dismissed',
      createdAt: 1,
    }],
    drafts: [{ ...draft(), conversationHidden: true }],
  });

  const restored = createExplicitButlerSkillDraft({
    task: completedTask(),
    sessionId: 'session-1',
    lineIds: ['line-explicit'],
    steps: [],
  });

  assert.ok(restored);
  assert.equal(restored.mode, 'explicit');
  assert.equal(restored.proposalId, undefined);
  assert.equal(restored.conversationHidden, false);
  assert.deepEqual(restored.source.lineIds, ['line-1', 'line-explicit']);
  butlerEfficiency.store.setState({ candidates: [], proposals: [], drafts: [] });
});
