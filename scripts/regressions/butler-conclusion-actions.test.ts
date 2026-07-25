import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConclusionCheckpoint,
  turnConclusionIntoTodo,
  watchConclusion,
  type ConclusionTodoState,
} from '../../apps/web/src/lib/butlerConclusionActions';
import type { ButlerConclusion } from '../../apps/web/src/lib/butlerConclusions';
import { ledgerFromTodos } from '../../apps/web/src/lib/butlerLedger';
import type { Todo } from '../../apps/web/src/stores/todos';

function fakeTodos(seed: Todo[] = []) {
  const todos = [...seed];
  const calls = { add: 0, update: 0 };
  const state: ConclusionTodoState = {
    todos,
    add(todo) {
      calls.add += 1;
      const id = `todo-${todos.length + 1}`;
      todos.push({ ...todo, id, done: false, createdAt: 1_000 } as Todo);
      return id;
    },
    update(id, patch) {
      calls.update += 1;
      const index = todos.findIndex((item) => item.id === id);
      if (index >= 0) todos[index] = { ...todos[index], ...patch } as Todo;
    },
  };
  return { state, todos, calls };
}

function messageConclusion(text: string, index = 0): ButlerConclusion {
  return {
    index,
    text,
    label: text.slice(0, 12),
    ref: 'msg:m1',
    source: {
      kind: 'message',
      id: 'm1',
      mid: 'm1',
      rid: 'room-dev',
      label: '研发群 · 张三：周五给压测报告',
    },
    can: { open: true, todo: true, watch: true },
  };
}

test('连点两次只建一条待办', () => {
  const { state, todos, calls } = fakeTodos();
  const conclusion = messageConclusion('张三答应周五给压测报告');
  assert.equal(turnConclusionIntoTodo(conclusion, { todoState: state }), 'created');
  assert.equal(turnConclusionIntoTodo(conclusion, { todoState: state }), 'already-exists');
  assert.equal(todos.length, 1);
  assert.equal(calls.add, 1);
  assert.equal(todos[0].rid, 'room-dev');
  assert.equal(todos[0].roomName, '研发群');
});

test('换个措辞仍然去重，幂等键不含结论文本（坑 3 的正解）', () => {
  const { state, todos } = fakeTodos();
  assert.equal(turnConclusionIntoTodo(messageConclusion('张三答应周五给压测报告'), { todoState: state }), 'created');
  // 同一条消息、完全不同的措辞
  assert.equal(
    turnConclusionIntoTodo(messageConclusion('压测报告这事张三接了，本周内'), { todoState: state }),
    'already-exists',
  );
  assert.equal(todos.length, 1);

  const first = createConclusionCheckpoint(messageConclusion('张三答应周五给压测报告'), 'todo', undefined, 1);
  const second = createConclusionCheckpoint(messageConclusion('措辞完全不同'), 'todo', undefined, 2);
  assert.equal(first.id, second.id, '同一条结论的 checkpoint id 必须相同，否则会重复执行');
  assert.equal(first.idempotencyKey, second.idempotencyKey);
});

test('盯它写进等待台账，且不产出多余的承诺条', () => {
  const { state, todos, calls } = fakeTodos();
  const conclusion = messageConclusion('张三答应周五给压测报告');
  assert.equal(watchConclusion(conclusion, { who: '张三', due: '2026-07-31' }, { todoState: state }), 'created');
  assert.equal(calls.add, 1);
  assert.equal(todos[0].waitingFor, '张三');
  assert.equal(todos[0].committedTo, undefined);

  const ledger = ledgerFromTodos(todos, '2026-07-25');
  const waits = ledger.filter((entry) => entry.kind === 'wait');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].who, '张三');
  assert.equal(ledger.some((entry) => entry.kind === 'commitment'), false);
});

test('已有同消息待办时是更新而不是新建；重复盯同一人是 already-watching', () => {
  const { state, todos, calls } = fakeTodos([
    { id: 'todo-existing', title: '旧的', done: false, createdAt: 1, source: 'message', mid: 'm1', rid: 'room-dev' } as Todo,
  ]);
  const conclusion = messageConclusion('张三答应周五给压测报告');
  assert.equal(watchConclusion(conclusion, { who: '张三' }, { todoState: state }), 'updated');
  assert.equal(calls.add, 0);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].waitingFor, '张三');
  assert.equal(todos[0].committedTo, undefined);

  assert.equal(watchConclusion(conclusion, { who: '张三' }, { todoState: state }), 'already-watching');
  assert.equal(calls.update, 1);
});

test('没写「等谁」时零写入', () => {
  const { state, calls } = fakeTodos();
  assert.equal(watchConclusion(messageConclusion('张三答应周五给报告'), { who: '   ' }, { todoState: state }), 'needs-who');
  assert.equal(calls.add, 0);
  assert.equal(calls.update, 0);
});

test('改「等谁」不会被幂等短路吃掉', () => {
  const conclusion = messageConclusion('张三答应周五给报告');
  const zhang = createConclusionCheckpoint(conclusion, 'wait', '张三', 1);
  const li = createConclusionCheckpoint(conclusion, 'wait', '李四', 1);
  assert.notEqual(zhang.id, li.id);
  assert.notEqual(zhang.idempotencyKey, li.idempotencyKey);
  // 但 todo 与 wait 是两类动作，不应互相短路
  assert.notEqual(createConclusionCheckpoint(conclusion, 'todo', undefined, 1).id, zhang.id);
});

test('PR 与构建结论不允许写动作', () => {
  const { state, calls } = fakeTodos();
  const pr: ButlerConclusion = {
    index: 0,
    text: '建议先合 #102',
    label: '建议先合 #102',
    ref: 'pr:102',
    fallbackWebUrl: 'https://ado.example/tfs/DefaultCollection/proj/_git/x/pullrequest/102',
    can: { open: true, todo: false, watch: false },
  };
  assert.equal(turnConclusionIntoTodo(pr, { todoState: state }), 'unsupported');
  assert.equal(watchConclusion(pr, { who: '张三' }, { todoState: state }), 'unsupported');
  assert.equal(calls.add, 0);
});

test('checkpoint 是待审批的写操作，走既有审批通道', () => {
  const checkpoint = createConclusionCheckpoint(messageConclusion('张三答应周五给报告'), 'todo', undefined, 1);
  assert.equal(checkpoint.effect, 'write');
  assert.equal(checkpoint.capability, 'todos.write');
  assert.equal(checkpoint.status, 'approval-required');
  assert.match(checkpoint.preview, /记为待办/);
});
