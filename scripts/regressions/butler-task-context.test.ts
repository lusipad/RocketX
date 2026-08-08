import assert from 'node:assert/strict';
import test from 'node:test';
import {
  butlerTaskPrompt,
  compileButlerTask,
  updateButlerTask,
} from '../../apps/web/src/lib/butlerTaskContext';
import type { ButlerSurfaceContext } from '../../apps/web/src/lib/butlerContext';

const roomContext: ButlerSurfaceContext = {
  kind: 'room',
  label: '研发群',
  detail: '当前 Rocket.Chat 房间',
  sources: [{ kind: 'room', id: 'room-dev', rid: 'room-dev', label: '研发群' }],
};

test('自然语言任务不在前端澄清或指定执行路径', () => {
  const inputs = [
    '找昨天发的设计稿',
    '比较这两个 PR',
    '提取承诺',
    '统计 Azure DevOps 未关闭工作项',
    '关联失败构建与提交',
    '继续上次调查任务',
  ];

  for (const [index, input] of inputs.entries()) {
    const task = compileButlerTask(input, null, null, 1_000 + index);
    assert.equal(task.status, 'ready', input);
    assert.equal(task.manifest.clarification.required, false, input);
    assert.deepEqual(task.manifest.clarification.missing, [], input);
  }
});

test('用户补充内容由原生会话上下文理解，不被前端合并为旧任务合同', () => {
  const previous = compileButlerTask('比较这两个 PR', null, null, 100);
  const next = compileButlerTask('PR #101 和 PR #102', null, previous, 200);

  assert.notEqual(next.id, previous.id);
  assert.equal(next.goal, 'PR #101 和 PR #102');
  assert.equal(next.createdAt, 200);
  assert.equal(next.status, 'ready');
});

test('任务提示只传宿主状态，Skill 发现、工具选择和追问都交给 Codex', () => {
  const task = compileButlerTask('关联失败构建 #9001 与提交', roomContext, null, 100);
  const progressed = updateButlerTask(task, {
    status: 'running',
    sources: [{ kind: 'build', id: '9001', label: '构建 9001' }],
  }, 200);
  const prompt = butlerTaskPrompt(progressed);

  assert.match(prompt, /Codex 原生 Agent Skills/);
  assert.match(prompt, /\$skill/);
  assert.match(prompt, /构建 9001/);
  assert.doesNotMatch(prompt, /scenario|capabilityPreflight|sourcePlan|clarification|prohibitedActions|recovery/);
  assert.doesNotMatch(prompt, /不得绕过|由代码侧编译/);
});

test('任务状态仍可记录执行终态与证据，不承担语义路由', () => {
  const task = compileButlerTask('查一下', roomContext, null, 100);
  const completed = updateButlerTask(task, {
    status: 'completed',
    sources: [{ kind: 'message', id: 'm1', label: '证据消息' }],
  }, 200);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.updatedAt, 200);
  assert.deepEqual(completed.sources, [{ kind: 'message', id: 'm1', label: '证据消息' }]);
});
