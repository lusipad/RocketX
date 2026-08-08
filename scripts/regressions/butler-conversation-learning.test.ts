import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildButlerTaskOperation,
  isButlerSkillDraftRequest,
} from '../../apps/web/src/butler/extensions/learning/conversationReceipt';
import type { ButlerTaskState } from '../../apps/web/src/lib/butlerTaskContext';

function task(
  scenario: ButlerTaskState['manifest']['scenario'],
  status: ButlerTaskState['status'],
): ButlerTaskState {
  return {
    id: 'task-1',
    goal: '这里是不能进入学习回执的原始问题',
    status,
    createdAt: 1,
    updatedAt: 2,
    manifest: {
      schemaVersion: 1,
      scenario,
      capabilityPreflight: { available: [], missing: [] },
      sourcePlan: [],
      clarification: { required: false, missing: [] },
      prohibitedActions: [],
      recovery: '重新执行',
    },
    sources: [],
  };
}

test('已完成的真实工作写入稳定语义场景，不保留原始问题', () => {
  const operation = buildButlerTaskOperation(
    task('compare-pull-requests', 'completed'),
    'conversation',
    100,
  );

  assert.deepEqual(operation, {
    action: 'ask-butler',
    intentKey: 'workflow:pr-comparison',
    surface: 'conversation',
    outcome: 'completed',
    at: 100,
  });
  assert.doesNotMatch(JSON.stringify(operation), /原始问题/);
});

test('已有 Skill 使用真实名称去重，恢复与通用工作流不误生成新 Skill', () => {
  assert.equal(
    buildButlerTaskOperation(task('extract-commitments', 'completed'), 'conversation').intentKey,
    'workflow:commitment-extraction',
  );
  assert.equal(
    buildButlerTaskOperation(task('create-weekly-routine', 'completed'), 'conversation').intentKey,
    'workflow:weekly-report',
  );
  assert.equal(
    buildButlerTaskOperation(task('resume-task', 'completed'), 'conversation').intentKey,
    'ask:resume-task',
  );
  assert.equal(
    buildButlerTaskOperation(task('workflow', 'completed'), 'conversation').intentKey,
    'ask:workflow',
  );
});

test('普通问答保持 ad-hoc，失败和暂停不会成为成功候选', () => {
  assert.deepEqual(
    buildButlerTaskOperation(task('general', 'completed'), 'conversation'),
    {
      action: 'ask-butler',
      intentKey: 'ask:ad-hoc',
      surface: 'conversation',
      outcome: 'completed',
    },
  );
  assert.equal(
    buildButlerTaskOperation(task('associate-build-failure', 'failed'), 'now').outcome,
    'failed',
  );
  assert.equal(
    buildButlerTaskOperation(task('associate-build-failure', 'paused'), 'now').outcome,
    'cancelled',
  );
});

test('完整对话与今日纸发送入口共用同一语义回执入口', () => {
  const conversation = readFileSync(
    'apps/web/src/components/ButlerConversation.tsx',
    'utf8',
  );
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');

  assert.match(conversation, /recordButlerConversationTurn\(/);
  assert.match(page, /recordButlerConversationTurn\(/);
  assert.doesNotMatch(page, /recordOperation\('ask-butler', 'ask:ad-hoc'/);
});

test('只有明确要求沉淀当前做法时才进入 Skill 草稿流程', () => {
  for (const value of [
    '把这套做法保存为 Skill',
    '把刚才的方法保存成 Skill',
    '将刚才的流程沉淀成技能',
    '这个工作流做成一个 skill',
    '别忘了把刚才的方法保存为 Skill',
    '不要发消息，把刚才的方法保存为 Skill',
    '不要把刚才的方法保存为 Skill，但是还是把它做成技能',
  ]) {
    assert.equal(isButlerSkillDraftRequest(value), true, value);
  }
  for (const value of [
    '打开技能中心',
    'Skill 是什么？',
    '把这个 Skill 保存为 JSON 文件',
    '把这个 Skill 的步骤保存成文档',
    '不要把刚才的方法保存为 Skill',
    '别把这个流程做成技能',
    '把这个文件保存为 SKILL.md',
    '把刚才的方法保存为 Skill，但是不要把它保存为 Skill',
    '把刚才的方法保存为 Skill，算了',
    '把刚才的方法保存为 Skill，还是先不保存了',
    '保存这个文件',
    '以后回答简短一点',
  ]) {
    assert.equal(isButlerSkillDraftRequest(value), false, value);
  }
});
