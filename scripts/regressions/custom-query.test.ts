import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginCustomQueryLoad,
  customQueryConnectionScope,
  createCustomQueryLoadState,
  finishCustomQueryLoad,
  rejectCustomQueryLoad,
  parseQueryUrl,
  queriesForScope,
  resolveCustomQueryLoad,
  shouldFetchCustomQuery,
  useCustomQueries,
} from '../../apps/web/src/stores/customQueries';

const QUERY_ID = 'abcdef01-2345-6789-abcd-ef0123456789';

test('自定义查询只在所属 ADO 连接显示，作用域不复制 PAT', () => {
  const scopeA = customQueryConnectionScope({
    mode: 'direct',
    adoBase: 'http://ado-a/DefaultCollection/',
    auth: 'pat',
    pat: 'top-secret',
    account: 'alice',
  });
  const scopeB = customQueryConnectionScope({
    mode: 'direct',
    adoBase: 'http://ado-b/DefaultCollection',
    auth: 'pat',
    pat: 'other-secret',
    account: 'alice',
  });
  const queries = [
    {
      id: 'a',
      name: 'A',
      url: `http://ado-a/DefaultCollection/P/_queries/query/${QUERY_ID}`,
      queryId: QUERY_ID,
      scope: scopeA,
    },
    {
      id: 'b',
      name: 'B',
      url: `http://ado-b/DefaultCollection/P/_queries/query/${QUERY_ID}`,
      queryId: QUERY_ID,
      scope: scopeB,
    },
  ];

  assert.deepEqual(
    queriesForScope(queries, scopeA, 'http://ado-a/DefaultCollection').map(
      (query) => query.id,
    ),
    ['a'],
  );
  assert.equal(scopeA.includes('top-secret'), false);
});

test('NTLM 自动回填身份不会改变自定义查询作用域', () => {
  const anonymousScope = customQueryConnectionScope({
    mode: 'direct',
    adoBase: 'http://ado/DefaultCollection',
    auth: 'ntlm',
    account: '',
  });
  const identifiedScope = customQueryConnectionScope({
    mode: 'direct',
    adoBase: 'http://ado/DefaultCollection',
    auth: 'ntlm',
    account: 'DOMAIN\\alice',
  });
  const queries = [
    {
      id: 'before-identity',
      name: '身份识别前创建',
      url: `http://ado/DefaultCollection/P/_queries/query/${QUERY_ID}`,
      queryId: QUERY_ID,
      scope: anonymousScope,
    },
  ];

  assert.equal(identifiedScope, anonymousScope);
  assert.deepEqual(
    queriesForScope(queries, identifiedScope, 'http://ado/DefaultCollection').map(
      (query) => query.id,
    ),
    ['before-identity'],
  );
});

test('迁移当前连接时保留其他 ADO 连接的旧查询，切回后再认领', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });

  try {
    const baseA = 'http://ado-a/DefaultCollection';
    const baseB = 'http://ado-b/DefaultCollection';
    const config = (adoBase: string) => ({
      mode: 'direct' as const,
      adoBase,
      auth: 'ntlm' as const,
      account: '',
    });
    const legacyA = {
      id: 'legacy-a',
      name: 'A 的旧查询',
      url: `${baseA}/P/_queries/query/${QUERY_ID}`,
      queryId: QUERY_ID,
    };
    const scopeA = customQueryConnectionScope(config(baseA));
    const scopeB = customQueryConnectionScope(config(baseB));
    useCustomQueries.setState({ queries: [legacyA] });

    useCustomQueries.getState().claimLegacy(scopeB, baseB);
    assert.deepEqual(useCustomQueries.getState().queries, [legacyA]);
    assert.deepEqual(queriesForScope(useCustomQueries.getState().queries, scopeB, baseB), []);

    useCustomQueries.getState().claimLegacy(scopeA, baseA);
    assert.equal(useCustomQueries.getState().queries[0]?.scope, scopeA);
    assert.deepEqual(
      queriesForScope(useCustomQueries.getState().queries, scopeA, baseA).map(
        (query) => query.id,
      ),
      ['legacy-a'],
    );
  } finally {
    useCustomQueries.setState({ queries: [] });
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  }
});

test('已有外部查询链接不会在迁移前短暂显示', () => {
  const scope = customQueryConnectionScope({
    mode: 'direct',
    adoBase: 'http://ado/DefaultCollection',
    auth: 'ntlm',
    account: 'alice',
  });
  const legacy = [
    {
      id: 'legacy',
      name: '伪装查询',
      url: `https://evil.example/P/_queries/query/${QUERY_ID}`,
      queryId: QUERY_ID,
    },
  ];

  assert.deepEqual(queriesForScope(legacy, scope, 'http://ado/DefaultCollection'), []);
});

test('查询链接只接受当前 ADO 基址内的 http/https 地址', () => {
  const base = 'http://ado:8080/DefaultCollection';
  const valid = parseQueryUrl(
    `${base}/MyProject/_queries/query/${QUERY_ID}`,
    base,
  );

  assert.equal(valid?.project, 'MyProject');
  assert.equal(parseQueryUrl(`https://evil.example/MyProject/_queries/query/${QUERY_ID}`, base), null);
  assert.equal(parseQueryUrl(`http://ado:8080/Other/MyProject/_queries/query/${QUERY_ID}`, base), null);
  assert.equal(parseQueryUrl(`javascript:/MyProject/_queries/query/${QUERY_ID}`, base), null);
});

test('裸查询 GUID 会根据当前 ADO 基址生成安全链接', () => {
  const parsed = parseQueryUrl(QUERY_ID, 'http://ado:8080/DefaultCollection');
  assert.equal(parsed?.queryId, QUERY_ID);
  assert.equal(
    parsed?.url,
    `http://ado:8080/DefaultCollection/_queries?id=${QUERY_ID}`,
  );
});

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
