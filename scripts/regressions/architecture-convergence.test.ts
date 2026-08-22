import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capabilityEnabled,
  createRocketChatCapabilities,
} from '../../packages/rc-client/src/capabilities';
import { createRocketChatDomainFacades } from '../../packages/rc-client/src/domains';
import {
  backupLocalData,
  getLocalDataSchema,
  readLocalData,
  restoreLocalData,
  writeLocalData,
} from '../../apps/web/src/lib/localDataContract';
import { createRocketChatRealtimeGateway } from '../../packages/rc-client/src/realtimeGateway';
import { RcRestClient } from '../../packages/rc-client/src/rest';

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  (globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
  return values;
}

test('Rocket.Chat capability snapshot defaults and overrides stay explicit', () => {
  const capabilities = createRocketChatCapabilities({
    serverVersion: '8.6.1',
    source: 'server',
    features: { teams: false },
  });
  assert.equal(capabilityEnabled(capabilities, 'threads'), true);
  assert.equal(capabilityEnabled(capabilities, 'teams'), false);
  assert.equal(capabilities.serverVersion, '8.6.1');
});

test('Rocket.Chat domain facades bind methods without changing the REST contract', async () => {
  const calls: string[] = [];
  const source = {
    marker: 'source',
    getHistory: async function () { calls.push(`${this.marker}:history`); return []; },
    getThreadMessages: async () => [],
    sendMessage: async () => ({ _id: 'm', rid: 'r', msg: 'x', ts: '', u: { _id: 'u', username: 'u' } }),
    sendMessageRaw: async () => ({ _id: 'm', rid: 'r', msg: 'x', ts: '', u: { _id: 'u', username: 'u' } }),
    getMessage: async () => ({ _id: 'm', rid: 'r', msg: 'x', ts: '', u: { _id: 'u', username: 'u' } }),
    getSubscriptions: async () => [],
    getRooms: async () => [],
    getMembers: async () => [],
    getPreferences: async () => ({}),
    getExplicitPreferences: async function () { calls.push(`${this.marker}:preferences`); return {}; },
    setPreferences: async () => {},
    getRoomFiles: async () => [],
    fetchFile: async () => new Blob(),
  };
  const domains = createRocketChatDomainFacades(source);
  await domains.messaging.getHistory('r', 'c');
  await domains.preferences.getExplicitPreferences();
  assert.deepEqual(calls, ['source:history', 'source:preferences']);
});

test('Rocket.Chat realtime gateway follows negotiated endpoint and protocol', () => {
  const gateway = createRocketChatRealtimeGateway(
    'https://chat.example/',
    createRocketChatCapabilities({
      endpoint: { realtimePath: '/ddp' },
      realtime: { ddp: true, websocket: true, protocol: 'ddp-v1' },
    }),
  );
  assert.equal(gateway.websocketUrl(), 'wss://chat.example/ddp');
  assert.equal(gateway.supportsDdp, true);
});

test('Rocket.Chat capability negotiation uses the public info endpoint', async () => {
  const calls: string[] = [];
  const client = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: (async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response(JSON.stringify({ version: '8.6.1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const capabilities = await client.negotiateCapabilities();
  assert.deepEqual(calls, ['GET https://chat.example/api/info']);
  assert.equal(capabilities.source, 'server');
  assert.equal(capabilities.serverVersion, '8.6.1');
});

test('本地数据契约兼容旧数组、写入 version envelope 并在损坏时恢复默认值', () => {
  const storage = installStorage();
  storage.set('calendar', JSON.stringify(['legacy']));
  assert.deepEqual(readLocalData('calendar', 1, [], (value) => Array.isArray(value) ? value as string[] : undefined), ['legacy']);
  writeLocalData('calendar', 1, ['current']);
  assert.deepEqual(JSON.parse(storage.get('calendar') ?? ''), { version: 1, data: ['current'] });
  storage.set('calendar', '{broken');
  assert.deepEqual(readLocalData('calendar', 1, ['fallback'], (value) => Array.isArray(value) ? value as string[] : undefined), ['fallback']);
});

test('本地数据契约拒绝错误版本或账号 scope，避免把别的账号当成本地事实', () => {
  const storage = installStorage();
  writeLocalData('attention', 1, { owner: 'a' }, { scope: 'server\nuser-a' });
  assert.deepEqual(
    readLocalData('attention', 1, { owner: 'fallback' }, (value) =>
      value && typeof value === 'object' && 'owner' in value
        ? value as { owner: string }
        : undefined,
      { scope: 'server\nuser-b' },
    ),
    { owner: 'fallback' },
  );
  assert.deepEqual(
    readLocalData('attention', 2, { owner: 'fallback' }, (value) =>
      value && typeof value === 'object' && 'owner' in value
        ? value as { owner: string }
        : undefined,
      { scope: 'server\nuser-a' },
    ),
    { owner: 'fallback' },
  );
  assert.ok(storage.get('attention'));
});

test('本地数据契约支持迁移、损坏隔离和 dry-run 恢复', () => {
  const storage = installStorage();
  writeLocalData('todo', 1, { title: '旧字段' });
  assert.deepEqual(
    readLocalData(
      'todo',
      2,
      { title: 'fallback', done: false },
      (value) => value && typeof value === 'object' && 'title' in value
        ? value as { title: string; done: boolean }
        : undefined,
      {
        migrations: [{ from: 1, to: 2, migrate: (value) => ({ ...(value as object), done: false }) }],
        persistMigration: true,
      },
    ),
    { title: '旧字段', done: false },
  );
  assert.equal(JSON.parse(storage.get('todo') ?? '').version, 2);

  storage.set('broken', '{not-json');
  assert.deepEqual(readLocalData('broken', 1, ['fallback'], (value) => Array.isArray(value) ? value as string[] : undefined), ['fallback']);
  assert.ok([...storage.keys()].some((key) => key.startsWith('broken#corrupt#')));

  const backup = backupLocalData({ keys: ['todo'], now: () => 123 });
  const dryRun = restoreLocalData(backup, { dryRun: true });
  assert.deepEqual(dryRun.restored, ['todo']);
  assert.deepEqual(dryRun.skipped, []);
  assert.equal(getLocalDataSchema('attention').scope, 'account');
});
