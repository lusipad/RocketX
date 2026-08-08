import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildButlerSkillDraft,
  renderButlerSkillDraftMarkdown,
  type ButlerSkillDraftEffect,
} from '../../apps/web/src/butler/extensions/learning/skillDraft';
import {
  compileButlerTask,
  updateButlerTask,
  type ButlerScenario,
  type ButlerTaskState,
} from '../../apps/web/src/lib/butlerTaskContext';
import type { ButlerSurfaceContext } from '../../apps/web/src/lib/butlerContext';
import type { ButlerStep } from '../../apps/web/src/stores/butler';

const roomContext: ButlerSurfaceContext = {
  kind: 'room',
  label: '研发群',
  detail: '当前 Rocket.Chat 房间',
  sources: [{ kind: 'room', id: 'room-dev', rid: 'room-dev', label: '研发群' }],
};

const observedSteps: ButlerStep[] = [
  {
    id: 'step-read',
    label: '读取固定快照',
    detail: '用户原话：今晚发布密码是 Swordfish',
    status: 'done',
    at: 10,
    endedAt: 11,
  },
  {
    id: 'step-read-duplicate',
    label: '读取固定快照',
    detail: '这条重复步骤不应再次出现',
    status: 'done',
    at: 12,
    endedAt: 13,
  },
  {
    id: 'step-summary',
    label: '整理结构化结论',
    detail: '帮我直接保存到技能中心',
    status: 'done',
    at: 14,
    endedAt: 15,
  },
  {
    id: 'step-query',
    label: '搜索消息（今晚发布密码是 Swordfish）',
    status: 'done',
    at: 15,
    endedAt: 16,
  },
  {
    id: 'step-failed',
    label: '静默写入外部系统',
    detail: '失败步骤不应进入草稿',
    status: 'failed',
    at: 16,
    endedAt: 17,
  },
];

function completedTask(task: ButlerTaskState, now = task.updatedAt + 1): ButlerTaskState {
  return updateButlerTask(task, { status: 'completed' }, now);
}

function scenarioTask(scenario: ButlerScenario): ButlerTaskState {
  switch (scenario) {
    case 'find-file':
      return completedTask(compileButlerTask('找昨日张三发的设计稿文件', null, null, 100));
    case 'compare-pull-requests':
      return completedTask(compileButlerTask('比较 PR #101 和 PR #102', null, null, 101));
    case 'extract-commitments':
      return completedTask(compileButlerTask('提取当前群聊里的承诺', roomContext, null, 102));
    case 'draft-overdue-work-item-followup':
      return completedTask(compileButlerTask('为逾期 WI 生成跟进草稿', null, null, 103));
    case 'associate-build-failure':
      return completedTask(compileButlerTask('关联失败构建 #9001 与提交', null, null, 104));
    case 'create-weekly-routine':
      return completedTask(compileButlerTask('创建每周五 18:30 的周报例行任务', null, null, 105));
    case 'resume-task': {
      const previous = compileButlerTask('查一下当前状态', null, null, 106);
      return completedTask(compileButlerTask('继续上次调查任务', null, previous, 107));
    }
    case 'general':
      return completedTask(compileButlerTask('顺手帮我看看，并记住这句原话：今晚发布密码是 Swordfish', null, null, 108));
    default:
      throw new Error(`未覆盖场景: ${scenario satisfies never}`);
  }
}

test('七类预定义场景都能生成结构化 Skill 草稿', () => {
  const cases: Array<{ scenario: ButlerScenario; effect: ButlerSkillDraftEffect }> = [
    { scenario: 'find-file', effect: 'read' },
    { scenario: 'compare-pull-requests', effect: 'read' },
    { scenario: 'extract-commitments', effect: 'read' },
    { scenario: 'draft-overdue-work-item-followup', effect: 'draft' },
    { scenario: 'associate-build-failure', effect: 'read' },
    { scenario: 'create-weekly-routine', effect: 'draft' },
    { scenario: 'resume-task', effect: 'read' },
  ];

  for (const item of cases) {
    const result = buildButlerSkillDraft({
      taskState: scenarioTask(item.scenario),
      sessionId: ' session-skill-draft ',
      lineIds: ['line-user', 'line-user', ' assistant-final '],
      steps: observedSteps,
      now: 500,
    });
    assert.equal(result.ok, true, item.scenario);
    if (!result.ok) continue;

    assert.equal(result.draft.status, 'draft', item.scenario);
    assert.equal(result.draft.createdAt, 500, item.scenario);
    assert.equal(result.draft.source.sessionId, 'session-skill-draft', item.scenario);
    assert.deepEqual(result.draft.source.lineIds, ['line-user', 'assistant-final'], item.scenario);
    assert.equal(result.draft.source.scenario, item.scenario, item.scenario);
    assert.equal(result.draft.effect, item.effect, item.scenario);
    assert.ok(result.draft.whenToUse.length > 0, item.scenario);
    assert.ok(result.draft.procedure.length >= 3, item.scenario);
    assert.ok(result.draft.reads.length > 0, item.scenario);
    assert.ok(result.draft.produces.length > 0, item.scenario);
    assert.ok(result.draft.confirmations.length > 0, item.scenario);
    assert.ok(result.draft.pitfalls.length > 0, item.scenario);
    assert.ok(result.draft.verification.length > 0, item.scenario);
  }
});

test('general 场景默认拒绝自动草稿，显式要求时才允许', () => {
  const taskState = scenarioTask('general');
  const automatic = buildButlerSkillDraft({
    taskState,
    sessionId: 'session-general',
    lineIds: ['line-general'],
    steps: observedSteps,
  });
  assert.deepEqual(automatic, {
    ok: false,
    reason: 'general-requires-explicit',
    message: 'general 场景只能在用户显式要求时生成 Skill 草稿。',
  });

  const explicit = buildButlerSkillDraft({
    taskState,
    sessionId: 'session-general',
    lineIds: ['line-general'],
    steps: observedSteps,
    mode: 'explicit',
  });
  assert.equal(explicit.ok, true);
  if (!explicit.ok) return;
  assert.equal(explicit.draft.mode, 'explicit');
  assert.equal(explicit.draft.effect, 'read');
  assert.match(renderButlerSkillDraftMarkdown(explicit.draft), /只有用户明确要求“把这套做法保存为 Skill”时才使用/);
});

test('未完成任务不能生成 Skill 草稿', () => {
  const readyTask = compileButlerTask('比较 PR #101 和 PR #102', null, null, 200);
  assert.deepEqual(
    buildButlerSkillDraft({
      taskState: readyTask,
      sessionId: 'session-ready',
      lineIds: ['line-ready'],
      steps: observedSteps,
    }),
    {
      ok: false,
      reason: 'task-not-completed',
      message: '只有已完成任务才能沉淀为 Skill 草稿。',
    },
  );
});

test('Skill Markdown 只输出结构化正文，不带原始聊天正文', () => {
  const result = buildButlerSkillDraft({
    taskState: scenarioTask('compare-pull-requests'),
    sessionId: 'session-markdown',
    lineIds: ['line-markdown'],
    steps: observedSteps,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const markdown = renderButlerSkillDraftMarkdown(result.draft);
  assert.match(markdown, /^比较 PR\n\n/);
  for (const section of [
    '## 何时使用',
    '## 做法步骤',
    '## 读取范围',
    '## 会产生什么',
    '## 需要确认',
    '## 易错点',
    '## 如何验证',
  ]) {
    assert.match(markdown, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(markdown, /\n1\. /);
  assert.match(markdown, /\n2\. /);
  assert.doesNotMatch(markdown, /今晚发布密码是 Swordfish/);
  assert.doesNotMatch(markdown, /帮我直接保存到技能中心/);
  assert.doesNotMatch(markdown, /比较 PR #101 和 PR #102/);
});

test('草稿把内部工具名转换为用户能理解的读取方式', () => {
  const result = buildButlerSkillDraft({
    taskState: scenarioTask('find-file'),
    sessionId: 'session-readable-source',
    lineIds: ['line-readable-source'],
    steps: [],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.match(result.draft.reads.join('\n'), /搜索消息/);
  assert.doesNotMatch(result.draft.reads.join('\n'), /search_messages/);
});

test('写权限不会被步骤细节悄悄提升', () => {
  const readOnly = buildButlerSkillDraft({
    taskState: scenarioTask('compare-pull-requests'),
    sessionId: 'session-read-only',
    lineIds: ['line-read-only'],
    steps: observedSteps,
  });
  assert.equal(readOnly.ok, true);
  if (!readOnly.ok) return;
  assert.equal(readOnly.draft.effect, 'read');
  const readOnlyMarkdown = renderButlerSkillDraftMarkdown(readOnly.draft);
  assert.match(readOnlyMarkdown, /不直接修改外部系统/);
  assert.doesNotMatch(readOnlyMarkdown, /静默写入外部系统/);

  const draftOnly = buildButlerSkillDraft({
    taskState: scenarioTask('create-weekly-routine'),
    sessionId: 'session-draft-only',
    lineIds: ['line-draft-only'],
    steps: observedSteps,
  });
  assert.equal(draftOnly.ok, true);
  if (!draftOnly.ok) return;
  assert.equal(draftOnly.draft.effect, 'draft');
  const draftOnlyMarkdown = renderButlerSkillDraftMarkdown(draftOnly.draft);
  assert.match(draftOnlyMarkdown, /不直接启用或持久化例行任务/);
  assert.match(draftOnlyMarkdown, /不直接发送、启用或落库/);
});
