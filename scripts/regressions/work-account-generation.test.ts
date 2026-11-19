import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { NativeWorkCard, NativeWorkLedgerSnapshot } from '../../apps/web/src/platform/desktopCommands';

const records = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => records.get(key) ?? null,
  setItem: (key: string, value: string) => records.set(key, String(value)),
  removeItem: (key: string) => records.delete(key), clear: () => records.clear(),
  key: (index: number) => [...records.keys()][index] ?? null,
  get length() { return records.size; },
} });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const creation = { requestId: 'source-request', title: 'A 的工作', goal: '完成 A 的目标', acceptance: ['A 的验收'], workspaceRoot: 'D:/A/project', adoWorkItemId: 42, adoProject: 'A' };
const emptyLedger = { cards: [], links: [], sessions: [], evidences: [], events: [], actions: [], hydrated: true, loading: false, lastError: null };

async function webModules() {
  const [ledger, todos, host] = await Promise.all([
    import('../../apps/web/src/stores/workLedger'),
    import('../../apps/web/src/stores/todos'),
    import('../../apps/web/src/agent/codexHostTools'),
  ]);
  return { ...ledger, ...todos, ...host };
}

function nativeCard(id: string): NativeWorkCard {
  return { id, title: `${id} 的工作`, source: 'manual', done: false, createdAt: 1, updatedAt: 1,
    state: { todoId: id, requirementsVersion: 1, contentVersion: 0, goal: `${id} 的目标`, acceptance: ['验收'],
      stage: 'ready', waitState: 'none', ownerKind: 'human', autonomyMode: 'confirm', visibility: 'private',
      boundaries: [], dependsOn: [], maxAutoTurns: 3, autoTurnsUsed: 0, consecutiveFailures: 0, updatedAt: 1 },
  } as NativeWorkCard;
}
function snapshot(card: NativeWorkCard): NativeWorkLedgerSnapshot {
  return { cards: [card], links: [], sessions: [], evidences: [], events: [], actions: [] };
}

async function nativeLateReplies() {
  const pendingCreate = deferred<NativeWorkCard>();
  const pendingHydrate = deferred<NativeWorkLedgerSnapshot>();
  const commands: Array<{ command: string; owner: string; args?: Record<string, unknown> }> = [];
  let nativeOwner = 'A';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
    invoke: (command: string, args?: Record<string, unknown>) => {
      // The legacy Todo store hydrates at module load; this suite counts work-ledger I/O.
      if (command === 'butler_todo_list') return Promise.resolve([]);
      commands.push({ command, owner: nativeOwner, args });
      if (command === 'butler_work_card_create' && nativeOwner === 'A') return pendingCreate.promise;
      if (command === 'butler_work_ledger_snapshot') return nativeOwner === 'A' ? pendingHydrate.promise : Promise.resolve(snapshot(nativeCard('B')));
      throw new Error(`未预期的原生命令：${command}`);
    },
  } });
  records.set('rcx-owner', 'A');
  const [{ useWorkLedger, beginWorkLedgerAccount }, { useTodos }] = await Promise.all([
    import('../../apps/web/src/stores/workLedger'), import('../../apps/web/src/stores/todos'),
  ]);
  const activateA = beginWorkLedgerAccount('A');
  await assert.rejects(useWorkLedger.getState().hydrate(), /账号|数据库/);
  await assert.rejects(useWorkLedger.getState().createCard(creation), /账号|数据库/);
  assert.equal(commands.length, 0, '数据库激活前不能发起原生读写');
  activateA();
  const oldCreate = useWorkLedger.getState().createCard(creation);
  const oldHydrate = useWorkLedger.getState().hydrate();
  assert.deepEqual(commands.map((item) => item.owner), ['A', 'A']);
  records.set('rcx-owner', 'B'); nativeOwner = 'B';
  useTodos.setState({ todos: [{ id: 'B', title: 'B 的工作', done: false, createdAt: 1 }] });
  const activateB = beginWorkLedgerAccount('B');
  assert.throws(activateA, /账号已切换/);
  assert.equal(useWorkLedger.getState().cards.length, 0, '切换原生数据库时立即清空旧账本');
  activateB();
  await useWorkLedger.getState().hydrate();
  const before = useWorkLedger.getState();
  assert.deepEqual(before.cards.map((card) => card.id), ['B']);
  pendingCreate.resolve(nativeCard('A'));
  pendingHydrate.resolve(snapshot(nativeCard('A')));
  await assert.rejects(oldCreate, /账号|数据库/);
  await assert.rejects(oldHydrate, /账号|数据库/);
  const after = useWorkLedger.getState();
  assert.equal(after.cards, before.cards);
  assert.deepEqual(after.cards.map((card) => card.id), ['B']);
  assert.deepEqual(useTodos.getState().todos.map((todo) => todo.id), ['B']);
  assert.equal(after.loading, false);
  assert.equal(after.lastError, null);
  assert.equal(commands.filter((item) => item.command === 'butler_work_card_create').length, 1);
  assert.deepEqual(JSON.parse((commands[0].args!.input as { requestId: string }).requestId), ['A', creation.requestId]);
  process.stdout.write('WORK_ACCOUNT_NATIVE:late_create_and_hydrate_rejected_B_unchanged\n');
}

if (process.env.RCX_WORK_ACCOUNT_NATIVE_TEST === '1') {
  void nativeLateReplies().catch((error) => { process.stderr.write(String(error?.stack ?? error)); process.exitCode = 1; });
} else {
  test('工作账户激活前拒绝读取和写入，旧激活回调不能激活新账户', async () => {
    const p = await webModules();
    records.clear(); records.set('rcx-owner', 'A');
    p.useTodos.setState({ todos: [{ id: 'A-existing', title: 'A 已有工作', done: false, createdAt: 1 }] });
    p.useWorkLedger.setState(emptyLedger);
    const activateA = p.beginWorkLedgerAccount('A');
    try {
      assert.throws(p.captureWorkLedgerAccount, /账号|数据库/);
      await assert.rejects(p.useWorkLedger.getState().hydrate(), /账号|数据库/);
      await assert.rejects(p.useWorkLedger.getState().createCard(creation), /账号|数据库/);
      assert.throws(() => p.useWorkLedger.getState().syncWithTodos(), /账号|数据库/);
      const listed = await p.executeRocketxDynamicTool({ tool: 'list_work_cards', arguments: {} });
      assert.equal(listed.success, false, '宿主查询不能绕过账户激活门禁');
      assert.equal(records.has('rc_work_ledger_v1'), false, '激活前不应写出账本缓存');
    } finally { activateA(); }
    records.set('rcx-owner', 'B'); p.useTodos.setState({ todos: [] });
    const activateB = p.beginWorkLedgerAccount('B');
    assert.throws(activateA, /账号已切换/);
    activateB();
  });

  test('A 账户建工作哈希晚完成不会建入 B，也不会继续登记 A 来源和目录链接', async () => {
    const p = await webModules();
    records.clear(); records.set('rcx-owner', 'A');
    p.useTodos.setState({ todos: [] }); p.useWorkLedger.setState(emptyLedger);
    p.beginWorkLedgerAccount('A')();
    const digestStarted = deferred<void>();
    const pendingDigest = deferred<ArrayBuffer>();
    const originalDigest = crypto.subtle.digest;
    const ownDescriptor = Object.getOwnPropertyDescriptor(crypto.subtle, 'digest');
    let holdFirst = true;
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: function (algorithm: AlgorithmIdentifier, data: BufferSource) {
      if (holdFirst) {
        holdFirst = false;
        assert.match(new TextDecoder().decode(data), /A/);
        digestStarted.resolve(); return pendingDigest.promise;
      }
      return originalDigest.call(crypto.subtle, algorithm, data);
    } });
    try {
      const pendingA = p.executeRocketxDynamicTool({ tool: 'create_work_card', arguments: creation });
      await digestStarted.promise;
      records.clear(); records.set('rcx-owner', 'B');
      p.useTodos.setState({ todos: [] }); p.beginWorkLedgerAccount('B')();
      const resultB = await p.executeRocketxDynamicTool({ tool: 'create_work_card', arguments: { requestId: 'B-request', title: 'B 的工作', goal: '完成 B 的目标', acceptance: ['B 的验收'], workspaceRoot: 'D:/B/project', adoWorkItemId: 99, adoProject: 'B' } });
      assert.equal(resultB.success, true, resultB.contentItems[0]?.text);
      const before = records.get('rc_work_ledger_v1');
      pendingDigest.resolve(new Uint8Array(32).buffer);
      const resultA = await pendingA;
      assert.equal(resultA.success, false);
      assert.match(resultA.contentItems[0]?.text ?? '', /账号|数据库/);
      assert.deepEqual(p.useWorkLedger.getState().cards.map((card) => card.title), ['B 的工作']);
      assert.deepEqual(p.useTodos.getState().todos.map((todo) => todo.title), ['B 的工作']);
      assert.ok(p.useWorkLedger.getState().links.every((link) => link.project === 'B'));
      assert.equal(p.useWorkLedger.getState().links.filter((link) => link.repo === 'D:/B/project').length, 1);
      assert.equal(p.useWorkLedger.getState().links.some((link) => link.repo === creation.workspaceRoot || link.externalId === '42'), false);
      assert.equal(records.get('rc_work_ledger_v1'), before, 'A 的晚响应不能改写 B 的持久工作记录');
    } finally {
      pendingDigest.resolve(new Uint8Array(32).buffer);
      if (ownDescriptor) Object.defineProperty(crypto.subtle, 'digest', ownDescriptor);
      else delete (crypto.subtle as unknown as Record<string, unknown>).digest;
    }
  });

  test('原生 A 数据库的建工作和 hydrate 晚响应不污染已激活 B 数据库', { timeout: 30_000 }, () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      env: { ...process.env, RCX_WORK_ACCOUNT_NATIVE_TEST: '1' }, encoding: 'utf8', timeout: 25_000,
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /WORK_ACCOUNT_NATIVE:late_create_and_hydrate_rejected_B_unchanged/);
  });
}
