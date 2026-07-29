import assert from 'node:assert/strict';
import test from 'node:test';
import {
  butlerArtifactsForSession,
  shouldCaptureButlerArtifact,
  useButlerArtifacts,
} from '../../apps/web/src/stores/butlerArtifacts';

test('长结果自动成为可验收成果，短回答仍留在对话', () => {
  assert.equal(shouldCaptureButlerArtifact({
    id: 'short',
    role: 'assistant',
    text: '已经查完，没有发现风险。',
  }), false);
  assert.equal(shouldCaptureButlerArtifact({
    id: 'long',
    role: 'assistant',
    text: `# 发布风险报告\n\n${'真实核对结果。'.repeat(90)}`,
  }), true);
});

test('同一回答只沉淀一次，继续加工产生新版本且旧版本仍可查看', () => {
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  });
  useButlerArtifacts.setState({ artifacts: [], hydrated: true });
  const line = {
    id: 'report-line',
    role: 'assistant' as const,
    text: `# 发布风险报告\n\n${'核对结果与证据。'.repeat(80)}`,
    sources: [{ kind: 'message' as const, id: 'source-1', label: '发布协作' }],
  };
  const first = useButlerArtifacts.getState().captureLine('session-a', line);
  const second = useButlerArtifacts.getState().captureLine('session-a', line);
  assert.equal(first?.id, second?.id);
  assert.equal(first?.sessionId, 'session-a');
  assert.equal(useButlerArtifacts.getState().artifacts.length, 1);

  useButlerArtifacts.getState().revise(first!.id, '# 发布风险报告 v2\n\n已补充回滚责任人。');
  const revised = useButlerArtifacts.getState().artifacts[0]!;
  assert.deepEqual(revised.versions.map((version) => version.number), [1, 2]);
  assert.match(revised.versions[0]!.content, /核对结果与证据/);
  assert.match(revised.versions[1]!.content, /回滚责任人/);

  useButlerArtifacts.getState().accept(first!.id);
  assert.equal(useButlerArtifacts.getState().artifacts[0]!.status, 'accepted');
});

test('成果只出现在产生它的普通或房间会话，旧成果按来源行兼容', () => {
  useButlerArtifacts.setState({ artifacts: [], hydrated: true });
  const lineA = {
    id: 'session-a-line',
    role: 'assistant' as const,
    text: `# 会话 A 报告\n\n${'A 的结论。'.repeat(100)}`,
  };
  const lineB = {
    id: 'session-b-line',
    role: 'assistant' as const,
    text: `# 会话 B 报告\n\n${'B 的结论。'.repeat(100)}`,
  };
  useButlerArtifacts.getState().captureLine('session-a', lineA);
  useButlerArtifacts.getState().captureLine('session-b', lineB);

  const artifacts = useButlerArtifacts.getState().artifacts;
  assert.deepEqual(
    butlerArtifactsForSession(artifacts, 'session-a', [lineA]).map((artifact) => artifact.sessionId),
    ['session-a'],
  );
  assert.deepEqual(
    butlerArtifactsForSession(artifacts, 'session-b', [lineB]).map((artifact) => artifact.sessionId),
    ['session-b'],
  );

  const legacy = { ...artifacts[0]!, sessionId: undefined, sourceLineId: lineA.id };
  assert.deepEqual(
    butlerArtifactsForSession([legacy], 'session-a', [lineA]).map((artifact) => artifact.id),
    [legacy.id],
  );
  assert.deepEqual(butlerArtifactsForSession([legacy], 'session-b', [lineB]), []);
});
