import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCardCompletionGate } from '../../apps/web/src/agent/workCoordinator';
import type { NativeWorkCard, NativeWorkEvidence } from '../../apps/web/src/platform/desktopCommands';

const card = {
  id: 'work', title: '修复缺陷', done: false,
  state: { goal: '修复并验证', acceptance: ['单测通过', 'CI通过'], requirementsVersion: 2,
    contentVersion: 3, ownerKind: 'ai_dispatched', stage: 'verifying', waitState: 'none' },
} as NativeWorkCard;
function evidence(overrides: Partial<NativeWorkEvidence> = {}): NativeWorkEvidence {
  return { id: 'ev', todoId: 'work', kind: 'test_run', title: '测试结果', passed: true,
    stale: false, criterionIds: ['单测通过'], requirementsVersion: 2, contentVersion: 3,
    ...overrides } as NativeWorkEvidence;
}
test('完成要求逐项覆盖当前要求及内容版本，单项通过不能完成全部工作', () => {
  assert.equal(evaluateCardCompletionGate(card, [evidence()]).canMarkDone, false);
  assert.equal(evaluateCardCompletionGate(card, [evidence(), evidence({ id: 'ci', kind: 'ci_build', criterionIds: ['CI通过'] })]).canMarkDone, true);
  assert.equal(evaluateCardCompletionGate(card, [evidence({ criterionIds: card.state.acceptance, requirementsVersion: 1 })]).canMarkDone, false);
  assert.equal(evaluateCardCompletionGate(card, [evidence({ criterionIds: card.state.acceptance, contentVersion: 2 })]).canMarkDone, false);
});
test('汇报、旧人工布尔值和无身份人工证据不能自证完成', () => {
  for (const kind of ['agent_report', 'manual_note', 'manual_ack'] as const) {
    assert.equal(evaluateCardCompletionGate(card, [evidence({ kind, criterionIds: card.state.acceptance })], true).canMarkDone, false);
  }
  assert.equal(evaluateCardCompletionGate(card, [evidence({ kind: 'manual_ack', criterionIds: card.state.acceptance, acceptedBy: 'alice', acceptanceScope: card.state.acceptance })]).canMarkDone, true);
});
test('等待审批或缺少明确目标不能由证据清掉等待并宣告完成', () => {
  const ev = evidence({ criterionIds: card.state.acceptance });
  assert.equal(evaluateCardCompletionGate({ ...card, state: { ...card.state, waitState: 'waiting_approval' } }, [ev]).canMarkDone, false);
  assert.equal(evaluateCardCompletionGate({ ...card, state: { ...card.state, goal: null } }, [ev]).canMarkDone, false);
});
