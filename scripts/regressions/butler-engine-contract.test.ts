import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

async function loadContract() {
  return import(pathToFileURL(resolve(process.cwd(), 'apps/web/src/lib/butlerEngineContract.ts')).href);
}

test('旧 session 无 engineState 时按当前 transcript 初始化版本化 engine state', async () => {
  const contract = await loadContract();
  const state = contract.initializeButlerEngineState({
    activeBrain: 'api',
    transcript: [
      { revision: 1, role: 'user', text: '第一问' },
      { revision: 2, role: 'assistant', text: '第一答' },
    ],
  });

  assert.deepEqual(state, {
    version: 1,
    activeBrain: 'api',
    status: 'ready',
    transcriptRevision: 2,
    resumeRevisionByBrain: { api: 2, codex: 0 },
    compatibility: { mode: 'native', reason: null },
  });
});

test('prepare turn 在同脑继续时保持 native 兼容且不桥接 transcript', async () => {
  const contract = await loadContract();
  const prepared = contract.prepareButlerEngineTurn({
    engineState: {
      version: 1,
      activeBrain: 'api',
      status: 'ready',
      transcriptRevision: 2,
      resumeRevisionByBrain: { api: 2, codex: 1 },
      compatibility: { mode: 'native', reason: null },
    },
    targetBrain: 'api',
    transcript: [
      { revision: 1, role: 'user', text: '第一问' },
      { revision: 2, role: 'assistant', text: '第一答' },
    ],
  });

  assert.deepEqual(prepared, {
    engineState: {
      version: 1,
      activeBrain: 'api',
      status: 'running',
      transcriptRevision: 2,
      resumeRevisionByBrain: { api: 2, codex: 1 },
      compatibility: { mode: 'native', reason: null },
    },
    bridgeTranscript: [],
    compatibility: { mode: 'native', reason: null },
  });
});

test('prepare turn 在跨脑切换时只桥接目标脑未见 transcript 并显式标记 transcript 兼容', async () => {
  const contract = await loadContract();
  const prepared = contract.prepareButlerEngineTurn({
    engineState: {
      version: 1,
      activeBrain: 'api',
      status: 'ready',
      transcriptRevision: 3,
      resumeRevisionByBrain: { api: 3, codex: 1 },
      compatibility: { mode: 'native', reason: null },
    },
    targetBrain: 'codex',
    transcript: [
      { revision: 1, role: 'user', text: '第一问' },
      { revision: 2, role: 'assistant', text: '第一答' },
      { revision: 3, role: 'user', text: '第二问' },
    ],
  });

  assert.deepEqual(prepared, {
    engineState: {
      version: 1,
      activeBrain: 'codex',
      status: 'running',
      transcriptRevision: 3,
      resumeRevisionByBrain: { api: 3, codex: 1 },
      compatibility: { mode: 'transcript', reason: 'brain-switched' },
    },
    bridgeTranscript: [
      { revision: 2, role: 'assistant', text: '第一答' },
      { revision: 3, role: 'user', text: '第二问' },
    ],
    compatibility: { mode: 'transcript', reason: 'brain-switched' },
  });
});

test('目标脑落后于当前可见 transcript 窗口时显式标记不可兼容且完成后不伪装为 native', async () => {
  const contract = await loadContract();
  const prepared = contract.prepareButlerEngineTurn({
    engineState: {
      version: 1,
      activeBrain: 'api',
      status: 'ready',
      transcriptRevision: 22,
      resumeRevisionByBrain: { api: 22, codex: 10 },
      compatibility: { mode: 'native', reason: null },
    },
    targetBrain: 'codex',
    transcript: [
      { revision: 21, role: 'user', text: '窗口内问题' },
      { revision: 22, role: 'assistant', text: '窗口内回答' },
    ],
  });

  assert.deepEqual(prepared.compatibility, { mode: 'incompatible', reason: 'transcript-gap' });
  assert.deepEqual(prepared.bridgeTranscript.map((line) => line.revision), [21, 22]);
  assert.deepEqual(
    contract.completeButlerEngineTurn(prepared.engineState, {
      completedBrain: 'codex',
      transcriptRevision: 24,
    }).compatibility,
    { mode: 'incompatible', reason: 'transcript-gap' },
  );
});

test('complete turn 会把当前脑的 resume revision 推进到最新 transcript revision', async () => {
  const contract = await loadContract();
  const state = contract.completeButlerEngineTurn({
    version: 1,
    activeBrain: 'codex',
    status: 'running',
    transcriptRevision: 3,
    resumeRevisionByBrain: { api: 3, codex: 1 },
    compatibility: { mode: 'transcript', reason: 'brain-switched' },
  }, {
    completedBrain: 'codex',
    transcriptRevision: 4,
  });

  assert.deepEqual(state, {
    version: 1,
    activeBrain: 'codex',
    status: 'ready',
    transcriptRevision: 4,
    resumeRevisionByBrain: { api: 3, codex: 4 },
    compatibility: { mode: 'native', reason: null },
  });
});

test('fail turn 会保留 transcript revision 并显式进入 incompatible 状态而不是静默丢上下文', async () => {
  const contract = await loadContract();
  const state = contract.failButlerEngineTurn({
    version: 1,
    activeBrain: 'codex',
    status: 'running',
    transcriptRevision: 4,
    resumeRevisionByBrain: { api: 3, codex: 4 },
    compatibility: { mode: 'native', reason: null },
  }, {
    failedBrain: 'codex',
    error: 'resume-mismatch',
  });

  assert.deepEqual(state, {
    version: 1,
    activeBrain: 'codex',
    status: 'failed',
    transcriptRevision: 4,
    resumeRevisionByBrain: { api: 3, codex: 4 },
    compatibility: { mode: 'incompatible', reason: 'resume-mismatch' },
  });
});

test('pause turn 会保留当前脑和 transcript revision 供后续 resume 继续', async () => {
  const contract = await loadContract();
  const state = contract.pauseButlerEngineTurn({
    version: 1,
    activeBrain: 'api',
    status: 'running',
    transcriptRevision: 2,
    resumeRevisionByBrain: { api: 2, codex: 0 },
    compatibility: { mode: 'native', reason: null },
  }, {
    pausedBrain: 'api',
  });

  assert.deepEqual(state, {
    version: 1,
    activeBrain: 'api',
    status: 'paused',
    transcriptRevision: 2,
    resumeRevisionByBrain: { api: 2, codex: 0 },
    compatibility: { mode: 'native', reason: null },
  });
});
