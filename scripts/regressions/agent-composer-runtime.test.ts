import assert from 'node:assert/strict';
import test from 'node:test';
import { AppServerController } from '../../apps/web/src/agent/AppServerController';
import { CODEX_APP_SERVER_VERSION, type CodexTransport } from '../../apps/web/src/agent/protocol';

test('an explicit turn workspace stays attached to its original thread after the controller switches', async () => {
  let handlers: Parameters<CodexTransport['start']>[0];
  const writes: Record<string, any>[] = [];
  const model = {
    id: 'test', model: 'test', isDefault: true,
    supportedReasoningEfforts: [], defaultReasoningEffort: null,
  };
  const transport: CodexTransport = {
    start: async (next) => {
      handlers = next;
      return { processId: 'composer-runtime', version: CODEX_APP_SERVER_VERSION, runtimeSource: 'bundled', managedSkillRoots: ['D:/skills'] };
    },
    write: async (message) => {
      writes.push(message);
      if (!('id' in message)) return;
      const responses: Record<string, unknown> = {
        initialize: { userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} (Windows)`, codexHome: 'C:/codex', platformFamily: 'windows', platformOs: 'windows' },
        'skills/extraRoots/set': {},
        'model/list': { data: [model], nextCursor: null },
        'permissionProfile/list': { data: [{ id: ':workspace', allowed: true, description: null }, { id: ':danger-full-access', allowed: true, description: null }], nextCursor: null },
        'skills/list': { data: [{ cwd: 'D:/original', skills: [], errors: [] }] },
        'app/list': { data: [], nextCursor: null },
        'plugin/list': { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
        'turn/start': { turn: { id: 'turn' } },
      };
      queueMicrotask(() => handlers.onLine(JSON.stringify({ id: message.id, result: responses[String(message.method)] ?? {} })));
    },
    stop: async () => {},
  };
  const controller = new AppServerController({ transportFactory: () => transport });
  await controller.connect('runtime', 'D:/original');
  controller.switchWorkspaceRoot('D:/other-project');
  await controller.startTurn('original-thread', [{ type: 'text', text: '原工作继续', text_elements: [] }], {
    model: 'test', effort: null, permissionPreset: 'auto',
  }, { workspaceRoot: 'D:/original', runtimeWorkspaceRoots: ['D:/attachments'] });
  const params = writes.find((message) => message.method === 'turn/start')?.params;
  assert.equal(params.cwd, 'D:/original');
  assert.deepEqual(params.runtimeWorkspaceRoots, ['D:/original', 'D:/attachments']);
  assert.equal(controller.currentWorkspaceRoot, 'D:/other-project');
  await controller.stop();
});
