import test from 'node:test';
import assert from 'node:assert/strict';
import { useTodos } from '../../apps/web/src/stores/todos';
import { searchWork } from '../../apps/web/src/lib/workSearch';

test.afterEach(() => {
  useTodos.setState({ todos: [] });
});

test('手动新建的待办不带来源消息也能加入并完成（issue #64）', () => {
  const store = useTodos.getState();
  const id = store.add({ note: '周五前给出排期', due: '2026-07-24' });

  const added = useTodos.getState().todos.find((t) => t.id === id);
  assert.ok(added);
  assert.equal(added.note, '周五前给出排期');
  assert.equal(added.rid, undefined);
  assert.equal(added.mid, undefined);
  assert.equal(added.done, false);

  useTodos.getState().toggle(id);
  assert.equal(useTodos.getState().todos.find((t) => t.id === id)?.done, true);
});

test('手动待办不影响消息级标记判断 hasMessage', () => {
  const store = useTodos.getState();
  store.add({ note: '手动待办' });
  store.add({
    rid: 'r1',
    mid: 'm1',
    roomName: '一号群',
    excerpt: '消息原文',
    author: 'other',
  });

  assert.equal(useTodos.getState().hasMessage('m1'), true);
  assert.equal(useTodos.getState().hasMessage('m2'), false);
});

test('工作搜索能按 note 命中手动待办，缺失的来源字段不产生 undefined 文本', () => {
  const manual: Parameters<typeof searchWork>[1] = [
    { id: 't1', note: '准备季度汇报', done: false, createdAt: 1 },
  ];

  assert.equal(searchWork('季度汇报', manual, [], []).length, 1);
  assert.equal(searchWork('undefined', manual, [], []).length, 0);
});

test('待办可持久保存、编辑并清空承诺对象字段', () => {
  const store = useTodos.getState();
  const id = store.add({
    note: '给出排期',
    due: '2026-07-24',
    committedTo: '张三',
  });

  let todo = useTodos.getState().todos.find((t) => t.id === id);
  assert.ok(todo);
  assert.equal(todo.committedTo, '张三');
  assert.equal(todo.waitingFor, undefined);

  store.update(id, { committedTo: undefined, waitingFor: '李四' });
  todo = useTodos.getState().todos.find((t) => t.id === id);
  assert.ok(todo);
  assert.equal(todo.committedTo, undefined);
  assert.equal(todo.waitingFor, '李四');

  store.update(id, { waitingFor: undefined });
  todo = useTodos.getState().todos.find((t) => t.id === id);
  assert.ok(todo);
  assert.equal(todo.committedTo, undefined);
  assert.equal(todo.waitingFor, undefined);
});
