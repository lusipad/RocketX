import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type PostMessagePayload } from './index';

test('GET /healthz 返回 ok', async () => {
  const app = buildApp({
    env: { rcAuthToken: 'token', rcUserId: 'user' },
    postMessage: async () => undefined,
  });

  try {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test('webhook token 不匹配时拒绝', async () => {
  const app = buildApp({
    env: { rcAuthToken: 'token', rcUserId: 'user', webhookToken: 'secret' },
    postMessage: async () => undefined,
  });

  try {
    assert.equal(app.log.info.name, 'noop');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/ado?token=wrong',
      payload: { eventType: 'git.push', message: { text: 'push' } },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'invalid token' });
  } finally {
    await app.close();
  }
});

test('未识别空事件返回 204 且不发消息', async () => {
  const calls: PostMessagePayload[] = [];
  const app = buildApp({
    env: { rcAuthToken: 'token', rcUserId: 'user' },
    postMessage: async (payload) => {
      calls.push(payload);
    },
  });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/ado',
      payload: {},
    });
    assert.equal(res.statusCode, 204);
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('有效事件发送到规范化频道并保留 alias', async () => {
  const calls: PostMessagePayload[] = [];
  const app = buildApp({
    env: {
      rcAuthToken: 'token',
      rcUserId: 'user',
      defaultChannel: 'devops',
      rcAlias: 'Azure DevOps',
    },
    postMessage: async (payload) => {
      calls.push(payload);
    },
  });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/ado?channel=ci',
      payload: {
        eventType: 'build.complete',
        message: { text: '构建完成' },
        detailedMessage: { text: 'Build 123' },
        resource: { result: 'failed' },
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, '#ci');
    assert.equal(calls[0].alias, 'Azure DevOps');
    assert.equal(calls[0].attachments[0]?.color, '#f54a45');
  } finally {
    await app.close();
  }
});
