import assert from 'node:assert/strict';
import test from 'node:test';
import {
  importLegacyButlerMemory,
  normalizeButlerMemoryState,
  parseButlerMemoryState,
  recallButlerMemory,
  rememberButlerMemory,
  restoreButlerMemory,
  revokeButlerMemory,
  serializeButlerMemoryState,
  type ButlerMemoryMutationOptions,
  type ButlerMemoryProvenance,
  type ButlerMemoryScope,
  type ButlerMemoryState,
} from '../../apps/web/src/lib/butlerMemory';

function baseScope(overrides: Partial<ButlerMemoryScope> = {}): ButlerMemoryScope {
  return {
    server: 'https://ado.example',
    account: 'alice',
    ...overrides,
  };
}

function baseProvenance(overrides: Partial<ButlerMemoryProvenance> = {}): ButlerMemoryProvenance {
  return {
    sessionId: 'session-1',
    taskId: 'task-1',
    callId: 'call-1',
    checkpointId: 'checkpoint-1',
    butlerSource: 'remember',
    summary: 'remember tool write',
    ...overrides,
  };
}

function createHarness(): { options: ButlerMemoryMutationOptions; state: ButlerMemoryState } {
  let index = 0;
  return {
    state: parseButlerMemoryState(''),
    options: {
      now: Date.UTC(2026, 6, 23, 9, 30),
      createId: () => `memory-${++index}`,
    },
  };
}

test('recall 不跨 server/account/project/room，account-only 记录可在同账号上下文召回', () => {
  const harness = createHarness();
  let state = harness.state;

  state = rememberButlerMemory(state, {
    kind: 'preference',
    scope: baseScope(),
    subject: 'reply-style',
    value: '默认简短回复',
    provenance: baseProvenance(),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 30),
  }).state;
  state = rememberButlerMemory(state, {
    kind: 'alias',
    scope: baseScope({ project: 'project-a' }),
    subject: '老李',
    value: '李建国',
    provenance: baseProvenance({ checkpointId: 'checkpoint-2' }),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 31),
  }).state;
  state = rememberButlerMemory(state, {
    kind: 'commitment',
    scope: baseScope({ room: 'release-room' }),
    subject: '周会同步',
    value: '会后补总结',
    due: '2026-07-24',
    provenance: baseProvenance({ checkpointId: 'checkpoint-3' }),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 32),
  }).state;

  assert.equal(recallButlerMemory(state, baseScope({ server: 'https://other.example' })).length, 0);
  assert.equal(recallButlerMemory(state, baseScope({ account: 'bob' })).length, 0);

  assert.deepEqual(
    recallButlerMemory(state, baseScope()).map((record) => record.subject),
    ['reply-style'],
  );
  assert.deepEqual(
    recallButlerMemory(state, baseScope({ project: 'project-a' })).map((record) => record.subject),
    ['老李', 'reply-style'],
  );
  assert.deepEqual(
    recallButlerMemory(state, baseScope({ project: 'project-b' })).map((record) => record.subject),
    ['reply-style'],
  );
  assert.deepEqual(
    recallButlerMemory(state, baseScope({ room: 'release-room' })).map((record) => record.subject),
    ['周会同步', 'reply-style'],
  );
  assert.deepEqual(
    recallButlerMemory(state, baseScope({ room: 'other-room' })).map((record) => record.subject),
    ['reply-style'],
  );
  assert.deepEqual(
    recallButlerMemory(state, baseScope({ project: 'project-a', room: 'release-room' })).map((record) => record.subject),
    ['reply-style'],
  );
});

test('同冲突键新 active 会 supersede 旧记录，revoke 不硬删，restore 会新建 active 并 supersede 当前冲突记录', () => {
  const harness = createHarness();
  let state = harness.state;

  const first = rememberButlerMemory(state, {
    kind: 'alias',
    scope: baseScope(),
    subject: '老李',
    value: '李建国',
    provenance: baseProvenance(),
  }, harness.options);
  state = first.state;

  const second = rememberButlerMemory(state, {
    kind: 'alias',
    scope: baseScope(),
    subject: '老李',
    value: '李老师',
    provenance: baseProvenance({ checkpointId: 'checkpoint-2' }),
  }, harness.options);
  state = second.state;

  assert.equal(state.records.find((record) => record.id === first.record.id)?.status, 'superseded');
  assert.equal(state.records.find((record) => record.id === second.record.id)?.status, 'active');

  const revoked = revokeButlerMemory(state, second.record.id, harness.options);
  assert.ok(revoked);
  state = revoked.state;
  assert.equal(state.records.find((record) => record.id === second.record.id)?.status, 'revoked');

  const third = rememberButlerMemory(state, {
    kind: 'alias',
    scope: baseScope(),
    subject: '老李',
    value: '李工',
    provenance: baseProvenance({ checkpointId: 'checkpoint-3' }),
  }, harness.options);
  state = third.state;
  assert.equal(state.records.find((record) => record.id === third.record.id)?.status, 'active');

  const restoreProvenance = baseProvenance({
    sessionId: 'session-restore',
    callId: 'call-restore',
    checkpointId: 'checkpoint-restore',
    butlerSource: 'restore_memory',
    summary: 'user approved restore',
  });
  const restored = restoreButlerMemory(state, second.record.id, {
    ...harness.options,
    provenance: restoreProvenance,
  });
  state = restored.state;
  assert.equal(restored.created, true);
  assert.equal(restored.record.restoredFrom, second.record.id);
  assert.equal(restored.record.status, 'active');
  assert.deepEqual(restored.record.provenance, restoreProvenance);
  assert.equal(state.records.find((record) => record.id === third.record.id)?.status, 'superseded');
  assert.equal(state.records.find((record) => record.id === restored.record.id)?.value, '李老师');
});

test('recall 只返回 active 未过期记录，并支持 query 与 limit', () => {
  const harness = createHarness();
  let state = harness.state;

  state = rememberButlerMemory(state, {
    kind: 'preference',
    scope: baseScope(),
    subject: 'reply-style',
    value: '默认简短回复',
    provenance: baseProvenance(),
    expiresAt: Date.UTC(2026, 6, 23, 10, 0),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 30),
  }).state;
  state = rememberButlerMemory(state, {
    kind: 'preference',
    scope: baseScope(),
    subject: 'meeting-style',
    value: '会议摘要三行内',
    provenance: baseProvenance({ checkpointId: 'checkpoint-2' }),
    expiresAt: Date.UTC(2026, 6, 23, 9, 0),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 31),
  }).state;
  state = rememberButlerMemory(state, {
    kind: 'alias',
    scope: baseScope(),
    subject: '老李',
    value: '李建国',
    provenance: baseProvenance({ checkpointId: 'checkpoint-3' }),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 32),
  }).state;

  assert.deepEqual(
    recallButlerMemory(state, baseScope(), {
      now: Date.UTC(2026, 6, 23, 9, 30),
      query: '简短',
      limit: 1,
    }).map((record) => record.subject),
    ['reply-style'],
  );
  assert.deepEqual(
    recallButlerMemory(state, baseScope(), {
      now: Date.UTC(2026, 6, 23, 9, 30),
    }).map((record) => record.subject),
    ['老李', 'reply-style'],
  );
});

test('相同逻辑 payload 跨 provenance 也保持幂等，subject 仅大小写差异不会绕过冲突键', () => {
  const harness = createHarness();
  const input = {
    kind: 'preference' as const,
    scope: baseScope(),
    subject: 'reply-style',
    value: '默认简短回复',
    provenance: baseProvenance(),
  };

  const first = rememberButlerMemory(harness.state, input, harness.options);
  const second = rememberButlerMemory(first.state, {
    ...input,
    subject: '  REPLY-STYLE  ',
    provenance: baseProvenance({
      sessionId: 'session-2',
      taskId: 'task-2',
      callId: 'call-2',
      checkpointId: 'checkpoint-2',
      summary: 'retry from a different checkpoint',
    }),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 12, 0),
  });

  assert.equal(second.created, false);
  assert.equal(second.record.id, first.record.id);
  assert.equal(second.state.records.length, 1);
  assert.equal(second.state.records[0]?.status, 'active');
  assert.equal(second.state.records[0]?.provenance.sessionId, 'session-1');
});

test('动态工作状态文本会被确定性拒绝', () => {
  assert.throws(
    () => rememberButlerMemory(parseButlerMemoryState(''), {
      kind: 'commitment',
      scope: baseScope(),
      subject: 'PR #123',
      value: '当前已合并',
      due: '2026-07-24',
      provenance: baseProvenance(),
    }),
    /动态工作状态不能写入长期记忆/,
  );
});

test('损坏 v2 数据会被安全过滤，serialize/parse 只保留合法记录', () => {
  const raw = JSON.stringify({
    schemaVersion: 2,
    records: [
      {
        id: 'good-1',
        kind: 'alias',
        scope: { server: 'HTTPS://ADO.EXAMPLE', account: 'Alice' },
        subject: '老李',
        value: '李建国',
        provenance: baseProvenance(),
        confidence: 'confirmed',
        createdAt: 10,
        confirmedAt: 10,
        expiresAt: null,
        status: 'active',
        supersedes: [],
      },
      {
        id: 'bad-1',
        kind: 'todo',
        scope: { server: 'bad', account: 'bad' },
        subject: '待办',
        value: '当前未完成',
        provenance: baseProvenance(),
        confidence: 'confirmed',
        createdAt: 11,
        confirmedAt: 11,
        expiresAt: null,
        status: 'active',
        supersedes: [],
      },
      {
        id: '',
        kind: 'preference',
        scope: { server: 'bad', account: 'bad' },
        subject: 'reply-style',
        value: '简短',
        provenance: baseProvenance(),
        confidence: 'confirmed',
        createdAt: 12,
        confirmedAt: 12,
        expiresAt: null,
        status: 'active',
        supersedes: [],
      },
    ],
  });

  const normalized = parseButlerMemoryState(raw);
  assert.equal(normalized.records.length, 1);
  assert.equal(normalized.records[0]?.scope.server, 'https://ado.example');
  assert.equal(normalized.records[0]?.scope.account, 'alice');

  const roundtrip = normalizeButlerMemoryState(JSON.parse(serializeButlerMemoryState(normalized)));
  assert.deepEqual(roundtrip, normalized);
});

test('legacy 记忆只有显式 import 才会变成 v2，且导入结果标记为 legacy-unverified', () => {
  const legacy = [{ id: 'legacy-1', text: '以后默认简短回复', at: 123 }];

  assert.equal(parseButlerMemoryState(JSON.stringify(legacy)).records.length, 0);

  const imported = importLegacyButlerMemory(parseButlerMemoryState(''), legacy, {
    now: Date.UTC(2026, 6, 23, 9, 30),
    createId: () => 'legacy-imported-1',
    mapLegacy: (entry) => ({
      scope: baseScope(),
      kind: 'preference',
      subject: `legacy:${entry.id}`,
      value: entry.text,
      provenance: {
        butlerSource: 'legacy-import',
        summary: 'imported from rcx-butler-v1 memory',
      },
    }),
  });

  assert.equal(imported.length, 1);
  assert.equal(imported[0]?.record.confidence, 'legacy-unverified');
  assert.equal(imported[0]?.record.confirmedAt, null);
  assert.equal(imported[0]?.record.status, 'active');
  assert.deepEqual(
    recallButlerMemory(imported[0]!.state, baseScope()).map((record) => [record.subject, record.value]),
    [['legacy:legacy-1', '以后默认简短回复']],
  );
});

test('recall 可按 kind 过滤并显式包含 superseded/revoked 历史，历史查询仍受同一 scope 约束', () => {
  const harness = createHarness();
  let state = harness.state;

  const first = rememberButlerMemory(state, {
    kind: 'alias',
    scope: baseScope({ room: 'release-room' }),
    subject: '老李',
    value: '李建国',
    provenance: baseProvenance(),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 30),
  });
  state = first.state;
  const second = rememberButlerMemory(state, {
    kind: 'alias',
    scope: baseScope({ room: 'release-room' }),
    subject: '老李',
    value: '李老师',
    provenance: baseProvenance({ checkpointId: 'checkpoint-2' }),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 31),
  });
  state = second.state;
  const revoked = revokeButlerMemory(state, second.record.id, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 32),
  });
  assert.ok(revoked);
  state = revoked.state;
  state = rememberButlerMemory(state, {
    kind: 'preference',
    scope: baseScope({ room: 'release-room' }),
    subject: 'reply-style',
    value: '默认简短回复',
    provenance: baseProvenance({ checkpointId: 'checkpoint-3' }),
    expiresAt: Date.UTC(2026, 6, 23, 9, 0),
  }, {
    ...harness.options,
    now: Date.UTC(2026, 6, 23, 9, 33),
  }).state;

  assert.deepEqual(
    recallButlerMemory(state, baseScope({ room: 'release-room' }), {
      kind: 'alias',
      now: Date.UTC(2026, 6, 23, 9, 34),
      includeInactive: true,
    }).map((record) => [record.value, record.status]),
    [['李老师', 'revoked'], ['李建国', 'superseded']],
  );
  assert.deepEqual(
    recallButlerMemory(state, baseScope({ room: 'release-room' }), {
      kind: 'preference',
      now: Date.UTC(2026, 6, 23, 9, 34),
      includeHistory: true,
    }).map((record) => [record.value, record.status]),
    [['默认简短回复', 'active']],
  );
  assert.equal(
    recallButlerMemory(state, baseScope({ room: 'other-room' }), {
      kind: 'alias',
      includeInactive: true,
      now: Date.UTC(2026, 6, 23, 9, 34),
    }).length,
    0,
  );
});
