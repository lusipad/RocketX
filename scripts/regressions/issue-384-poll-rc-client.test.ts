import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RcRestClient,
  type RcUiKitServerInteraction,
  type RcUiKitUserInteraction,
} from '../../packages/rc-client/src/index';

async function readBody(body: BodyInit | null | undefined): Promise<unknown> {
  if (!body) return null;
  if (typeof body === 'string') return JSON.parse(body);
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body));
  if (body instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(new Uint8Array(body)));
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return JSON.parse(await body.text());
  }
  return null;
}

test('commands.list 保留 appId，commands.run 透传 triggerId（issue #384）', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example.test',
    fetchImpl: (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = await readBody(init?.body);
      requests.push({ url, method, body });
      if (url.endsWith('/api/v1/commands.list?count=100')) {
        return new Response(JSON.stringify({
          commands: [
            { command: 'poll', description: 'Create poll', appId: 'poll-app-id' },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const commands = await client.listCommands();
  await client.runCommand('poll', 'GENERAL', '今天吃什么', 'thread-1', 'trigger-1');

  assert.equal(commands[0]?.command, 'poll');
  assert.equal(commands[0]?.appId, 'poll-app-id');
  assert.deepEqual(requests.at(-1), {
    url: 'https://chat.example.test/api/v1/commands.run',
    method: 'POST',
    body: {
      command: 'poll',
      roomId: 'GENERAL',
      params: '今天吃什么',
      tmid: 'thread-1',
      triggerId: 'trigger-1',
    },
  });
});

test('ui interaction 走官方 /apps/ui.interaction/:appId 端点', async () => {
  let request: { url: string; method: string; body: unknown } | null = null;
  const response: RcUiKitServerInteraction = {
    type: 'modal.update',
    triggerId: 'trigger-2',
    appId: 'poll-app-id',
    view: {
      id: 'view-1',
      appId: 'poll-app-id',
      title: { type: 'plain_text', text: 'poll_modal_title', i18n: { key: 'poll_modal_title' } },
      blocks: [],
    },
  };
  const client = new RcRestClient({
    baseUrl: 'https://chat.example.test',
    fetchImpl: (async (input, init) => {
      request = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: await readBody(init?.body),
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });
  const payload: RcUiKitUserInteraction = {
    type: 'viewSubmit',
    triggerId: 'trigger-2',
    viewId: 'view-1',
    payload: {
      view: {
        id: 'view-1',
        appId: 'poll-app-id',
        state: {
          poll: {
            question: '今天吃什么',
            'option-0': '火锅',
            'option-1': '烧烤',
          },
        },
      },
    },
  };

  const result = await client.sendUiKitInteraction('poll-app-id', payload);

  assert.deepEqual(request, {
    url: 'https://chat.example.test/api/v1/apps/ui.interaction/poll-app-id',
    method: 'POST',
    body: payload,
  });
  assert.deepEqual(result, response);
});
