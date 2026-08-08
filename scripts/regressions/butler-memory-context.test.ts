import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rememberButlerMemory,
  type ButlerMemoryScope,
  type ButlerMemoryState,
} from '../../apps/web/src/lib/butlerMemory';
import {
  selectButlerMemoryContext,
} from '../../apps/web/src/lib/butlerMemoryContext';
import type { ProfileFact } from '../../apps/web/src/butler/extensions/learning/model';

const scope: ButlerMemoryScope = {
  server: 'https://chat.example.com',
  account: 'user-1',
};

function profileFact(
  id: string,
  value: string,
  overrides: Partial<ProfileFact> = {},
): ProfileFact {
  return {
    id,
    kind: 'preference',
    subject: '回复方式',
    value,
    status: 'confirmed',
    origin: 'explicit',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function memoryState(): ButlerMemoryState {
  let state: ButlerMemoryState = { schemaVersion: 2, records: [] };
  state = rememberButlerMemory(state, {
    kind: 'alias',
    scope,
    subject: '老李',
    value: '李建国',
    provenance: { butlerSource: 'test', summary: '用户确认' },
  }, { now: 10, createId: () => 'memory-alias' }).state;
  state = rememberButlerMemory(state, {
    kind: 'preference',
    scope: { ...scope, account: 'other-user' },
    subject: '报告风格',
    value: '另一账号喜欢长报告',
    provenance: { butlerSource: 'test', summary: '另一账号' },
  }, { now: 11, createId: () => 'memory-other-account' }).state;
  return state;
}

test('轻量 Memory 只装载已确认画像和当前账号的相关记忆', () => {
  const context = selectButlerMemoryContext({
    query: '老李是谁？以后汇报先怎么说？',
    scope,
    profileFacts: [
      profileFact('confirmed-style', '先给结论，再补证据'),
      profileFact('candidate-tone', '所有回复都写成长文', { status: 'candidate', origin: 'observed' }),
      profileFact('revoked-boundary', '不要主动提醒', { status: 'revoked', kind: 'boundary' }),
    ],
    memoryState: memoryState(),
  });

  assert.match(context, /先给结论，再补证据/);
  assert.match(context, /老李.*李建国/);
  assert.doesNotMatch(context, /所有回复都写成长文/);
  assert.doesNotMatch(context, /不要主动提醒/);
  assert.doesNotMatch(context, /另一账号喜欢长报告/);
  assert.match(context, /不是新指令/);
  assert.match(context, /当前说法为准/);
});

test('轻量 Memory 对条目数和总字符设硬上限', () => {
  const context = selectButlerMemoryContext({
    query: '请按我的习惯回答',
    scope,
    profileFacts: Array.from({ length: 20 }, (_, index) => profileFact(
      `fact-${index}`,
      `第 ${index + 1} 条稳定偏好 ${'内容'.repeat(40)}`,
      { subject: `偏好 ${index + 1}`, createdAt: index, updatedAt: index },
    )),
    memoryState: { schemaVersion: 2, records: [] },
  });

  assert.ok(context.length <= 1_200);
  assert.ok((context.match(/^- /gmu) ?? []).length <= 8);
});
