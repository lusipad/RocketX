import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCodexAutomationToml,
  serializeCodexAutomationToml,
} from '../../apps/web/src/lib/codexAutomationFiles';

const NATIVE_FIXTURE = `version = 1
id = "rocketx-issue"
kind = "cron"
name = "每小时处理 RocketX 新 Issue"
prompt = "第一行\\n\\n第二行"
status = "PAUSED"
rrule = "RRULE:FREQ=HOURLY;INTERVAL=2"
model = "gpt-5.6-sol"
reasoning_effort = "medium"
execution_environment = "local"
target = { type = "project", project_id = "local-test" }
cwds = ["D:\\\\Repos\\\\rocketchatx"]
created_at = 1784542553067
updated_at = 1785451126745
`;

test('读取 Codex automation.toml 的原生字段并忽略未知字段', () => {
  assert.deepEqual(parseCodexAutomationToml(NATIVE_FIXTURE), {
    version: 1,
    id: 'rocketx-issue',
    kind: 'cron',
    name: '每小时处理 RocketX 新 Issue',
    prompt: '第一行\n\n第二行',
    status: 'PAUSED',
    rrule: 'RRULE:FREQ=HOURLY;INTERVAL=2',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    executionEnvironment: 'local',
    target: '{ type = "project", project_id = "local-test" }',
    cwds: ['D:\\Repos\\rocketchatx'],
    createdAt: 1784542553067,
    updatedAt: 1785451126745,
  });
});

test('生成的 automation.toml 可被同一解析器读回且使用 Codex 字段名', () => {
  const definition = parseCodexAutomationToml(NATIVE_FIXTURE);
  const serialized = serializeCodexAutomationToml(definition);

  assert.match(serialized, /^version = 1/m);
  assert.match(serialized, /^reasoning_effort = "medium"/m);
  assert.match(serialized, /^execution_environment = "local"/m);
  assert.match(serialized, /^target = \{ type = "project", project_id = "local-test" \}/m);
  assert.match(serialized, /^cwds = \["D:\\\\Repos\\\\rocketchatx"\]/m);
  assert.deepEqual(parseCodexAutomationToml(serialized), definition);
});

test('heartbeat 使用 Codex 原生 target_thread_id 格式并可独立读回', () => {
  const { target: _target, ...fixture } = parseCodexAutomationToml(NATIVE_FIXTURE);
  const definition = {
    ...fixture,
    id: 'heartbeat-test',
    kind: 'heartbeat',
    targetThreadId: 'thread-123',
    cwds: [],
  };
  const serialized = serializeCodexAutomationToml(definition);

  assert.match(serialized, /^target_thread_id = "thread-123"$/m);
  assert.doesNotMatch(serialized, /^target = /m);
  assert.doesNotMatch(serialized, /^cwds = /m);
  assert.doesNotMatch(serialized, /^execution_environment = /m);
  assert.deepEqual(parseCodexAutomationToml(serialized), definition);
});

test('缺少 Codex 必填字段的文件不会进入已安排列表', () => {
  assert.throws(
    () => parseCodexAutomationToml('id = "broken"\nname = "缺少计划"\n'),
    /缺少 prompt、status、rrule/,
  );
});
