import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DshAgentPreset,
  DshModelSelection,
  DshSettingsDescription,
} from '../../apps/web/src/agent/dsh/config.ts';

const WORKSPACE_ROOT = 'D:/Repos/rocketchatx';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.has(key) ? this.values.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

interface NativeCall {
  method: string;
  payload: Record<string, unknown>;
}

class FakeNativeDsh {
  readonly calls: NativeCall[] = [];
  readonly responses = new Map<string, unknown[]>();
  readonly responsesSent: Record<string, unknown>[] = [];
  readonly startArgs: Record<string, unknown>[] = [];
  stopCount = 0;
  private readonly callbacks = new Map<number, (value: unknown) => void>();
  private readonly listeners = new Map<string, Map<number, number>>();
  private nextCallbackId = 1;
  private nextEventId = 1;
  private processId = 'process-1';

  queue(method: string, ...values: unknown[]): void {
    this.responses.set(method, values);
  }

  transformCallback(callback: (value: unknown) => void): number {
    const id = this.nextCallbackId++;
    this.callbacks.set(id, callback);
    return id;
  }

  unregisterCallback(id: number): void {
    this.callbacks.delete(id);
  }

  unregisterListener(event: string, eventId: number): void {
    this.listeners.get(event)?.delete(eventId);
  }

  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (command === 'plugin:event|listen') {
      const event = String(args.event ?? '');
      const handlerId = Number(args.handler ?? 0);
      const eventId = this.nextEventId++;
      let bucket = this.listeners.get(event);
      if (!bucket) {
        bucket = new Map();
        this.listeners.set(event, bucket);
      }
      bucket.set(eventId, handlerId);
      return eventId as T;
    }
    if (command === 'plugin:event|unlisten') {
      this.unregisterListener(String(args.event ?? ''), Number(args.eventId ?? 0));
      return undefined as T;
    }
    if (command === 'dsh_bridge_start') {
      this.startArgs.push(args);
      queueMicrotask(() => {
        this.emit('dsh-bridge-output', {
          processId: this.processId,
          stream: 'stdout',
          line: JSON.stringify({ kind: 'ready', url: 'http://127.0.0.1:4123' }),
        });
      });
      return { processId: this.processId } as T;
    }
    if (command === 'dsh_bridge_stop') {
      this.stopCount += 1;
      return undefined as T;
    }
    if (command !== 'dsh_bridge_write') throw new Error(`unexpected native command: ${command}`);
    const message = (args.message ?? {}) as Record<string, unknown>;
    if (message.kind === 'respond') {
      this.responsesSent.push((message.response ?? {}) as Record<string, unknown>);
      queueMicrotask(() => {
        this.emit('dsh-bridge-output', {
          processId: this.processId,
          stream: 'stdout',
          line: JSON.stringify({
            kind: 'response',
            id: String(message.id ?? ''),
            op: 'respond',
            response: { accepted: true },
          }),
        });
      });
      return undefined as T;
    }
    const method = String(message.method ?? '');
    const payload = (message.payload ?? {}) as Record<string, unknown>;
    this.calls.push({ method, payload });
    const queue = this.responses.get(method) ?? [];
    if (queue.length === 0) throw new Error(`unexpected native call: ${method}`);
    const response = {
      type: 'server-response',
      rpcId: String(message.id ?? ''),
      result: { ok: true, value: queue.shift() },
    };
    queueMicrotask(() => {
      this.emit('dsh-bridge-output', {
        processId: this.processId,
        stream: 'stdout',
        line: JSON.stringify({
          kind: 'response',
          id: String(message.id ?? ''),
          op: 'call',
          response,
        }),
      });
    });
    return undefined as T;
  }

  emitExit(code: number | null = 0): void {
    this.emit('dsh-bridge-exit', { processId: this.processId, code });
  }

  private emit(event: string, payload: unknown): void {
    for (const [eventId, callbackId] of this.listeners.get(event) ?? []) {
      const callback = this.callbacks.get(callbackId);
      callback?.({ event, id: eventId, payload });
    }
  }
}

let activeNative: FakeNativeDsh | null = null;

function installBrowserStubs(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (value: unknown) => void) => {
          if (!activeNative) throw new Error('no active native runtime');
          return activeNative.transformCallback(callback);
        },
        unregisterCallback: (id: number) => activeNative?.unregisterCallback(id),
        invoke: (command: string, args?: Record<string, unknown>) => {
          if (!activeNative) throw new Error('no active native runtime');
          return activeNative.invoke(command, args);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (event: string, eventId: number) => activeNative?.unregisterListener(event, eventId),
      },
      open: () => undefined,
      getSelection: () => null,
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      cookie: '',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: new MemoryStorage(),
  });
}

installBrowserStubs();
const workspaceModulePromise = import('../../apps/web/src/stores/dshWorkspace.ts');

async function resetWorkspace(label: string) {
  const workspace = await workspaceModulePromise;
  await workspace.useDshWorkspace.getState().setWorkspaceRoot(`${WORKSPACE_ROOT}/${label}`);
  return workspace;
}

function configurationResponse(overrides: Partial<DshSettingsDescription> = {}): DshSettingsDescription {
  return {
    writable: false,
    namespaces: [],
    ...overrides,
  };
}

function permissionSettingsResponse(currentValue = 'workspace-write'): DshSettingsDescription {
  return {
    writable: true,
    namespaces: [{
      ns: 'permission',
      revision: 7,
      value: { defaultPreset: currentValue },
      schema: {
        uid: 4,
        refs: {
          1: { type: 'const', value: 'workspace-write', meta: { description: '工作区写入' } },
          2: { type: 'const', value: 'danger-full-access', meta: { description: '完全访问' } },
          3: { type: 'union', list: [1, 2] },
          4: { type: 'object', dict: { defaultPreset: 3 } },
        },
      },
    }],
  };
}

function agentPreset(id: string, extra: Partial<DshAgentPreset> = {}): DshAgentPreset {
  return {
    id,
    trust: 'user',
    isDefault: false,
    ...extra,
  };
}

test('connect loads workspace state from native RPC and startSession creates a blank native session', async () => {
  const fake = new FakeNativeDsh();
  fake.queue('host.describe', {});
  fake.queue('session.list', { items: [] });
  fake.queue('credentials.describe', {
    credentials: { DEEPSEEK_API_KEY: { configured: true, writable: false } },
  });
  fake.queue('agentPreset.list', { presets: [] });
  fake.queue('settings.describe', configurationResponse());
  fake.queue('llm.models', { groups: [], failures: [] });
  fake.queue('session.create', { sessionId: 'session-new' });
  fake.queue('session.models', {
    current: { provider: 'deepseek', model: 'deepseek-reasoner' },
    routable: true,
    groups: [],
    failures: [],
  });
  activeNative = fake;
  try {
    const workspace = await resetWorkspace('connect-start');
    const workspaceRoot = workspace.useDshWorkspace.getState().workspaceRoot;

    await workspace.useDshWorkspace.getState().connect();
    await workspace.useDshWorkspace.getState().startSession();

    assert.deepEqual(
      fake.calls.map((call) => call.method),
      [
        'host.describe',
        'session.list',
        'credentials.describe',
        'agentPreset.list',
        'settings.describe',
        'llm.models',
        'session.create',
        'session.models',
      ],
    );
    assert.deepEqual(fake.calls.at(-2), {
      method: 'session.create',
      payload: { cwd: workspaceRoot },
    });
    const state = workspace.useDshWorkspace.getState();
    assert.equal(state.status, 'ready');
    assert.equal(state.activeSessionId, 'session-new');
    assert.equal(state.sessions[0]?.blank, true);
    assert.deepEqual(state.modelSelection, {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    });
  } finally {
    activeNative = null;
  }
});

test('send fails closed before any native RPC when DeepSeek credential is missing', async () => {
  activeNative = new FakeNativeDsh();
  try {
    const workspace = await resetWorkspace('send-no-credential');
    workspace.useDshWorkspace.setState({
      status: 'ready',
      credentialConfigured: false,
      activeSessionId: null,
    });

    await assert.rejects(
      workspace.useDshWorkspace.getState().send('请执行一次请求'),
      /请先配置 DeepSeek API Key/,
    );
    assert.equal(workspace.useDshWorkspace.getState().activeSessionId, null);
  } finally {
    activeNative = null;
  }
});

test('selectModel creates a blank session before calling the native model selection RPC', async () => {
  const fake = new FakeNativeDsh();
  fake.queue('host.describe', {});
  fake.queue('session.list', { items: [] });
  fake.queue('credentials.describe', {
    credentials: { DEEPSEEK_API_KEY: { configured: true, writable: false } },
  });
  fake.queue('agentPreset.list', { presets: [] });
  fake.queue('settings.describe', configurationResponse());
  fake.queue('llm.models', { groups: [], failures: [] });
  fake.queue('session.create', { sessionId: 'session-model' });
  fake.queue('session.models', {
    current: { provider: 'deepseek', model: 'deepseek-reasoner' },
    routable: true,
    groups: [],
    failures: [],
  });
  fake.queue('session.selectModel', {
    selected: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  });
  activeNative = fake;
  try {
    const workspace = await resetWorkspace('select-model');
    const workspaceRoot = workspace.useDshWorkspace.getState().workspaceRoot;
    await workspace.useDshWorkspace.getState().connect();

    const selection: DshModelSelection = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    };
    await workspace.useDshWorkspace.getState().selectModel(selection);

    assert.deepEqual(fake.calls.slice(-3), [
      { method: 'session.create', payload: { cwd: workspaceRoot } },
      { method: 'session.models', payload: { sessionId: 'session-model' } },
      {
        method: 'session.selectModel',
        payload: {
          sessionId: 'session-model',
          provider: 'deepseek',
          model: 'deepseek-chat',
          reasoningEffort: 'high',
        },
      },
    ]);
    assert.deepEqual(workspace.useDshWorkspace.getState().modelSelection, selection);
  } finally {
    activeNative = null;
  }
});

test('openSession clears the previous model before loading the selected session model', async () => {
  const fake = new FakeNativeDsh();
  fake.queue('host.describe', {});
  fake.queue('session.list', { items: [] });
  fake.queue('credentials.describe', {
    credentials: { DEEPSEEK_API_KEY: { configured: true, writable: false } },
  });
  fake.queue('agentPreset.list', { presets: [] });
  fake.queue('settings.describe', configurationResponse());
  fake.queue('llm.models', { groups: [], failures: [] });
  fake.queue('session.history', { events: [], hasMore: false });
  fake.queue('session.models', {
    current: { provider: 'deepseek', model: 'deepseek-reasoner' },
    routable: true,
    groups: [],
    failures: [],
  });
  activeNative = fake;
  try {
    const workspace = await resetWorkspace('open-session-model');
    await workspace.useDshWorkspace.getState().connect();
    workspace.useDshWorkspace.setState({
      activeSessionId: 'session-old',
      sessions: [
        { id: 'session-old', updatedAt: 1, status: 'idle', blank: false },
        { id: 'session-new', updatedAt: 2, status: 'idle', blank: false },
      ],
      modelSelection: { provider: 'deepseek', model: 'deepseek-chat' },
    });

    const opening = workspace.useDshWorkspace.getState().openSession('session-new');
    assert.equal(workspace.useDshWorkspace.getState().modelSelection, null);
    await opening;
    assert.deepEqual(workspace.useDshWorkspace.getState().modelSelection, {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    });
  } finally {
    activeNative = null;
  }
});

test('selectAgentPreset applies the preset to the current blank session through native RPC', async () => {
  const fake = new FakeNativeDsh();
  fake.queue('host.describe', {});
  fake.queue('session.list', { items: [] });
  fake.queue('credentials.describe', {
    credentials: { DEEPSEEK_API_KEY: { configured: true, writable: false } },
  });
  fake.queue('agentPreset.list', { presets: [] });
  fake.queue('settings.describe', configurationResponse());
  fake.queue('llm.models', { groups: [], failures: [] });
  fake.queue('settings.update', {});
  fake.queue('agentPreset.select', { agentPreset: 'preset-a' });
  activeNative = fake;
  try {
    const workspace = await resetWorkspace('select-agent-blank');
    await workspace.useDshWorkspace.getState().connect();
    workspace.useDshWorkspace.setState({
      configurationWritable: true,
      activeSessionId: 'session-blank',
      sessions: [{ id: 'session-blank', updatedAt: 1, status: 'idle', blank: true }],
      agentPresets: [agentPreset('preset-a')],
    });

    await workspace.useDshWorkspace.getState().selectAgentPreset('preset-a');

    assert.deepEqual(fake.calls.slice(-2), [
      {
        method: 'settings.update',
        payload: { ns: 'agent-presets', patch: { default: 'preset-a' } },
      },
      {
        method: 'agentPreset.select',
        payload: { sessionId: 'session-blank', agentPreset: 'preset-a' },
      },
    ]);
    const state = workspace.useDshWorkspace.getState();
    assert.equal(state.defaultAgentPreset, 'preset-a');
    assert.equal(state.sessions[0]?.agentPreset, 'preset-a');
  } finally {
    activeNative = null;
  }
});

test('selectAgentPreset skips session-scoped RPC for a non-blank current session', async () => {
  const fake = new FakeNativeDsh();
  fake.queue('host.describe', {});
  fake.queue('session.list', { items: [] });
  fake.queue('credentials.describe', {
    credentials: { DEEPSEEK_API_KEY: { configured: true, writable: false } },
  });
  fake.queue('agentPreset.list', { presets: [] });
  fake.queue('settings.describe', configurationResponse());
  fake.queue('llm.models', { groups: [], failures: [] });
  fake.queue('settings.update', {});
  activeNative = fake;
  try {
    const workspace = await resetWorkspace('select-agent-live');
    await workspace.useDshWorkspace.getState().connect();
    workspace.useDshWorkspace.setState({
      configurationWritable: true,
      activeSessionId: 'session-live',
      sessions: [{ id: 'session-live', updatedAt: 1, status: 'idle', blank: false }],
      agentPresets: [agentPreset('preset-a')],
    });

    await workspace.useDshWorkspace.getState().selectAgentPreset('preset-a');

    assert.equal(fake.calls.at(-1)?.method, 'settings.update');
    assert.equal(fake.calls.some((call) => call.method === 'agentPreset.select'), false);
  } finally {
    activeNative = null;
  }
});

test('selectPermissionPreset updates the default and switches the current session through native RPC', async () => {
  const fake = new FakeNativeDsh();
  fake.queue('host.describe', {});
  fake.queue('session.list', { items: [] });
  fake.queue('credentials.describe', {
    credentials: { DEEPSEEK_API_KEY: { configured: true, writable: false } },
  });
  fake.queue('agentPreset.list', { presets: [] });
  fake.queue('settings.describe', configurationResponse(), permissionSettingsResponse());
  fake.queue('llm.models', { groups: [], failures: [] });
  fake.queue('settings.mutate', {});
  fake.queue('commands/execute', { commandId: 'permission-1', result: { kind: 'success', text: '' } });
  activeNative = fake;
  try {
    const workspace = await resetWorkspace('select-permission');
    await workspace.useDshWorkspace.getState().connect();
    workspace.useDshWorkspace.setState({
      activeSessionId: 'session-permission',
      sessions: [{ id: 'session-permission', updatedAt: 1, status: 'idle', blank: false }],
    });

    await workspace.useDshWorkspace.getState().selectPermissionPreset('workspace-write');

    assert.deepEqual(fake.calls.slice(-3), [
      { method: 'settings.describe', payload: {} },
      {
        method: 'settings.mutate',
        payload: {
          ns: 'permission',
          ops: [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }],
          expectedRevision: 7,
        },
      },
      {
        method: 'commands/execute',
        payload: {
          args: { agentId: 'session-permission', line: '/permission workspace-write' },
        },
      },
    ]);
    const state = workspace.useDshWorkspace.getState();
    assert.equal(state.defaultPermissionPreset, 'workspace-write');
    assert.equal(state.activePermission?.currentValue, 'workspace-write');
  } finally {
    activeNative = null;
  }
});

test('controller exit after connect clears running conversation state', async () => {
  const fake = new FakeNativeDsh();
  fake.queue('host.describe', {});
  fake.queue('session.list', { items: [] });
  fake.queue('credentials.describe', {
    credentials: { DEEPSEEK_API_KEY: { configured: true, writable: false } },
  });
  fake.queue('agentPreset.list', { presets: [] });
  fake.queue('settings.describe', configurationResponse());
  fake.queue('llm.models', { groups: [], failures: [] });
  activeNative = fake;
  try {
    const workspace = await resetWorkspace('controller-exit');
    await workspace.useDshWorkspace.getState().connect();
    workspace.useDshWorkspace.setState({
      activeSessionId: 'session-live',
      sessions: [{ id: 'session-live', updatedAt: 1, status: 'running', blank: false }],
      pendingApproval: {
        rpcId: 'approval-1',
        sessionId: 'session-live',
        approvalId: 'approval-1',
        toolName: 'shell',
      },
      pendingQuestion: {
        rpcId: 'question-1',
        sessionId: 'session-live',
        questions: [{ id: 'q1', question: '继续吗？' }],
      },
      queuedMessages: [{ id: 'queued-1', placement: 'queued', text: '稍后执行' }],
      isRunning: true,
      configurationStatus: 'ready',
    });

    fake.emitExit(0);

    const state = workspace.useDshWorkspace.getState();
    assert.equal(state.status, 'error');
    assert.equal(state.error, 'DSH 进程已退出');
    assert.equal(state.pendingApproval, null);
    assert.equal(state.pendingQuestion, null);
    assert.deepEqual(state.queuedMessages, []);
    assert.equal(state.isRunning, false);
    assert.equal(state.sessions[0]?.status, 'error');
  } finally {
    activeNative = null;
  }
});
