import assert from 'node:assert/strict';
import test from 'node:test';
import { scanAxiomaticDesignMatrix } from '../check-architecture-boundaries.mjs';
import {
  getServerBase,
  onServerBaseChanged,
  setServerBase,
} from '../../apps/web/src/lib/serverEndpoint';
import { AppServerController } from '../../apps/web/src/agent/AppServerController';
import { CODEX_APP_SERVER_VERSION, type CodexTransport } from '../../apps/web/src/agent/protocol';
import {
  registerFocusPresencePort,
  emptyFocusStats,
  useFocus,
} from '../../apps/web/src/stores/focus';
import { registerAcpHostBridge, getAcpHostBridge } from '../../apps/web/src/agent/acp/acpHostBridge';

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

test('MIT 公理设计门禁：全前端零静态运行环、零 Store 环、零已知上三角反向依赖', async () => {
  const report = await scanAxiomaticDesignMatrix();
  assert.deepEqual(report.runtimeStaticCycles, []);
  assert.deepEqual(report.storeCycles, []);
  assert.deepEqual(report.dsmViolations, []);
});

test('DP1 serverEndpoint 可独立读写与广播变更，无需耦合 Rocket.Chat client 实例', () => {
  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  const events: Array<{ url: string; changed: boolean }> = [];
  const off = onServerBaseChanged((url, changed) => events.push({ url, changed }));
  try {
    setServerBase('https://chat.example.com///');
    assert.equal(getServerBase(), 'https://chat.example.com');
    setServerBase('https://chat.example.com');
    assert.deepEqual(events, [
      { url: 'https://chat.example.com', changed: true },
      { url: 'https://chat.example.com', changed: false },
    ]);
  } finally {
    off();
    if (prevStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prevStorage });
  }
});

test('DP9 AppServerController 支持自定义 toolProvider 注入而无需耦合管家宿主工具', async () => {
  const writes: Record<string, unknown>[] = [];
  let handlers: Parameters<CodexTransport['start']>[0];
  const transport: CodexTransport = {
    start: async (next) => {
      handlers = next;
      return {
        processId: 'dsm-tool-test',
        version: CODEX_APP_SERVER_VERSION,
        runtimeSource: 'bundled',
        managedSkillRoots: ['D:/skills'],
      };
    },
    write: async (message) => {
      writes.push(message);
      if (!('id' in message)) return;
      const responses: Record<string, unknown> = {
        initialize: { userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} (Windows)`, codexHome: 'C:/codex', platformFamily: 'windows', platformOs: 'windows' },
        'skills/extraRoots/set': {},
        'model/list': { data: [{ id: 'gpt-test', model: 'gpt-test', isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null },
        'permissionProfile/list': { data: [{ id: ':workspace', allowed: true, description: null }, { id: ':danger-full-access', allowed: true, description: null }], nextCursor: null },
        'skills/list': { data: [{ cwd: 'D:/ws', skills: [], errors: [] }] },
        'app/list': { data: [], nextCursor: null },
        'plugin/list': { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
        'thread/start': { thread: { id: 't-injected' } },
      };
      queueMicrotask(() => handlers.onLine(JSON.stringify({ id: message.id, result: responses[String(message.method)] ?? {} })));
    },
    stop: async () => {},
  };

  let calledWith: unknown = null;
  const controller = new AppServerController({
    transportFactory: () => transport,
    toolProvider: {
      getTools: () => [{
        type: 'function',
        name: 'custom_probe_tool',
        description: 'injected tool',
        inputSchema: { type: 'object', properties: {} },
      }],
      executeTool: async (params) => {
        calledWith = params;
        return { ok: true };
      },
    },
  });

  await controller.connect('s1', 'D:/ws');
  await controller.startThread({ model: 'gpt-test', effort: null, permissionPreset: 'auto' });
  const startReq = writes.find((m) => m.method === 'thread/start') as { params: { dynamicTools: Array<{ name: string }> } };
  assert.deepEqual(startReq.params.dynamicTools.map((tool) => tool.name), ['custom_probe_tool']);

  handlers!.onLine(JSON.stringify({ id: 'call-1', method: 'item/tool/call', params: { tool: 'custom_probe_tool', arguments: {} } }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calledWith, { tool: 'custom_probe_tool', arguments: {} });
  await controller.stop();
});

test('DP4 Focus 通过 FocusPresencePort 反转状态写回，DP9 ACP 通过 AcpHostBridge 反转账本同步', async () => {
  const written: string[] = [];
  const unregisterFocus = registerFocusPresencePort({
    readStatus: () => 'away',
    writeStatus: async (next) => {
      written.push(next);
    },
  });
  useFocus.setState({ session: null, stats: emptyFocusStats(), digest: null });
  try {
    await useFocus.getState().start(15);
    await useFocus.getState().end();
    assert.deepEqual(written, ['busy', 'away']);
  } finally {
    unregisterFocus();
    useFocus.setState({ session: null, stats: emptyFocusStats(), digest: null });
  }

  let syncedTitle = '';
  const restoreAcp = registerAcpHostBridge({
    syncSessionToLedger: async (session) => {
      syncedTitle = session.title;
    },
  });
  try {
    await getAcpHostBridge().syncSessionToLedger({
      agentId: 'codex-acp',
      agentName: 'Codex',
      preset: 'codex-acp',
      autonomyMode: 'confirm',
      title: 'DSM Verified Session',
      workspaceRoot: 'D:/ws',
      status: 'ready',
      turnCount: 0,
    });
    assert.equal(syncedTitle, 'DSM Verified Session');
  } finally {
    restoreAcp();
  }
});
