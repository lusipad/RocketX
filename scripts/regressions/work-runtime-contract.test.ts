import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  availableNativeCodexIntents,
  canTransitionRuntimeCommandState,
  isNativeCommandSpecJson,
  MAX_COMMAND_JSON_BYTES,
  MAX_COMMAND_TEXT_BYTES,
  NATIVE_CODEX_COMMAND_SCHEMA,
  NATIVE_COMMAND_EXECUTOR,
  validateNativeCommandSpec,
  validateRuntimeCommandInput,
  type NativeCommandKind,
  type NativeCommandSpec,
  type RuntimeCommandInput,
  type RuntimeCommandState,
  type SessionControlAccess,
} from '../../apps/web/src/platform/workRuntimeContract';

// Rust executes this exact fixture too: wire names, rejection cases and every state edge.
const rustSource = readFileSync(new URL('../../apps/desktop/src-tauri/src/native/work_command.rs', import.meta.url), 'utf8');
const fixtureMatch = /const CONTRACT_FIXTURE_JSON: &str = r#"([\s\S]*?)"#;/.exec(rustSource);
assert.ok(fixtureMatch, '原生合同必须保留两端共同使用的 fixture');
const fixture = JSON.parse(fixtureMatch[1]) as {
  input: RuntimeCommandInput;
  scope: NativeCommandSpec['scope'];
  binding: NativeCommandSpec['binding'];
  inputCases: Array<{ valid: boolean; patch: Record<string, unknown> }>;
  access: Record<SessionControlAccess, NativeCommandKind[]>;
  transitions: Record<RuntimeCommandState, RuntimeCommandState[]>;
};

function spec(): NativeCommandSpec {
  return {
    schema: NATIVE_CODEX_COMMAND_SCHEMA,
    executor: NATIVE_COMMAND_EXECUTOR,
    requestId: fixture.input.requestId,
    todoId: fixture.input.todoId,
    scope: structuredClone(fixture.scope),
    binding: structuredClone(fixture.binding),
    expected: {
      requirementsVersion: fixture.input.expectedRequirementsVersion,
      contentVersion: fixture.input.expectedContentVersion,
      nativeTurnId: fixture.input.nativeTurnId,
    },
    intent: structuredClone(fixture.input.intent),
    submittedBy: fixture.input.submittedBy,
  };
}

test('原生命令共享有效合同，保持工作及原会话 ID 和用户正文', () => {
  const input = structuredClone(fixture.input);
  const before = JSON.stringify(input);
  validateRuntimeCommandInput(input);
  const frozen = spec();
  const beforeSpec = JSON.stringify(frozen);
  validateNativeCommandSpec(frozen);
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(frozen), beforeSpec, '展示侧校验不能 trim 或改写正文');
  assert.equal(frozen.todoId, 'existing-work');
  assert.equal(frozen.binding.nativeThreadId, 'original-thread');
  assert.deepEqual(frozen.intent, input.intent);
});

test('原生命令的 Rust/TS 共同输入样例包含未知字段、错动作、错轮次及版本拒绝', () => {
  for (const scenario of fixture.inputCases) {
    const candidate = { ...structuredClone(fixture.input), ...structuredClone(scenario.patch) };
    if (scenario.valid) assert.doesNotThrow(() => validateRuntimeCommandInput(candidate), JSON.stringify(scenario));
    else assert.throws(() => validateRuntimeCommandInput(candidate), JSON.stringify(scenario));
  }
});

test('排队默认省略，只允许新轮次指令显式排队且不修改正文', () => {
  assert.equal(Object.hasOwn(fixture.input, 'queueAfterTurn'), false);
  const input: RuntimeCommandInput = { ...fixture.input, intent: { kind: 'prompt', text: '  下一轮\n' }, nativeTurnId: null, queueAfterTurn: true };
  const before = JSON.stringify(input);
  validateRuntimeCommandInput(input);
  assert.equal(JSON.stringify(input), before);
  const frozen = { ...spec(), intent: input.intent, expected: { ...spec().expected, nativeTurnId: null }, queueAfterTurn: true };
  assert.doesNotThrow(() => validateNativeCommandSpec(frozen));
  assert.throws(() => validateNativeCommandSpec({ ...spec(), queueAfterTurn: true }), /只有新轮次/);
  assert.throws(() => validateNativeCommandSpec({ ...frozen, queueAfterTurn: null }));
});

test('UTF-8 尺寸有界且正文不规范化，不接受无法传给 Rust 的孤立代理项', () => {
  const input = structuredClone(fixture.input);
  input.intent = { kind: 'steer', text: 'a'.repeat(MAX_COMMAND_TEXT_BYTES) };
  assert.doesNotThrow(() => validateRuntimeCommandInput(input));
  input.intent.text += 'a';
  assert.throws(() => validateRuntimeCommandInput(input), /256 KiB/);
  input.intent.text = '中'.repeat(Math.floor(MAX_COMMAND_TEXT_BYTES / 3) + 1);
  assert.throws(() => validateRuntimeCommandInput(input), /256 KiB/);
  input.intent.text = '😀';
  assert.doesNotThrow(() => validateRuntimeCommandInput(input));
  input.intent.text = '\uD800';
  assert.throws(() => validateRuntimeCommandInput(input));
  input.intent.text = '\0'.repeat(MAX_COMMAND_TEXT_BYTES / 2);
  assert.ok(new TextEncoder().encode(JSON.stringify(input)).length > MAX_COMMAND_JSON_BYTES);
  assert.throws(() => validateRuntimeCommandInput(input), /512 KiB/);
  input.intent = structuredClone(fixture.input.intent);
  input.requestId = 'x'.repeat(256);
  assert.doesNotThrow(() => validateRuntimeCommandInput(input));
  input.requestId += 'x';
  assert.throws(() => validateRuntimeCommandInput(input), /requestId/);
});

test('冻结规格校验拒绝缺少来源身份、版本越界及未知嵌套字段', () => {
  const changes = [
    (value: NativeCommandSpec) => { value.schema = 'unknown' as typeof NATIVE_CODEX_COMMAND_SCHEMA; },
    (value: NativeCommandSpec) => { value.scope.accountScope = ''; },
    (value: NativeCommandSpec) => { value.scope.accountGeneration = -1; },
    (value: NativeCommandSpec) => { value.scope.accountGeneration = Number.MAX_SAFE_INTEGER + 1; },
    (value: NativeCommandSpec) => { value.binding.sourceScope = ''; },
    (value: NativeCommandSpec) => { value.binding.executionProfileId = ''; },
    (value: NativeCommandSpec) => { value.binding.workspaceRoot = ''; },
    (value: NativeCommandSpec) => { value.binding.bindingVersion = -1; },
    (value: NativeCommandSpec) => { value.expected.contentVersion = 1.5; },
    (value: NativeCommandSpec) => { Object.assign(value.scope, { apiKey: 'synthetic-not-allowed' }); },
    (value: NativeCommandSpec) => { Object.assign(value.binding, { controlMode: 'controllable' }); },
    (value: NativeCommandSpec) => { Object.assign(value.expected, { ignoreVersion: true }); },
  ];
  for (const change of changes) {
    const candidate = spec();
    change(candidate);
    assert.throws(() => validateNativeCommandSpec(candidate));
  }
});

test('原生命令所有权识别不会被误用为有效性或执行许可', () => {
  assert.equal(isNativeCommandSpecJson(JSON.stringify(spec())), true);
  const ownershipOnly = JSON.stringify({ schema: NATIVE_CODEX_COMMAND_SCHEMA, executor: NATIVE_COMMAND_EXECUTOR });
  assert.equal(isNativeCommandSpecJson(ownershipOnly), true);
  assert.throws(() => validateNativeCommandSpec(JSON.parse(ownershipOnly)));
  assert.equal(isNativeCommandSpecJson('{'), false);
  assert.equal(isNativeCommandSpecJson('null'), false);
  assert.equal(isNativeCommandSpecJson(JSON.stringify({ schema: NATIVE_CODEX_COMMAND_SCHEMA, executor: 'web' })), false);
  assert.equal(isNativeCommandSpecJson(JSON.stringify({ specText: 'legacy' })), false);
});

test('全部状态边与 Rust fixture 一致：未知投递和终态不能回到待发送', () => {
  const states = Object.keys(fixture.transitions) as RuntimeCommandState[];
  for (const from of states) {
    for (const to of states) {
      assert.equal(canTransitionRuntimeCommandState(from, to), fixture.transitions[from].includes(to), `${from} -> ${to}`);
    }
  }
  assert.equal(canTransitionRuntimeCommandState('verifying_delivery', 'prepared'), false);
  assert.equal(canTransitionRuntimeCommandState('acknowledged', 'prepared'), false);
  assert.equal(canTransitionRuntimeCommandState('completed', 'dispatched'), false);
  assert.equal(canTransitionRuntimeCommandState('not_a_state' as RuntimeCommandState, 'not_a_state' as RuntimeCommandState), false);
});

test('记录、原 ID 恢复及两种实时控制均只展示显式已验证方法的交集', () => {
  const kinds: NativeCommandKind[] = ['resume', 'prompt', 'steer', 'interrupt'];
  for (const access of Object.keys(fixture.access) as SessionControlAccess[]) {
    assert.deepEqual(availableNativeCodexIntents(access, kinds), fixture.access[access]);
    assert.deepEqual(availableNativeCodexIntents(access, []), [], '空能力不能因为 provider 是 Codex 自动变为可控');
  }
  assert.deepEqual(availableNativeCodexIntents('managed_live', ['prompt', 'prompt']), ['prompt']);
  assert.deepEqual(availableNativeCodexIntents('resumable', ['steer']), []);
  assert.deepEqual(availableNativeCodexIntents('external_attach', ['steer']), ['steer']);
});
