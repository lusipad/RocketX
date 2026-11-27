import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RcApiError } from '../../packages/rc-client/src/request';
import {
  applyClientStateSnapshot,
  CLIENT_STATE_BACKUP_SCHEMA,
  collectClientStateSnapshot,
} from '../../apps/web/src/lib/desktopConfigBackup';
import { hasExistingRocketXUserState } from '../../apps/web/src/lib/firstRun';
import { rest, saveAuth, loadStoredAuth } from '../../apps/web/src/lib/client';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useChat } from '../../apps/web/src/stores/chat';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

test('Issue #402: bootstrap registers calendar/todos/workbench before render and does not block indefinitely on AI runtime probe', () => {
  const main = readFileSync('apps/web/src/main.tsx', 'utf8');
  const runtime = readFileSync('apps/web/src/kernel/runtime.tsx', 'utf8');
  const butlerPage = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');

  const bootstrapIdx = main.indexOf('async function bootstrapOnce');
  const restoreIdx = main.indexOf('restoreDesktopClientStateIfEmpty(localStorage)', bootstrapIdx);
  const registerIdx = main.indexOf('ensureCoreModulesRegistered()', bootstrapIdx);
  const rootRenderIdx = main.indexOf('ReactDOM.createRoot(', bootstrapIdx);
  const syncAiIdx = main.indexOf('syncAiKernelBuiltins()');

  assert.ok(bootstrapIdx >= 0 && restoreIdx > bootstrapIdx && registerIdx > restoreIdx && rootRenderIdx > registerIdx);
  assert.ok(syncAiIdx >= 0);
  assert.match(main, /initializeRuntime:\s*async[\s\S]*Promise\.race\(/);
  assert.match(runtime, /export function ensureCoreModulesRegistered/);
  assert.match(runtime, /export function syncAiKernelBuiltins/);
  assert.match(butlerPage, /aiRuntimeProbing \?/);
});

test('Issue #402: auth.resume keeps token, account scope, and calendar/workbench data on offline/network errors', async () => {
  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const prevDoc = (globalThis as { document?: unknown }).document;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: '' },
  });

  const origLoginWithToken = rest.loginWithToken;
  try {
    saveAuth({ authToken: 'tok-offline-keep', userId: 'u-402' });
    storage.setItem('rcx-server', 'https://chat.company.test');
    storage.setItem('rcx-owner', 'u-402@https://chat.company.test');
    storage.setItem('rcx-calendar', JSON.stringify([{ id: 'evt-1', title: '周会', date: '2026-11-27' }]));
    storage.setItem('rcx-workbench', JSON.stringify({ adoBase: 'https://ado.company.test', account: 'alice' }));
    storage.setItem('rcx-user-cache', JSON.stringify({ _id: 'u-402', username: 'alice', name: 'Alice' }));

    (rest as { loginWithToken: typeof rest.loginWithToken }).loginWithToken = async () => {
      throw new Error('Failed to fetch: connection timed out');
    };

    useAuth.setState({ status: 'boot', localMode: false, user: null, error: null });
    await useAuth.getState().resume();

    assert.equal(useAuth.getState().status, 'authed');
    assert.equal(useAuth.getState().localMode, false);
    assert.equal(useAuth.getState().user?.username, 'alice');
    assert.deepEqual(loadStoredAuth(), { authToken: 'tok-offline-keep', userId: 'u-402' });
    assert.equal(storage.getItem('rcx-owner'), 'u-402@https://chat.company.test');
    assert.ok(storage.getItem('rcx-calendar')?.includes('周会'));
    assert.ok(storage.getItem('rcx-workbench')?.includes('ado.company.test'));
  } finally {
    (rest as { loginWithToken: typeof rest.loginWithToken }).loginWithToken = origLoginWithToken;
    useAuth.setState({ status: 'guest', localMode: false, user: null, error: null });
    if (prevStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prevStorage });
    if (prevDoc === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: prevDoc });
  }
});

test('Issue #402: auth.resume on HTTP 401 clears token only and preserves owner, server, calendar, and workbench', async () => {
  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const prevDoc = (globalThis as { document?: unknown }).document;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: '' },
  });

  const origLoginWithToken = rest.loginWithToken;
  try {
    saveAuth({ authToken: 'tok-expired', userId: 'u-402' });
    storage.setItem('rcx-server', 'https://chat.company.test');
    storage.setItem('rcx-owner', 'u-402@same-origin');
    storage.setItem('rcx-calendar', JSON.stringify([{ id: 'evt-1', title: '周会', date: '2026-11-27' }]));
    storage.setItem('rcx-workbench', JSON.stringify({ adoBase: 'https://ado.company.test', account: 'alice' }));

    (rest as { loginWithToken: typeof rest.loginWithToken }).loginWithToken = async () => {
      throw new RcApiError('Unauthorized', 401, 'error-invalid-token');
    };

    useAuth.setState({ status: 'boot', localMode: false, needsReauth: false, user: null, error: null });
    await useAuth.getState().resume();

    assert.equal(useAuth.getState().status, 'authed');
    assert.equal(useAuth.getState().localMode, false);
    assert.equal(useAuth.getState().needsReauth, true);
    assert.equal(useAuth.getState().user?._id, 'u-402');
    assert.equal(useAuth.getState().error?.kind, 'session_expired');
    assert.equal(loadStoredAuth(), null);
    assert.equal(storage.getItem('rcx-owner'), 'u-402@same-origin');
    assert.equal(storage.getItem('rcx-server'), 'https://chat.company.test');
    assert.ok(storage.getItem('rcx-calendar')?.includes('周会'));
    assert.ok(storage.getItem('rcx-workbench')?.includes('ado.company.test'));
  } finally {
    (rest as { loginWithToken: typeof rest.loginWithToken }).loginWithToken = origLoginWithToken;
    useAuth.setState({ status: 'guest', localMode: false, needsReauth: false, user: null, error: null });
    if (prevStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prevStorage });
    if (prevDoc === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: prevDoc });
  }
});

test('Issue #402: offline chat.init still marks ready and reconnecting so core modules stay unlocked', async () => {
  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const prevDoc = (globalThis as { document?: unknown }).document;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: '' },
  });

  const origGetSubs = rest.getSubscriptions;
  const origGetRooms = rest.getRooms;
  try {
    saveAuth({ authToken: 'tok-offline', userId: 'u-offline' });
    useAuth.setState({
      status: 'authed',
      localMode: false,
      user: { _id: 'u-offline', username: 'alice', name: 'Alice', status: 'offline' },
      error: null,
    });
    useChat.setState({ ready: false, connection: 'idle' });
    (rest as { getSubscriptions: typeof rest.getSubscriptions }).getSubscriptions = async () => {
      throw new Error('offline');
    };
    (rest as { getRooms: typeof rest.getRooms }).getRooms = async () => {
      throw new Error('offline');
    };

    await useChat.getState().init();
    assert.equal(useChat.getState().ready, true);
    assert.equal(useChat.getState().connection, 'reconnecting');
  } finally {
    (rest as { getSubscriptions: typeof rest.getSubscriptions }).getSubscriptions = origGetSubs;
    (rest as { getRooms: typeof rest.getRooms }).getRooms = origGetRooms;
    useAuth.setState({ status: 'guest', localMode: false, user: null, error: null });
    useChat.setState({ ready: false, connection: 'idle' });
    if (prevStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prevStorage });
    if (prevDoc === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: prevDoc });
  }
});

test('Issue #402: desktopConfigBackup backs up & restores config cleanly without tokens/PAT and ignores legacy shapes', () => {
  const source = new MemoryStorage();
  source.setItem('rcx-auth', JSON.stringify({ authToken: 'secret-rc-token', userId: 'u1' }));
  source.setItem('rcx-server', 'https://chat.example.com');
  source.setItem('rcx-owner', 'u1@https://chat.example.com');
  source.setItem('rcx-calendar', JSON.stringify({ version: 1, data: [{ id: 'c1', title: '评审会', date: '2026-11-27' }] }));
  source.setItem('rcx-workbench', JSON.stringify({ adoBase: 'https://ado.example.com', pat: 'secret-pat-123', account: 'alice' }));
  source.setItem('rcx-folders#u2@other', JSON.stringify([{ id: 'f1', name: 'Pinned', rids: [] }]));

  assert.equal(hasExistingRocketXUserState(source), true);
  const snapshot = collectClientStateSnapshot(source);
  assert.equal(snapshot.schema, CLIENT_STATE_BACKUP_SCHEMA);
  assert.equal('rcx-auth' in snapshot.entries, false, 'rcx-auth token must never enter backup');
  assert.equal(snapshot.entries['rcx-server'], 'https://chat.example.com');
  assert.equal(snapshot.entries['rcx-workbench']?.includes('secret-pat-123'), false, 'PAT must be stripped');
  assert.equal(snapshot.entries['rcx-workbench']?.includes('https://ado.example.com'), true);
  assert.ok(snapshot.entries['rcx-folders#u2@other']);

  // Non-backup shape from older desktop_preferences payloads must be ignored cleanly
  const fresh = new MemoryStorage();
  assert.equal(applyClientStateSnapshot(fresh, { version: 1, autostart: false, trayClose: true }), 0);

  // Restoring into an empty WebView storage recovers previous settings without overwriting existing keys
  fresh.setItem('rcx-theme', 'dark');
  const count = applyClientStateSnapshot(fresh, snapshot);
  assert.ok(count >= 4);
  assert.equal(fresh.getItem('rcx-theme'), 'dark');
  assert.equal(fresh.getItem('rcx-server'), 'https://chat.example.com');
  assert.ok(fresh.getItem('rcx-calendar')?.includes('评审会'));
  assert.equal(hasExistingRocketXUserState(fresh), true);
});

test('Issue #402 Xa: auth.resume without token preserves restored remote rcx-owner via needsReauth instead of switching to local-user@local', async () => {
  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const prevDoc = (globalThis as { document?: unknown }).document;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: '' },
  });

  try {
    storage.setItem('rcx-server', 'https://chat.example.com');
    storage.setItem('rcx-owner', 'alice-id@https://chat.example.com');
    storage.setItem('rcx-user-cache', JSON.stringify({ _id: 'alice-id', username: 'alice', name: 'Alice' }));
    storage.setItem('rcx-calendar', JSON.stringify([{ id: 'evt-xa', title: 'Xa评审', date: '2026-11-28' }]));
    storage.setItem('rcx-workbench', JSON.stringify({ adoBase: 'https://ado.example.com', account: 'alice' }));

    useAuth.setState({ status: 'boot', localMode: false, needsReauth: false, user: null, error: null });
    await useAuth.getState().resume();

    assert.equal(useAuth.getState().status, 'authed');
    assert.equal(useAuth.getState().localMode, false);
    assert.equal(useAuth.getState().needsReauth, true);
    assert.equal(useAuth.getState().user?._id, 'alice-id');
    assert.equal(useAuth.getState().user?.username, 'alice');
    assert.equal(storage.getItem('rcx-owner'), 'alice-id@https://chat.example.com');
    assert.equal(storage.getItem('rcx-local-mode'), null);
    assert.ok(storage.getItem('rcx-calendar')?.includes('Xa评审'));
    assert.ok(storage.getItem('rcx-workbench')?.includes('ado.example.com'));
  } finally {
    useAuth.setState({ status: 'guest', localMode: false, needsReauth: false, user: null, error: null });
    if (prevStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prevStorage });
    if (prevDoc === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: prevDoc });
  }
});

test('Issue #402 Xb: handleAuthLost locks remote messaging via needsReauth without switching account scope, and chat.init resolves ready', async () => {
  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const prevDoc = (globalThis as { document?: unknown }).document;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: '' },
  });

  try {
    saveAuth({ authToken: 'tok-live', userId: 'alice-id' });
    storage.setItem('rcx-owner', 'alice-id@https://chat.example.com');
    storage.setItem('rcx-calendar', JSON.stringify([{ id: 'evt-xb', title: 'Xb日程', date: '2026-11-28' }]));
    useAuth.setState({
      status: 'authed',
      localMode: false,
      needsReauth: false,
      user: { _id: 'alice-id', username: 'alice', name: 'Alice', status: 'online' },
      error: null,
    });
    useChat.setState({ ready: false, connection: 'connected' });

    useAuth.getState().handleAuthLost();

    assert.equal(useAuth.getState().status, 'authed');
    assert.equal(useAuth.getState().localMode, false);
    assert.equal(useAuth.getState().needsReauth, true);
    assert.equal(useAuth.getState().user?._id, 'alice-id');
    assert.equal(useAuth.getState().user?.status, 'offline');
    assert.equal(loadStoredAuth(), null);
    assert.equal(storage.getItem('rcx-owner'), 'alice-id@https://chat.example.com');
    assert.ok(storage.getItem('rcx-calendar')?.includes('Xb日程'));

    await useChat.getState().init();
    assert.equal(useChat.getState().ready, true);
    assert.equal(useChat.getState().connection, 'idle');
  } finally {
    useAuth.setState({ status: 'guest', localMode: false, needsReauth: false, user: null, error: null });
    useChat.setState({ ready: false, connection: 'idle' });
    if (prevStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prevStorage });
    if (prevDoc === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: prevDoc });
  }
});

test('Issue #402 Xc: startBackground never awaits runtimeProviderReady and App gates fatal screen on foundation ops only', () => {
  const main = readFileSync('apps/web/src/main.tsx', 'utf8');
  const app = readFileSync('apps/web/src/App.tsx', 'utf8');

  const bgStart = main.indexOf('startBackground:');
  const bgEnd = main.indexOf('onState:', bgStart);
  assert.ok(bgStart >= 0 && bgEnd > bgStart);
  const bgBlock = main.slice(bgStart, bgEnd);
  assert.equal(bgBlock.includes('runtimeProviderReady'), false);
  assert.match(main, /return 'none' as const/);

  assert.match(app, /status !== 'authed' && !localMode && !needsReauth/);
  assert.match(app, /isBlockingStartupError/);
  assert.match(app, /\['platform', 'auth', 'account'\]\.includes\(startupError\.operation\)/);
});
