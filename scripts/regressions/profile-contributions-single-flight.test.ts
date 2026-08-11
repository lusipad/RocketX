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

function adoJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadStores() {
  const [{ useWorkbench }, { useProfileContributions }] = await Promise.all([
    import('../../apps/web/src/stores/workbench'),
    import('../../apps/web/src/stores/profileContributions'),
  ]);
  return { useWorkbench, useProfileContributions };
}

async function flushTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  values.clear();
  const { useWorkbench, useProfileContributions } = await loadStores();
  useProfileContributions.getState().cancel();
  useProfileContributions.setState({
    identity: null,
    events: [],
    statuses: [],
    loading: false,
    error: null,
    lastUpdated: null,
    range: { from: '2026-06-13', to: '2026-08-12' },
    filters: {},
    projects: [],
    repositories: [],
    selectedDay: null,
  });
  useWorkbench.setState({ config: null, configRevision: 0 });
});

test('同条件的普通在途加载只发起一次 ADO 请求', async () => {
  const { useWorkbench, useProfileContributions } = await loadStores();
  useWorkbench.setState({
    config: { adoBase: 'http://ado/single-flight', pat: '', auth: 'none', account: '' },
    configRevision: 7,
  });
  useProfileContributions.setState({
    range: { from: '2026-06-13', to: '2026-08-12' },
    filters: { type: 'work-item' },
  });

  let identityCalls = 0;
  let releaseIdentity!: () => void;
  const identityGate = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  let markIdentityStarted!: () => void;
  const identityStarted = new Promise<void>((resolve) => {
    markIdentityStarted = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) {
      identityCalls += 1;
      markIdentityStarted();
      await identityGate;
      return adoJson({
        authenticatedUser: {
          id: 'user-1',
          customDisplayName: 'Alice',
          properties: { Account: { $value: 'corp\\alice' } },
        },
      });
    }
    if (url.includes('/_apis/projects')) return adoJson({ value: [] });
    throw new Error(`未处理请求: ${url}`);
  }) as typeof fetch;

  const first = useProfileContributions.getState().load();
  await identityStarted;
  const second = useProfileContributions.getState().load();
  await flushTasks();

  assert.equal(identityCalls, 1);
  releaseIdentity();
  await Promise.all([first, second]);
  assert.equal(useProfileContributions.getState().identity?.id, 'user-1');
  assert.equal(useProfileContributions.getState().error, null);
});

test('force 不复用同条件的普通在途加载', async () => {
  const { useWorkbench, useProfileContributions } = await loadStores();
  useWorkbench.setState({
    config: { adoBase: 'http://ado/force', pat: '', auth: 'none', account: '' },
    configRevision: 9,
  });
  useProfileContributions.setState({ filters: { type: 'work-item' } });

  let identityCalls = 0;
  let releaseIdentity!: () => void;
  const identityGate = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  let markIdentityStarted!: () => void;
  const identityStarted = new Promise<void>((resolve) => {
    markIdentityStarted = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) {
      identityCalls += 1;
      markIdentityStarted();
      await identityGate;
      return adoJson({
        authenticatedUser: {
          id: 'user-1',
          customDisplayName: 'Alice',
          properties: { Account: { $value: 'corp\\alice' } },
        },
      });
    }
    if (url.includes('/_apis/projects')) return adoJson({ value: [] });
    throw new Error(`未处理请求: ${url}`);
  }) as typeof fetch;

  const first = useProfileContributions.getState().load();
  await identityStarted;
  const forced = useProfileContributions.getState().load({ force: true });
  await flushTasks();

  const callsBeforeRelease = identityCalls;
  releaseIdentity();
  await Promise.all([first, forced]);
  assert.equal(callsBeforeRelease, 2);
  assert.equal(useProfileContributions.getState().identity?.id, 'user-1');
});

test('在途加载失败后同条件请求可以重新发起', async () => {
  const { useWorkbench, useProfileContributions } = await loadStores();
  useWorkbench.setState({
    config: { adoBase: 'http://ado/retry', pat: '', auth: 'none', account: '' },
    configRevision: 8,
  });
  useProfileContributions.setState({ filters: { type: 'work-item' } });

  let identityCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/_apis/connectionData')) {
      identityCalls += 1;
      if (identityCalls === 1) return adoJson({ message: 'temporary failure' }, 500);
      return adoJson({
        authenticatedUser: {
          id: 'user-1',
          customDisplayName: 'Alice',
          properties: { Account: { $value: 'corp\\alice' } },
        },
      });
    }
    if (url.includes('/_apis/projects')) return adoJson({ value: [] });
    throw new Error(`未处理请求: ${url}`);
  }) as typeof fetch;

  await useProfileContributions.getState().load();
  assert.match(useProfileContributions.getState().error ?? '', /500/);

  await useProfileContributions.getState().load();
  assert.equal(identityCalls, 2);
  assert.equal(useProfileContributions.getState().identity?.id, 'user-1');
  assert.equal(useProfileContributions.getState().error, null);
});
