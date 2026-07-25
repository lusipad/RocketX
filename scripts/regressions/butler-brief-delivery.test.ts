import assert from 'node:assert/strict';
import test from 'node:test';
import {
  briefDeliverySettings,
  deliverButlerBrief,
  renderBriefMessage,
  setBriefDeliveryEnabled,
  type ButlerBriefDeliveryClient,
  type ButlerBriefDeliveryStorage,
} from '../../apps/web/src/lib/butlerBriefDelivery';
import type { StoredRoundsResult } from '../../apps/web/src/lib/butlerRoundsRunner';
import { getServerBase, setServerBase } from '../../apps/web/src/lib/client';
import { useAuth } from '../../apps/web/src/stores/auth';

const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const shimEntries = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => shimEntries.get(key) ?? null,
    setItem: (key: string, value: string) => shimEntries.set(key, String(value)),
    removeItem: (key: string) => shimEntries.delete(key),
  },
});
class MemoryStorage implements ButlerBriefDeliveryStorage {
  readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

function fakeClient(): ButlerBriefDeliveryClient & {
  calls: Array<{ method: string; arg: string; msg?: string }>;
} {
  const calls: Array<{ method: string; arg: string; msg?: string }> = [];
  return {
    calls,
    createDirectMessage: async (usernames) => {
      calls.push({ method: 'createDirectMessage', arg: usernames });
      return { _id: `dm-${usernames}` };
    },
    sendMessage: async (rid, msg) => {
      calls.push({ method: 'sendMessage', arg: rid, msg });
      return {};
    },
  };
}

function storedBrief(overrides: Partial<StoredRoundsResult> = {}): StoredRoundsResult {
  return {
    result: {
      headline: '今天先盯住发布',
      summary: '一项承诺今天到期。',
      items: [
        { ref: 'ledger:t1', why: '今天到期，漏掉会影响发布', suggestedAction: '上午十点前确认交付状态' },
        { ref: 'wi:42', why: '刚被指派' },
      ],
      proposals: [],
      suppressed: [],
    },
    generatedAt: '2026-07-26T01:00:00.000Z',
    checkedCount: 5,
    refTitles: { 'ledger:t1': '提交发布说明', 'wi:42': '#42 处理发布异常' },
    ...overrides,
  };
}

function login(userId: string, username: string): void {
  useAuth.setState({ user: { _id: userId, username } as never });
}

const initialServerBase = getServerBase();
test.after(() => {
  // 先趁 shim 还在恢复 serverBase，再还原 localStorage
  setServerBase(initialServerBase);
  useAuth.setState({ user: undefined as never });
  if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

test('简报正文：标题加粗、ref 替换成人话标题、snoozed 条目不出现', () => {
  const message = renderBriefMessage(storedBrief({ snoozedRefs: ['wi:42'] }));
  assert.match(message, /^\*今天先盯住发布\*/);
  assert.match(message, /一项承诺今天到期。/);
  assert.match(message, /\*提交发布说明\*：今天到期，漏掉会影响发布 → 上午十点前确认交付状态/);
  assert.doesNotMatch(message, /#42 处理发布异常/);
  assert.doesNotMatch(message, /wi:42|ledger:t1/);
  assert.match(message, /_RocketX 管家 · \d{4}-\d{2}-\d{2}_/);
});

test('自动投递尊重开关与当天去重；开启后发进和自己的私聊', async () => {
  setServerBase('https://chat.example');
  login('brief-user', 'alice');
  const storage = new MemoryStorage();
  const client = fakeClient();
  const now = new Date(2026, 6, 26, 9, 0);

  // 默认关闭：不发
  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client, now }), false);
  assert.equal(client.calls.length, 0);

  setBriefDeliveryEnabled(true, storage);
  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client, now }), true);
  assert.deepEqual(client.calls.map((call) => call.method), ['createDirectMessage', 'sendMessage']);
  assert.equal(client.calls[0]?.arg, 'alice');
  assert.equal(client.calls[1]?.arg, 'dm-alice');
  assert.match(client.calls[1]?.msg ?? '', /今天先盯住发布/);

  // 同一天第二轮：跳过
  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client, now }), false);
  assert.equal(client.calls.length, 2);

  // 第二天：再发
  const tomorrow = new Date(2026, 6, 27, 9, 0);
  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client, now: tomorrow }), true);
  assert.equal(client.calls.length, 4);
});

test('手动投递无视开关与当天限制', async () => {
  setServerBase('https://chat.example');
  login('brief-manual-user', 'bob');
  const storage = new MemoryStorage();
  const client = fakeClient();
  const now = new Date(2026, 6, 26, 9, 0);

  // 开关关着也能手动发
  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client, now, manual: true }), true);
  // 当天再手动发一次也行
  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client, now, manual: true }), true);
  assert.equal(client.calls.filter((call) => call.method === 'sendMessage').length, 2);
});

test('投递记录按 server+account 隔离，换账号不互相吞投递', async () => {
  setServerBase('https://chat.example');
  const storage = new MemoryStorage();
  const client = fakeClient();
  const now = new Date(2026, 6, 26, 9, 0);

  login('user-a', 'alice');
  setBriefDeliveryEnabled(true, storage);
  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client, now }), true);

  // 换账号：开关是各自的，b 没开过 → 不发
  login('user-b', 'bob');
  assert.equal(briefDeliverySettings(storage).enabled, false);
  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client, now }), false);

  // b 开启后发 b 自己的私聊，且不受 a 的当天记录影响
  setBriefDeliveryEnabled(true, storage);
  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client, now }), true);
  assert.equal(client.calls.at(-2)?.arg, 'bob');
});

test('未登录：自动静默跳过，手动给出明确错误', async () => {
  setServerBase('https://chat.example');
  useAuth.setState({ user: undefined as never });
  const storage = new MemoryStorage();
  const client = fakeClient();

  assert.equal(await deliverButlerBrief(storedBrief(), { storage, client }), false);
  await assert.rejects(
    () => deliverButlerBrief(storedBrief(), { storage, client, manual: true }),
    /还没登录/,
  );
  assert.equal(client.calls.length, 0);
});
