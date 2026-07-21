import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWorkspaceConfig } from '../../apps/web/src/lib/workspaceConfigSource';

test('团队配置 URL 每次先授权 origin 再发起请求', async () => {
  const calls: string[] = [];
  const config = await fetchWorkspaceConfig(' https://git.example.com/raw/rcx.workspace.json ', {
    ensureOrigin: async (url) => {
      calls.push(`allow:${url}`);
      return new URL(url.toString()).origin;
    },
    fetch: (async (url: RequestInfo | URL) => {
      calls.push(`fetch:${url.toString()}`);
      return new Response(JSON.stringify({
        version: 1,
        rocketChat: { url: 'https://chat.example.com' },
      }));
    }) as typeof fetch,
  });
  assert.deepEqual(calls, [
    'allow:https://git.example.com/raw/rcx.workspace.json',
    'fetch:https://git.example.com/raw/rcx.workspace.json',
  ]);
  assert.equal(config.rocketChat?.url, 'https://chat.example.com');
});

test('团队配置 HTTP 失败保留明确状态码', async () => {
  await assert.rejects(
    fetchWorkspaceConfig('https://git.example.com/raw/rcx.workspace.json', {
      ensureOrigin: async () => 'https://git.example.com',
      fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    }),
    /HTTP 503/,
  );
});
