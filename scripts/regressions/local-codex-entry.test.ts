import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { __TAURI_INTERNALS__: {} },
});

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  },
});

type LocalCodexModule = typeof import('../../apps/web/src/stores/localCodex');
type ProtocolModule = typeof import('../../apps/web/src/agent/protocol');
type LoadedModules = Pick<LocalCodexModule, 'useLocalCodex' | 'resolveLocalCodexResumeFailure'>
  & Pick<ProtocolModule, 'AppServerClient' | 'AppServerRpcError'>;

let cachedModules: LoadedModules | null = null;

async function loadModules(): Promise<LoadedModules> {
  if (cachedModules) return cachedModules;
  const localCodexModule = await import('../../apps/web/src/stores/localCodex');
  const protocolModule = await import('../../apps/web/src/agent/protocol');
  cachedModules = {
    useLocalCodex: localCodexModule.useLocalCodex,
    resolveLocalCodexResumeFailure: localCodexModule.resolveLocalCodexResumeFailure,
    AppServerClient: protocolModule.AppServerClient,
    AppServerRpcError: protocolModule.AppServerRpcError,
  };
  return cachedModules;
}

async function resetStore(scope = 'https://chat.example:user-1', persisted?: Record<string, unknown>): Promise<void> {
  const { useLocalCodex } = await loadModules();
  values.clear();
  if (persisted) values.set(`rcx-local-codex-v1:${scope}`, JSON.stringify(persisted));
  useLocalCodex.setState({
    scope: '',
    workspaceRoot: '',
    sessionId: undefined,
    threadId: undefined,
    activeTurnId: undefined,
    sandboxMode: 'read-only',
    status: 'idle',
    messages: [],
    traces: [],
    approvals: [],
    error: null,
  });
  useLocalCodex.getState().hydrate(scope);
}

async function withMockedResumeFailure(error: Error, run: () => Promise<void>): Promise<void> {
  const { AppServerClient } = await loadModules();
  const originalStart = AppServerClient.prototype.start;
  const originalRequest = AppServerClient.prototype.request;
  const originalStop = AppServerClient.prototype.stop;

  AppServerClient.prototype.start = async function start() {};
  AppServerClient.prototype.request = async function request(method: string) {
    if (method === 'thread/resume') throw error;
    throw new Error(`unexpected request: ${method}`);
  };
  AppServerClient.prototype.stop = async function stop() {};

  try {
    await run();
  } finally {
    AppServerClient.prototype.start = originalStart;
    AppServerClient.prototype.request = originalRequest;
    AppServerClient.prototype.stop = originalStop;
  }
}

test('Codex 本地设置按账号保存，但不把对话和过程写入 localStorage', async () => {
  const { useLocalCodex } = await loadModules();
  await resetStore();
  useLocalCodex.getState().setWorkspaceRoot('D:/Repos/example');
  useLocalCodex.setState({
    messages: [{ id: 'message-1', role: 'user', text: 'sensitive transcript', at: 1 }],
    traces: [{ id: 'trace-1', kind: 'tool', text: 'sensitive trace', at: 1 }],
  });
  useLocalCodex.getState().setSandboxMode('workspace-write');

  const saved = values.get('rcx-local-codex-v1:https://chat.example:user-1');
  assert.ok(saved);
  assert.deepEqual(JSON.parse(saved), {
    workspaceRoot: 'D:/Repos/example',
    sandboxMode: 'workspace-write',
  });
  assert.equal(saved.includes('sensitive transcript'), false);
  assert.equal(saved.includes('sensitive trace'), false);
});

test('失效 rollout 的 thread/resume 会清理持久化 threadId，并提示新建会话', async () => {
  const { useLocalCodex, AppServerRpcError } = await loadModules();
  await resetStore('https://chat.example:user-2', {
    workspaceRoot: 'D:/Repos/example',
    sessionId: 'local-session',
    threadId: 'stale-thread',
    sandboxMode: 'read-only',
  });

  await withMockedResumeFailure(
    new AppServerRpcError('thread/resume', -32600, 'no rollout found for thread id stale-thread'),
    async () => {
      await assert.rejects(() => useLocalCodex.getState().resume(), /no rollout found for thread id stale-thread/);
      const state = useLocalCodex.getState();
      assert.equal(state.threadId, undefined);
      assert.equal(state.status, 'idle');
      assert.equal(state.error, '上次保存的 Codex 会话已失效，请新建会话。');
      assert.equal(values.get('rcx-local-codex-v1:https://chat.example:user-2'), JSON.stringify({
        workspaceRoot: 'D:/Repos/example',
        sessionId: 'local-session',
        sandboxMode: 'read-only',
      }));
    },
  );
});

test('瞬态 resume 错误保留 threadId，继续允许 reconnect', async () => {
  const { useLocalCodex, AppServerRpcError } = await loadModules();
  await resetStore('https://chat.example:user-3', {
    workspaceRoot: 'D:/Repos/example',
    sessionId: 'local-session',
    threadId: 'live-thread',
    sandboxMode: 'read-only',
  });

  await withMockedResumeFailure(
    new AppServerRpcError('thread/resume', -32000, 'temporary transport failure'),
    async () => {
      await assert.rejects(() => useLocalCodex.getState().resume(), /temporary transport failure/);
      const state = useLocalCodex.getState();
      assert.equal(state.threadId, 'live-thread');
      assert.equal(state.status, 'interrupted');
      assert.match(state.error ?? '', /temporary transport failure/);
      assert.equal(values.get('rcx-local-codex-v1:https://chat.example:user-3'), JSON.stringify({
        workspaceRoot: 'D:/Repos/example',
        sessionId: 'local-session',
        threadId: 'live-thread',
        sandboxMode: 'read-only',
      }));
    },
  );
});

test('永久失效判定只命中 thread/resume 的 no rollout found', async () => {
  const { resolveLocalCodexResumeFailure, AppServerRpcError } = await loadModules();
  assert.deepEqual(
    resolveLocalCodexResumeFailure(new AppServerRpcError('thread/resume', -32600, 'no rollout found for thread id dead-thread')),
    {
      clearThread: true,
      message: '上次保存的 Codex 会话已失效，请新建会话。',
      status: 'idle',
    },
  );
  assert.deepEqual(
    resolveLocalCodexResumeFailure(new AppServerRpcError('thread/resume', -32600, 'invalid params')),
    {
      clearThread: false,
      message: 'invalid params',
      status: 'interrupted',
    },
  );
});

test('Codex 入口直接使用所选本地目录和原生沙箱审批', async () => {
  const source = await readFile(new URL('../../apps/web/src/stores/localCodex.ts', import.meta.url), 'utf8');
  assert.match(source, /new TauriCodexTransport\(state\.sessionId!, state\.workspaceRoot\)/);
  assert.match(source, /runtimeWorkspaceRoots: \[state\.workspaceRoot\]/);
  assert.match(source, /sandbox: state\.sandboxMode/);
  assert.match(source, /validateApprovalPaths\(params, \[get\(\)\.workspaceRoot\]\)/);
  assert.match(source, /commandRequestMentionsSensitivePath\(params\.command\)/);
  assert.match(source, /validatePermissionRequest\(/);
});
