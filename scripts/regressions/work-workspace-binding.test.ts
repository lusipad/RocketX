import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeSuperAgentDispatch, setSuperAgentRuntimeDriversForTests, spawnCardWorkerInWorktree,
} from '../../apps/web/src/agent/superAgentBridge';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { useTodos } from '../../apps/web/src/stores/todos';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';
import type { NativeWorkSessionRecord } from '../../apps/web/src/platform/desktopCommands';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });

async function reset() {
  storage.clear();
  useAuth.setState({ localMode: true, status: 'authed', user: { _id: 'workspace-fixture' } as never });
  useCodexWorkspace.setState({ scope: 'workspace-fixture', workspaceRoot: 'D:/unrelated-focused',
    defaultWorkspaceRoot: 'D:/default-materials', butlerWorkspaceRoot: 'D:/butler-materials', threads: [], threadStates: {} });
  useTodos.setState({ todos: [{ id: 'work', title: '修复 RocketX 登录', source: 'manual', done: false, createdAt: 1 }] });
  useWorkLedger.setState({ cards: [], sessions: [], actions: [], links: [], events: [], evidences: [] });
  useWorkLedger.getState().syncWithTodos();
  await useWorkLedger.getState().updateCard('work', { enroll: true, goal: '修复登录', acceptance: ['登录验证通过'] });
}

async function prepare(spec: Record<string, unknown> = {}, sessionId?: string, key = 'dispatch') {
  return useWorkLedger.getState().prepareDispatchAction({ todoId: 'work', sessionId,
    actionKind: sessionId ? 'session_steer' : 'session_create', idempotencyKey: key,
    specJson: JSON.stringify({ specText: '修复登录并验证', runtime: 'pi', ...spec }), requireConfirmation: false });
}

test('新工作未绑定目录时不借用当前、默认或管家资料目录，也不准备可执行动作', async () => {
  await reset(); let started = 0;
  const restore = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false,
    startCodexWorkerTask: async () => { started += 1; return { threadId: 'wrong-directory' }; } });
  try {
    await assert.rejects(spawnCardWorkerInWorktree({ todoId: 'work', instruction: '保留这条要求', isolateWorktree: false }), /工作.*目录/);
    assert.equal(started, 0);
    assert.equal(useWorkLedger.getState().actions.length, 0);
    assert.equal(useCodexWorkspace.getState().workspaceRoot, 'D:/unrelated-focused');
  } finally { restore(); }
});

test('恢复旧的无目录 prepared 动作时明确失败，不从当前界面补一个目录执行', async () => {
  await reset(); let started = 0;
  const restore = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false,
    startCodexWorkerTask: async () => { started += 1; return { threadId: 'wrong-directory' }; } });
  try {
    const action = await prepare();
    const result = await executeSuperAgentDispatch({ action });
    assert.equal(result.ok, false);
    assert.match(result.error!, /工作.*目录/);
    assert.equal(started, 0);
    assert.equal(useWorkLedger.getState().actions[0].state, 'failed');
  } finally { restore(); }
});

test('新工作只接受显式派发目录或这件工作已经保存的目录绑定', async () => {
  for (const source of ['options', 'workspaceRoot', 'repoRootOverride', 'binding'] as const) {
    await reset(); const roots: string[] = [];
    const restore = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false,
      startCodexWorkerTask: async ({ workspaceRoot }) => { roots.push(workspaceRoot); return { threadId: `worker-${source}` }; } });
    try {
      if (source === 'binding') await useWorkLedger.getState().upsertLink({ todoId: 'work', kind: 'kanban_card',
        externalId: 'work', project: 'RocketX', repo: 'D:/bound-project', rid: null, headSha: null,
        title: '工作目录', webUrl: null, stateSnapshot: 'workspace' });
      const action = await prepare(source === 'workspaceRoot' || source === 'repoRootOverride' ? { [source]: 'D:/bound-project' } : {});
      const result = await executeSuperAgentDispatch({ action, ...(source === 'options' ? { repoRootOverride: 'D:/bound-project' } : {}) });
      assert.equal(result.ok, true, source);
      assert.deepEqual(roots, ['D:/bound-project'], source);
      assert.equal(result.session?.workspaceRoot, 'D:/bound-project', source);
    } finally { restore(); }
  }
});

test('其他工作的绑定和 Git 来源不冒充工作目录，原会话缺目录也不借用其他会话', async () => {
  await reset();
  const roots: string[] = [];
  const restore = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false,
    startCodexWorkerTask: async ({ workspaceRoot }) => { roots.push(workspaceRoot); return { threadId: 'wrong' }; },
    sendCodexSessionPrompt: async ({ workspaceRoot }) => { roots.push(workspaceRoot); return { turnMarker: 'wrong' }; } });
  try {
    const link = { id: 'other-link', todoId: 'other', kind: 'kanban_card' as const, externalId: 'other',
      repo: 'D:/other-project', stateSnapshot: 'workspace', project: null, rid: null, headSha: null,
      title: null, webUrl: null, lastVerifiedAt: 1, createdAt: 1 };
    useWorkLedger.setState({ links: [link, { ...link, id: 'git-source', todoId: 'work', kind: 'git_branch' }] });
    const create = await executeSuperAgentDispatch({ action: await prepare() });
    assert.equal(create.ok, false);
    useWorkLedger.setState({ sessions: [{ id: 'missing-root', todoId: 'work', runtime: 'pi',
      nativeSessionId: 'original-thread', workspaceRoot: '', controlMode: 'controllable', runtimeStatus: 'idle',
      controlEndpoint: 'pi-app-server://local', visibility: 'private' } as NativeWorkSessionRecord] });
    const followup = await executeSuperAgentDispatch({ action: await prepare({}, 'missing-root', 'followup'), repoRootOverride: 'D:/replacement' });
    assert.equal(followup.ok, false);
    assert.match(followup.error!, /原会话.*目录/);
    assert.deepEqual(roots, []);
  } finally { restore(); }
});

test('已有会话的后续指令按原目录串行，界面或派发覆盖值不改变原会话写入锁', async () => {
  await reset();
  useWorkLedger.setState({ sessions: [{ id: 'original', todoId: 'work', runtime: 'pi',
    nativeSessionId: 'original-thread', workspaceRoot: 'D:/original-project', runtimeStatus: 'idle',
    controlMode: 'controllable', controlEndpoint: 'pi-app-server://local', visibility: 'private',
    origin: 'rocketx_managed', createdAt: 1, updatedAt: 1 } as NativeWorkSessionRecord] });
  let release!: () => void; let firstStarted!: () => void; const roots: string[] = [];
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const restore = setSuperAgentRuntimeDriversForTests({ isDesktop: () => false,
    sendCodexSessionPrompt: async ({ workspaceRoot }) => {
      roots.push(workspaceRoot); firstStarted(); await gate; return { turnMarker: `turn-${roots.length}` };
    } });
  const first = await prepare({}, 'original', 'first');
  const second = await prepare({ workspaceRoot: 'D:/stale-snapshot' }, 'original', 'second');
  const firstRun = executeSuperAgentDispatch({ action: first, repoRootOverride: 'D:/override-a' });
  await started;
  const secondRun = executeSuperAgentDispatch({ action: second, repoRootOverride: 'D:/override-b' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(roots, ['D:/original-project']);
  } finally {
    release();
    const results = await Promise.all([firstRun, secondRun]);
    restore();
    assert.ok(results.every((result) => result.ok));
  }
  assert.deepEqual(roots, ['D:/original-project', 'D:/original-project']);
});
