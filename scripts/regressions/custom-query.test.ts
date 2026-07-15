import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginCustomQueryLoad,
  createCustomQueryLoadState,
  finishCustomQueryLoad,
  rejectCustomQueryLoad,
  resolveCustomQueryLoad,
  shouldFetchCustomQuery,
} from '../../apps/web/src/stores/customQueries';

test('自定义查询失败后等待用户重试，不会自动请求风暴', () => {
  const initial = createCustomQueryLoadState<unknown[]>('server-a');
  const started = beginCustomQueryLoad(initial, 'server-a', 'query-a')!;
  const failed = rejectCustomQueryLoad(
    started.state,
    'server-a',
    'query-a',
    started.revision,
    'failed',
  );
  const finished = finishCustomQueryLoad(
    failed,
    'server-a',
    'query-a',
    started.revision,
  );

  assert.equal(shouldFetchCustomQuery('query-a', finished), false);
});

test('A 请求中切到 B 再切回 A 时不会重复请求或使 B 失效', () => {
  const initial = createCustomQueryLoadState<unknown[]>('server-a');
  const a = beginCustomQueryLoad(initial, 'server-a', 'query-a')!;
  const b = beginCustomQueryLoad(a.state, 'server-a', 'query-b')!;

  assert.equal(beginCustomQueryLoad(b.state, 'server-a', 'query-a'), null);
  const withA = resolveCustomQueryLoad(
    b.state,
    'server-a',
    'query-a',
    a.revision,
    ['a'],
  );
  const withBoth = resolveCustomQueryLoad(
    withA,
    'server-a',
    'query-b',
    b.revision,
    ['b'],
  );
  assert.deepEqual(withBoth.cache, { 'query-a': ['a'], 'query-b': ['b'] });
});

test('启动 B 不会清掉 A 的错误，返回 A 时仍等待手动重试', () => {
  const initial = createCustomQueryLoadState<unknown[]>('server-a');
  const a = beginCustomQueryLoad(initial, 'server-a', 'query-a')!;
  const failed = finishCustomQueryLoad(
    rejectCustomQueryLoad(a.state, 'server-a', 'query-a', a.revision, 'failed'),
    'server-a',
    'query-a',
    a.revision,
  );
  const b = beginCustomQueryLoad(failed, 'server-a', 'query-b')!;

  assert.equal(b.state.errors['query-a'], 'failed');
  assert.equal(shouldFetchCustomQuery('query-a', b.state), false);
});

test('配置作用域变化后旧缓存、错误和在途请求立即失效', () => {
  const initial = createCustomQueryLoadState<unknown[]>('server-a');
  const a = beginCustomQueryLoad(initial, 'server-a', 'query-a')!;
  const next = beginCustomQueryLoad(a.state, 'server-b', 'query-a')!;

  assert.deepEqual(next.state.cache, {});
  assert.deepEqual(next.state.errors, {});
  assert.equal(
    resolveCustomQueryLoad(next.state, 'server-a', 'query-a', a.revision, ['old']),
    next.state,
  );
});
