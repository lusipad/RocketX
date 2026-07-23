import assert from 'node:assert/strict';
import test from 'node:test';
import {
  butlerTaskPrompt,
  compileButlerTask,
  updateButlerTask,
  type ButlerScenario,
} from '../../apps/web/src/lib/butlerTaskContext';
import type { ButlerSurfaceContext } from '../../apps/web/src/lib/butlerContext';

const roomContext: ButlerSurfaceContext = {
  kind: 'room',
  label: '研发群',
  detail: '当前 Rocket.Chat 房间',
  sources: [{ kind: 'room', id: 'room-dev', rid: 'room-dev', label: '研发群' }],
};

const cases: Array<{
  scenario: ButlerScenario;
  input: string;
  context?: ButlerSurfaceContext;
  expectedTool: string;
  needsPrevious?: boolean;
}> = [
  { scenario: 'find-file', input: '找昨日张三发的设计稿文件', expectedTool: 'search_messages' },
  {
    scenario: 'compare-pull-requests',
    input: '比较 PR #101 和 PR #102',
    expectedTool: 'list_pull_requests',
  },
  {
    scenario: 'extract-commitments',
    input: '提取当前群聊里的承诺',
    context: roomContext,
    expectedTool: 'search_messages',
  },
  {
    scenario: 'draft-overdue-work-item-followup',
    input: '为逾期 WI 生成跟进草稿',
    expectedTool: 'list_work_items',
  },
  {
    scenario: 'associate-build-failure',
    input: '关联失败构建 #9001 与提交',
    expectedTool: 'list_builds',
  },
  {
    scenario: 'create-weekly-routine',
    input: '创建每周五 18:30 的周报例行任务',
    expectedTool: 'load_skill',
  },
  {
    scenario: 'resume-task',
    input: '继续上次调查任务',
    expectedTool: 'session-registry',
    needsPrevious: true,
  },
];

test('七类 Butler 基线任务都编译结构化 manifest 与 task state', () => {
  for (const [index, item] of cases.entries()) {
    const previous = item.needsPrevious
      ? compileButlerTask('查一下当前状态', null, null, 1_699_999_999_999)
      : null;
    const task = compileButlerTask(item.input, item.context, previous, 1_700_000_000_000 + index);
    assert.equal(task.manifest.schemaVersion, 1, item.scenario);
    assert.equal(task.manifest.scenario, item.scenario);
    assert.equal(task.status, 'ready', item.scenario);
    assert.ok(task.manifest.capabilityPreflight.available.length > 0, item.scenario);
    assert.ok(task.manifest.sourcePlan.some((source) => source.tool === item.expectedTool), item.scenario);
    assert.ok(task.manifest.prohibitedActions.length > 0, item.scenario);
    assert.ok(task.manifest.recovery.length > 0, item.scenario);
  }
});

test('没有已有任务时不会猜测跨重启续跑目标', () => {
  const task = compileButlerTask('继续上次调查任务', null, null, 100);
  assert.equal(task.status, 'awaiting-clarification');
  assert.equal(task.manifest.clarification.question, '当前会话没有可恢复的任务，请说明要继续哪项调查。');
});

test('不完整指代先进入最小澄清，补充后沿用同一 task', () => {
  const first = compileButlerTask('比较这两个 PR', null, null, 100);
  assert.equal(first.status, 'awaiting-clarification');
  assert.equal(first.manifest.clarification.question, '请给出要比较的两个 PR 编号。');

  const resumed = compileButlerTask('PR #101 和 PR #102', null, first, 200);
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.createdAt, first.createdAt);
  assert.equal(resumed.status, 'ready');
  assert.match(resumed.goal, /补充：PR #101 和 PR #102/);
});

test('补充内容重复场景关键词时仍沿用待澄清 task', () => {
  const first = compileButlerTask('比较这两个 PR', null, null, 100);
  const resumed = compileButlerTask('比较 PR #101 和 PR #102', null, first, 200);

  assert.equal(resumed.id, first.id);
  assert.equal(resumed.createdAt, first.createdAt);
  assert.equal(resumed.status, 'ready');
  assert.match(resumed.goal, /补充：比较 PR #101 和 PR #102/);
});

test('明确声明新任务时不会吞并到同场景待澄清 task', () => {
  const first = compileButlerTask('比较这两个 PR', null, null, 100);
  const next = compileButlerTask('新任务：比较 PR #201 和 PR #202', null, first, 200);

  assert.notEqual(next.id, first.id);
  assert.equal(next.createdAt, 200);
  assert.equal(next.goal, '新任务：比较 PR #201 和 PR #202');
  assert.equal(next.status, 'ready');
});

test('任务提示包含预检、来源、新鲜度、禁止动作与恢复合同', () => {
  const task = compileButlerTask('关联失败构建 #9001 与提交', null, null, 100);
  const progressed = updateButlerTask(task, {
    status: 'running',
    sources: [{ kind: 'build', id: '9001', label: '构建 9001' }],
  }, 200);
  const prompt = butlerTaskPrompt(progressed);

  assert.match(prompt, /capabilityPreflight/);
  assert.match(prompt, /freshness/);
  assert.match(prompt, /prohibitedActions/);
  assert.match(prompt, /recovery/);
  assert.match(prompt, /构建 9001/);
});
