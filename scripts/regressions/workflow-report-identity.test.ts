import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkflowExecutionReport } from '../../apps/web/src/agent/workflowReport';
import type { NativeWorkCard } from '../../apps/web/src/platform/desktopCommands';

function card(): NativeWorkCard {
  return { id: 'work', title: '稳定工作', state: { stage: 'verifying', waitState: 'none', acceptance: ['CI 构建通过'], consecutiveFailures: 0, requirementsVersion: 2, contentVersion: 1 } } as NativeWorkCard;
}

test('同一工作版本与汇报内容跨hydration和时间变化保持相同报告身份', () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 100;
    const first = buildWorkflowExecutionReport({ card: card(), evidences: [], links: [], sessions: [] });
    Date.now = () => 9000;
    const hydrated = buildWorkflowExecutionReport(structuredClone({ card: card(), evidences: [], links: [], sessions: [] }));
    assert.notEqual(first.generatedAt, hydrated.generatedAt);
    assert.equal(first.markdown, hydrated.markdown);
    assert.equal(first.id, hydrated.id);
  } finally { Date.now = originalNow; }
});

test('工作、要求、成果版本或实际汇报内容变化时形成新身份', () => {
  const base = card(); const first = buildWorkflowExecutionReport({ card: base });
  for (const changed of [
    { ...base, id: 'other-work' },
    { ...base, state: { ...base.state, requirementsVersion: 3 } },
    { ...base, state: { ...base.state, contentVersion: 2 } },
    { ...base, title: '真实内容变化' },
  ]) assert.notEqual(buildWorkflowExecutionReport({ card: changed }).id, first.id);
});
