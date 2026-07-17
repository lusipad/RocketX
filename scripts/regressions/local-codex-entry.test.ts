import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { useLocalCodex } from '../../apps/web/src/stores/localCodex';

test('Codex 本地设置按账号保存，但不把对话和过程写入 localStorage', () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  useLocalCodex.setState({ scope: '', messages: [], traces: [] });
  useLocalCodex.getState().hydrate('https://chat.example:user-1');
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

test('Codex 入口固定使用隔离工作区和审批安全检查', async () => {
  const source = await readFile(new URL('../../apps/web/src/stores/localCodex.ts', import.meta.url), 'utf8');
  assert.match(source, /const RUNNER_WORKSPACE = '\/workspace'/);
  assert.match(source, /new TauriCodexTransport\(state\.sessionId!, state\.workspaceRoot\)/);
  assert.match(source, /runtimeWorkspaceRoots: \[RUNNER_WORKSPACE\]/);
  assert.match(source, /validateApprovalPaths\(params, \[RUNNER_WORKSPACE\]\)/);
  assert.match(source, /commandRequestMentionsSensitivePath\(params\.command\)/);
  assert.match(source, /validatePermissionRequest\(/);
});
