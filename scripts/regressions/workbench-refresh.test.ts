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

const originalFetch = globalThis.fetch;

async function loadModules() {
  const [{ ADO_WEB_KEY, WORKBENCH_CONFIG_KEY }, { useWorkbench }] = await Promise.all([
    import('../../apps/web/src/lib/ado'),
    import('../../apps/web/src/stores/workbench'),
  ]);
  return { ADO_WEB_KEY, WORKBENCH_CONFIG_KEY, useWorkbench };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function workItem(id: number) {
  return {
    id,
    title: `item-${id}`,
    type: 'Task',
    state: 'Active',
    project: 'test',
    webUrl: `http://web/items/${id}`,
  };
}

function responseFor(url: string, id: number): Response {
  if (url.endsWith('/api/ado/config')) {
    return json({ webBase: `http://web-${id}`, account: `user-${id}` });
  }
  if (url.includes('/api/ado/workitems')) return json({ items: [workItem(id)] });
  if (url.endsWith('/api/ado/pullrequests')) return json({ items: [] });
  if (url.endsWith('/api/ado/builds')) return json({ items: [] });
  throw new Error(`unexpected URL: ${url}`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('等待工作台刷新超时');
}

test.afterEach(async () => {
  const { useWorkbench } = await loadModules();
  globalThis.fetch = originalFetch;
  values.clear();
  useWorkbench.setState({
    config: null,
    workItems: [],
    prs: [],
    builds: [],
    loading: false,
    error: null,
    lastRefresh: null,
  });
});

test('旧 ADO 配置刷新晚到时不能覆盖新配置和数据', async () => {
  const { ADO_WEB_KEY, WORKBENCH_CONFIG_KEY, useWorkbench } = await loadModules();
  const oldResponses: Array<{ url: string; resolve: (response: Response) => void }> = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith('http://old/')) {
      return new Promise<Response>((resolve) => oldResponses.push({ url, resolve }));
    }
    return responseFor(url, 2);
  }) as typeof fetch;

  useWorkbench.setState({
    config: { mode: 'bridge', bridge: 'http://old', account: '' },
    workItems: [],
    prs: [],
    builds: [],
    loading: false,
    error: null,
    lastRefresh: null,
  });
  const oldRefresh = useWorkbench.getState().refresh();
  await waitFor(() => oldResponses.length === 4);

  localStorage.setItem(ADO_WEB_KEY, 'http://web-old');
  useWorkbench.getState().setConfig({ mode: 'bridge', bridge: 'http://new', account: '' });
  assert.equal(localStorage.getItem(ADO_WEB_KEY), null);
  await waitFor(() => useWorkbench.getState().workItems[0]?.id === 2);

  for (const pending of oldResponses) pending.resolve(responseFor(pending.url, 1));
  await oldRefresh;

  const state = useWorkbench.getState();
  assert.equal(state.config?.bridge, 'http://new');
  assert.equal(state.config?.account, 'user-2');
  assert.deepEqual(state.workItems.map((item) => item.id), [2]);
  assert.equal(state.loading, false);
  assert.equal(localStorage.getItem(ADO_WEB_KEY), 'http://web-2');
  assert.match(localStorage.getItem(WORKBENCH_CONFIG_KEY) ?? '', /http:\/\/new/);
});

test('旧刷新失败不能结束新刷新或写入旧错误', async () => {
  const { useWorkbench } = await loadModules();
  const oldRequests: Array<{
    reject: (error: Error) => void;
    resolve: (response: Response) => void;
    url: string;
  }> = [];
  const newRequests: Array<{ resolve: (response: Response) => void; url: string }> = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    return new Promise<Response>((resolve, reject) => {
      if (url.startsWith('http://old/')) oldRequests.push({ url, resolve, reject });
      else newRequests.push({ url, resolve });
    });
  }) as typeof fetch;

  useWorkbench.setState({ config: { mode: 'bridge', bridge: 'http://old', account: '' } });
  const oldRefresh = useWorkbench.getState().refresh();
  await waitFor(() => oldRequests.length === 4);
  useWorkbench.getState().setConfig({ mode: 'bridge', bridge: 'http://new', account: '' });
  await waitFor(() => newRequests.length === 4);

  oldRequests[0].reject(new Error('old unavailable'));
  await oldRefresh;
  assert.equal(useWorkbench.getState().loading, true);
  assert.equal(useWorkbench.getState().error, null);

  for (const pending of newRequests) pending.resolve(responseFor(pending.url, 2));
  await waitFor(() => useWorkbench.getState().workItems[0]?.id === 2);
  assert.equal(useWorkbench.getState().loading, false);
  assert.equal(useWorkbench.getState().error, null);
});

test('切换到无有效端点时也会立即淘汰旧刷新', async () => {
  const { ADO_WEB_KEY, WORKBENCH_CONFIG_KEY, useWorkbench } = await loadModules();
  const oldResponses: Array<{ url: string; resolve: (response: Response) => void }> = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    return new Promise<Response>((resolve) => oldResponses.push({ url, resolve }));
  }) as typeof fetch;

  useWorkbench.setState({ config: { mode: 'bridge', bridge: 'http://old', account: '' } });
  const oldRefresh = useWorkbench.getState().refresh();
  await waitFor(() => oldResponses.length === 4);

  localStorage.setItem(ADO_WEB_KEY, 'http://web-old');
  useWorkbench.getState().setConfig({ mode: 'bridge', account: '' });
  assert.equal(useWorkbench.getState().loading, false);
  assert.equal(localStorage.getItem(ADO_WEB_KEY), null);
  for (const pending of oldResponses) pending.resolve(responseFor(pending.url, 1));
  await oldRefresh;

  const state = useWorkbench.getState();
  assert.equal(state.config?.bridge, undefined);
  assert.deepEqual(state.workItems, []);
  assert.equal(state.error, null);
  assert.equal(state.loading, false);
  assert.equal(localStorage.getItem(ADO_WEB_KEY), null);
  assert.doesNotMatch(localStorage.getItem(WORKBENCH_CONFIG_KEY) ?? '', /http:\/\/old/);
});
