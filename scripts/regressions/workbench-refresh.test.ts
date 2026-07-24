import assert from 'node:assert/strict';
import test from 'node:test';

const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => void values.delete(key),
  setItem: (key, value) => void values.set(key, String(value)),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

async function loadModules() {
  const [{ ADO_WEB_KEY, WORKBENCH_CONFIG_KEY, loadWorkbenchConfig, loadWorkbenchConfigIssue }, { useWorkbench }] =
    await Promise.all([
      import('../../apps/web/src/lib/ado'),
      import('../../apps/web/src/stores/workbench'),
    ]);
  return {
    ADO_WEB_KEY,
    WORKBENCH_CONFIG_KEY,
    loadWorkbenchConfig,
    loadWorkbenchConfigIssue,
    useWorkbench,
  };
}

test.afterEach(async () => {
  const { useWorkbench } = await loadModules();
  values.clear();
  useWorkbench.setState({
    config: null,
    configRevision: 0,
    workItems: [],
    prs: [],
    builds: [],
    loading: false,
    error: null,
    lastRefresh: null,
  });
});

test('旧版 direct 配置会平滑归一，bridge 配置会被视为未配置', async () => {
  const { WORKBENCH_CONFIG_KEY, loadWorkbenchConfig, loadWorkbenchConfigIssue } = await loadModules();

  localStorage.setItem(
    WORKBENCH_CONFIG_KEY,
    JSON.stringify({ mode: 'direct', adoBase: 'http://ado/tfs/c/', pat: 'secret', auth: 'pat', account: 'alice' }),
  );
  assert.deepEqual(loadWorkbenchConfig(), {
    adoBase: 'http://ado/tfs/c',
    pat: 'secret',
    auth: 'pat',
    account: 'alice',
  });
  assert.equal(loadWorkbenchConfigIssue(), null);

  localStorage.setItem(
    WORKBENCH_CONFIG_KEY,
    JSON.stringify({ mode: 'bridge', bridge: 'http://bridge:8377', account: 'alice' }),
  );
  assert.equal(loadWorkbenchConfig(), null);
  assert.match(loadWorkbenchConfigIssue() ?? '', /ado-bridge.*移除|直连 Azure DevOps/);

  localStorage.setItem(
    WORKBENCH_CONFIG_KEY,
    JSON.stringify({
      bridge: 'http://bridge:8377',
      adoBase: 'http://ado/tfs/c',
      account: 'alice',
    }),
  );
  assert.equal(loadWorkbenchConfig(), null);
  assert.match(loadWorkbenchConfigIssue() ?? '', /ado-bridge.*移除|直连 Azure DevOps/);
});

test('工作台保存仅按 adoBase+auth 视为连接键，并只持久化直连字段', async () => {
  const { ADO_WEB_KEY, WORKBENCH_CONFIG_KEY, useWorkbench } = await loadModules();
  let refreshCalls = 0;
  useWorkbench.setState({
    config: { adoBase: 'http://old', auth: 'pat', pat: 'old-secret', account: 'alice' },
    configRevision: 0,
    workItems: [1 as never],
    prs: [1 as never],
    builds: [1 as never],
    loading: false,
    error: 'old error',
    lastRefresh: 1,
    refresh: async () => {
      refreshCalls += 1;
    },
  });

  localStorage.setItem(ADO_WEB_KEY, 'http://old-web');
  useWorkbench.getState().setConfig({
    adoBase: 'http://new/',
    auth: 'pat',
    pat: 'new-secret',
    account: 'alice',
  });

  const state = useWorkbench.getState();
  assert.equal(refreshCalls, 1);
  assert.equal(state.config?.adoBase, 'http://new');
  assert.equal(state.configRevision, 1);
  assert.deepEqual(state.workItems, []);
  assert.deepEqual(state.prs, []);
  assert.deepEqual(state.builds, []);
  assert.equal(state.lastRefresh, null);
  assert.equal(state.error, null);
  assert.equal(localStorage.getItem(ADO_WEB_KEY), null);
  const saved = localStorage.getItem(WORKBENCH_CONFIG_KEY) ?? '';
  assert.match(saved, /http:\/\/new/);
  assert.doesNotMatch(saved, /"mode"|"bridge"/);
});

test('仅账号变化不会误清 ADO Web 地址', async () => {
  const { ADO_WEB_KEY, useWorkbench } = await loadModules();
  useWorkbench.setState({
    config: { adoBase: 'http://ado', auth: 'ntlm', account: '' },
    refresh: async () => {},
  });
  localStorage.setItem(ADO_WEB_KEY, 'http://ado');

  useWorkbench.getState().setConfig({
    adoBase: 'http://ado',
    auth: 'ntlm',
    account: 'DOMAIN\\alice',
  });

  assert.equal(localStorage.getItem(ADO_WEB_KEY), 'http://ado');
});
