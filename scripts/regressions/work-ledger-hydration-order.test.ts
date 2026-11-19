import assert from 'node:assert/strict';
import test from 'node:test';
import type { NativeWorkCard, NativeWorkLedgerSnapshot } from '../../apps/web/src/platform/desktopCommands';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const storage = new Map<string, string>();
const reads: Array<ReturnType<typeof deferred<NativeWorkLedgerSnapshot>>> = [];
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
  invoke: (command: string) => {
    if (command === 'butler_todo_list') return Promise.resolve([]);
    assert.equal(command, 'butler_work_ledger_snapshot');
    const read = deferred<NativeWorkLedgerSnapshot>();
    reads.push(read);
    return read.promise;
  },
} } });

const modules = Promise.all([
  import('../../apps/web/src/stores/workLedger'),
  import('../../apps/web/src/stores/todos'),
]);

function snapshot(title: string, stage = 'in_progress'): NativeWorkLedgerSnapshot {
  return { cards: [{ id: 'work', title, done: stage === 'done', state: {
    todoId: 'work', stage, waitState: stage === 'done' ? 'none' : 'waiting_input',
    requirementsVersion: 1, contentVersion: 0,
  } } as NativeWorkCard], links: [], sessions: [], evidences: [], events: [], actions: [] };
}

async function reset() {
  const [{ useWorkLedger, beginWorkLedgerAccount }, { useTodos }] = await modules;
  storage.clear(); storage.set('rcx-owner', 'same-account'); reads.length = 0;
  beginWorkLedgerAccount('same-account')();
  useTodos.setState({ todos: [] });
  useWorkLedger.setState({ ...snapshot('保留的工作'), hydrated: true, loading: false, lastError: null });
  return { useWorkLedger, beginWorkLedgerAccount };
}

test('同账号两次读取逆序返回时，旧等待快照不能覆盖最新完成状态', async () => {
  const { useWorkLedger } = await reset();
  const older = useWorkLedger.getState().hydrate();
  const newer = useWorkLedger.getState().hydrate();
  assert.equal(reads.length, 2);
  reads[1].resolve(snapshot('最新完成', 'done'));
  await newer;
  const current = useWorkLedger.getState();
  assert.equal(current.cards[0].state.stage, 'done');
  reads[0].resolve(snapshot('旧等待'));
  await older;
  assert.equal(useWorkLedger.getState().cards, current.cards);
  assert.equal(useWorkLedger.getState().cards[0].title, '最新完成');
  assert.equal(useWorkLedger.getState().loading, false);
  assert.equal(useWorkLedger.getState().lastError, null);
});

test('最新请求仍在读取时，旧错误不清 loading、不落 fallback，也不写 error', async () => {
  const { useWorkLedger } = await reset();
  const cards = useWorkLedger.getState().cards;
  const older = useWorkLedger.getState().hydrate();
  const newer = useWorkLedger.getState().hydrate();
  reads[0].reject(new Error('旧读取错误'));
  await older;
  assert.equal(useWorkLedger.getState().loading, true);
  assert.equal(useWorkLedger.getState().cards, cards);
  assert.equal(useWorkLedger.getState().lastError, null);
  reads[1].resolve(snapshot('新读取完成', 'done'));
  await newer;
  assert.equal(useWorkLedger.getState().cards[0].title, '新读取完成');
});

test('最新失败已显示后，迟到的旧错误与旧成功都不能覆盖最新结果', async () => {
  const { useWorkLedger } = await reset();
  const oldSuccess = useWorkLedger.getState().hydrate();
  const oldFailure = useWorkLedger.getState().hydrate();
  const newest = useWorkLedger.getState().hydrate();
  reads[2].reject(new Error('最新读取错误'));
  await newest;
  const current = useWorkLedger.getState();
  assert.equal(current.lastError, '最新读取错误');
  reads[1].reject(new Error('旧读取错误'));
  reads[0].resolve(snapshot('过期完成', 'done'));
  await Promise.all([oldSuccess, oldFailure]);
  assert.equal(useWorkLedger.getState().cards, current.cards);
  assert.equal(useWorkLedger.getState().lastError, '最新读取错误');
  assert.equal(useWorkLedger.getState().loading, false);
});

test('同账号重新选择数据库也作废旧读取，旧响应不能清新 loading/error', async () => {
  const { useWorkLedger, beginWorkLedgerAccount } = await reset();
  const older = useWorkLedger.getState().hydrate();
  const rejected = assert.rejects(older, /账号|数据库/);
  const activate = beginWorkLedgerAccount('same-account');
  assert.equal(useWorkLedger.getState().loading, false);
  assert.equal(useWorkLedger.getState().cards[0].title, '保留的工作');
  activate();
  const newer = useWorkLedger.getState().hydrate();
  reads[0].resolve(snapshot('旧数据库完成', 'done'));
  await rejected;
  assert.equal(useWorkLedger.getState().loading, true);
  assert.equal(useWorkLedger.getState().lastError, null);
  reads[1].resolve(snapshot('新数据库完成', 'done'));
  await newer;
  assert.equal(useWorkLedger.getState().cards[0].title, '新数据库完成');
});
