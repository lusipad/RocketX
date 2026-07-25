import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

async function loadContract() {
  return import(pathToFileURL(resolve(process.cwd(), 'apps/web/src/lib/butlerEngineContract.ts')).href);
}

test('全新会话从 0 起步：整段 transcript 会作为 bridge 喂给新线程', async () => {
  const contract = await loadContract();
  const state = contract.initializeButlerEngineState({
    transcript: [
      { revision: 1, role: 'user', text: '第一问' },
      { revision: 2, role: 'assistant', text: '第一答' },
    ],
  });

  assert.deepEqual(state, {
    version: 2,
    status: 'ready',
    transcriptRevision: 2,
    resumeRevision: 0,
    compatibility: { mode: 'native', reason: null },
  });
});

test('已有线程的会话按当前进度接着走，不重复喂历史', async () => {
  const contract = await loadContract();
  const state = contract.initializeButlerEngineState({
    resumed: true,
    transcript: [
      { revision: 1, role: 'user', text: '第一问' },
      { revision: 2, role: 'assistant', text: '第一答' },
    ],
  });

  assert.equal(state.resumeRevision, 2);
});

test('prepare turn 在进度一致时保持 native 兼容且不桥接 transcript', async () => {
  const contract = await loadContract();
  const prepared = contract.prepareButlerEngineTurn({
    engineState: {
      version: 2,
      status: 'ready',
      transcriptRevision: 2,
      resumeRevision: 2,
      compatibility: { mode: 'native', reason: null },
    },
    transcript: [
      { revision: 1, role: 'user', text: '第一问' },
      { revision: 2, role: 'assistant', text: '第一答' },
    ],
  });

  assert.deepEqual(prepared, {
    engineState: {
      version: 2,
      status: 'running',
      transcriptRevision: 2,
      resumeRevision: 2,
      compatibility: { mode: 'native', reason: null },
    },
    bridgeTranscript: [],
    compatibility: { mode: 'native', reason: null },
  });
});

test('引擎落后于 transcript 时只桥接未见的行并显式标记 transcript 兼容', async () => {
  const contract = await loadContract();
  const prepared = contract.prepareButlerEngineTurn({
    engineState: {
      version: 2,
      status: 'ready',
      transcriptRevision: 3,
      resumeRevision: 1,
      compatibility: { mode: 'native', reason: null },
    },
    transcript: [
      { revision: 1, role: 'user', text: '第一问' },
      { revision: 2, role: 'assistant', text: '第一答' },
      { revision: 3, role: 'user', text: '第二问' },
    ],
  });

  assert.deepEqual(prepared.compatibility, { mode: 'transcript', reason: 'transcript-behind' });
  assert.deepEqual(prepared.bridgeTranscript, [
    { revision: 2, role: 'assistant', text: '第一答' },
    { revision: 3, role: 'user', text: '第二问' },
  ]);
});

test('引擎进度落在可见 transcript 窗口之外时显式标记不可兼容且完成后不伪装为 native', async () => {
  const contract = await loadContract();
  const prepared = contract.prepareButlerEngineTurn({
    engineState: {
      version: 2,
      status: 'ready',
      transcriptRevision: 22,
      resumeRevision: 10,
      compatibility: { mode: 'native', reason: null },
    },
    transcript: [
      { revision: 21, role: 'user', text: '窗口内问题' },
      { revision: 22, role: 'assistant', text: '窗口内回答' },
    ],
  });

  assert.deepEqual(prepared.compatibility, { mode: 'incompatible', reason: 'transcript-gap' });
  assert.deepEqual(prepared.bridgeTranscript.map((line: { revision: number }) => line.revision), [21, 22]);
  assert.deepEqual(
    contract.completeButlerEngineTurn(prepared.engineState, { transcriptRevision: 24 }).compatibility,
    { mode: 'incompatible', reason: 'transcript-gap' },
  );
});

test('complete turn 会把 resume revision 推进到最新 transcript revision', async () => {
  const contract = await loadContract();
  const state = contract.completeButlerEngineTurn({
    version: 2,
    status: 'running',
    transcriptRevision: 3,
    resumeRevision: 1,
    compatibility: { mode: 'transcript', reason: 'transcript-behind' },
  }, {
    transcriptRevision: 4,
  });

  assert.deepEqual(state, {
    version: 2,
    status: 'ready',
    transcriptRevision: 4,
    resumeRevision: 4,
    compatibility: { mode: 'native', reason: null },
  });
});

test('fail turn 会保留 transcript revision 并显式进入 incompatible 状态而不是静默丢上下文', async () => {
  const contract = await loadContract();
  const state = contract.failButlerEngineTurn({
    version: 2,
    status: 'running',
    transcriptRevision: 4,
    resumeRevision: 4,
    compatibility: { mode: 'native', reason: null },
  }, {
    error: 'resume-mismatch',
  });

  assert.deepEqual(state, {
    version: 2,
    status: 'failed',
    transcriptRevision: 4,
    resumeRevision: 4,
    compatibility: { mode: 'incompatible', reason: 'resume-mismatch' },
  });
});

test('pause turn 会保留 transcript revision 供后续 resume 继续', async () => {
  const contract = await loadContract();
  const state = contract.pauseButlerEngineTurn({
    version: 2,
    status: 'running',
    transcriptRevision: 2,
    resumeRevision: 2,
    compatibility: { mode: 'native', reason: null },
  });

  assert.deepEqual(state, {
    version: 2,
    status: 'paused',
    transcriptRevision: 2,
    resumeRevision: 2,
    compatibility: { mode: 'native', reason: null },
  });
});

test('双大脑时代的 version 1 持久化数据被拒绝，调用方回退到冷启动', async () => {
  const contract = await loadContract();
  assert.equal(contract.normalizeButlerEngineState({
    version: 1,
    activeBrain: 'codex',
    status: 'ready',
    transcriptRevision: 2,
    resumeRevisionByBrain: { api: 0, codex: 2 },
    compatibility: { mode: 'native', reason: null },
  }), undefined);
});

test('normalize 恢复完整的 version 2 state 并拒绝残缺字段', async () => {
  const contract = await loadContract();
  const valid = {
    version: 2,
    status: 'paused',
    transcriptRevision: 5,
    resumeRevision: 3,
    compatibility: { mode: 'transcript', reason: 'interrupted-turn' },
  };
  assert.deepEqual(contract.normalizeButlerEngineState(valid), valid);
  assert.equal(contract.normalizeButlerEngineState({ ...valid, resumeRevision: -1 }), undefined);
  assert.equal(contract.normalizeButlerEngineState({ ...valid, compatibility: undefined }), undefined);
});
