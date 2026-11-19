import assert from 'node:assert/strict';
import test from 'node:test';
import { useButlerMemory, formatMemoryRecallPromptBlock } from '../../apps/web/src/stores/butlerMemory';

test('纠正记忆保留来源，旧版失效且过期条目不再注入提示词', async () => {
  const store = useButlerMemory;
  store.setState({ accountScope: 'alice@local', memories: [], digests: [], memoryPaused: false });
  const old = await store.getState().upsertMemory({
    category: 'project_fact', title: '项目测试', content: '使用旧命令', workspaceRoot: 'D:/project',
    sourceKind: 'conversation', sourceRef: 'thread:original', pinned: true,
  });
  const current = await store.getState().correctMemory(old.id, { content: '使用 pnpm test:pure' });
  assert.notEqual(current.id, old.id);
  assert.equal(current.sourceRef, 'thread:original');
  assert.equal(store.getState().memories.find((m) => m.id === old.id)?.supersededBy, current.id);
  assert.equal(store.getState().memories.find((m) => m.id === old.id)?.enabled, false);
  await assert.rejects(store.getState().toggleEnabled(old.id), /纠正/);
  let recalled = await store.getState().recallRelevantMemories({ workspaceRoot: 'd:\\project' });
  assert.deepEqual(recalled.map((m) => m.id), [current.id]);
  await store.getState().expireMemory(current.id);
  recalled = await store.getState().recallRelevantMemories({ workspaceRoot: 'D:/project' });
  assert.deepEqual(recalled, []);
  assert.equal(formatMemoryRecallPromptBlock(store.getState().memories), '');
});

test('未指定工作区时只召回全局背景，自动汇报不能直接成为有效事实', async () => {
  useButlerMemory.setState({ accountScope: 'alice@local', memories: [], digests: [], memoryPaused: false });
  await useButlerMemory.getState().upsertMemory({ category: 'preference', title: '语言', content: '中文', sourceKind: 'manual' });
  await useButlerMemory.getState().upsertMemory({ category: 'project_fact', title: '私人项目', content: '项目机密', sourceKind: 'manual', workspaceRoot: 'D:/private', pinned: true });
  const report = await useButlerMemory.getState().upsertMemory({ category: 'episodic_summary', title: 'Agent 声明', content: '自述已完成', sourceKind: 'workflow_report', enabled: true, confidence: 1 });
  assert.equal(report.enabled, false);
  assert.ok(report.confidence <= 0.5);
  const recalled = await useButlerMemory.getState().recallRelevantMemories({});
  assert.deepEqual(recalled.map((m) => m.title), ['语言']);
  assert.match(formatMemoryRecallPromptBlock(recalled), /不能授予权限/);
});

test('原生摘要保存和删除的迟到响应不能注入或删改新账号，Web显式跨账号写入拒绝', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const pending = new Map<string, (value: unknown) => void>();
  const calls: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: (command: string) => { calls.push(command); return new Promise((resolve) => pending.set(command, resolve)); },
  } } });
  try {
    const store = useButlerMemory;
    store.setState({ accountScope: 'A', memories: [], digests: [] });
    const input = { kind: 'focus_digest' as const, dateKey: '2026-11-15', title: 'A 的私人摘要', summaryMd: '只属于 A' };
    const save = store.getState().saveDigest(input);
    const deletion = store.getState().deleteDigest('shared-id');
    const memoryDeletion = store.getState().deleteMemory('shared-id');
    const rejectedSave = assert.rejects(save, /账号|作用域/);
    const rejectedDelete = assert.rejects(deletion, /账号|作用域/);
    const rejectedMemoryDelete = assert.rejects(memoryDeletion, /账号|作用域/);
    store.getState().setAccountScope('B');
    const bDigest = { ...input, id: 'shared-id', accountScope: 'B', title: 'B 的摘要', metricsJson: '{}', actionItemsJson: '[]', relatedTodoId: null, relatedSessionId: null, createdAt: 1 };
    const bMemory = { id: 'shared-id', accountScope: 'B', title: 'B 的背景' } as any;
    store.setState({ memories: [bMemory], digests: [bDigest] });
    pending.get('butler_assistant_digest_save')!({ ...bDigest, accountScope: 'A', title: input.title });
    pending.get('butler_assistant_digest_delete')!(true);
    pending.get('butler_memory_delete')!(true);
    await Promise.all([rejectedSave, rejectedDelete, rejectedMemoryDelete]);
    assert.equal(store.getState().digests[0].title, 'B 的摘要');
    assert.equal(store.getState().memories[0].title, 'B 的背景');
    const callCount = calls.length;
    await assert.rejects(store.getState().saveDigest({ ...input, accountScope: 'A' }), /跨账号/);
    assert.equal(calls.length, callCount, '跨账号写入在 IPC 前拒绝');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  useButlerMemory.setState({ accountScope: 'B', memories: [], digests: [] });
  await assert.rejects(useButlerMemory.getState().saveDigest({ accountScope: 'A', kind: 'focus_digest', dateKey: '2026-11-15', title: '跨账号', summaryMd: '不能保存' }), /跨账号/);
  assert.deepEqual(useButlerMemory.getState().digests, []);
});
