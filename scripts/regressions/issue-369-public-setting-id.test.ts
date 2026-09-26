import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureSiteUrl,
  getPublicSetting,
  readPublicSettingResult,
  setServerBase,
} from '../../apps/web/src/lib/client';

/**
 * issue #369（真正的单边降级来源）：`settings.public?_id=X` 在 Rocket.Chat 6.x 上
 * **忽略 `_id` 过滤**，返回一整页（默认 50 条）按字母序排列的设置，首条是
 * `API_Apply_permission_view-outside-room_on_users-list`。
 *
 * 旧实现取 `settings[0].value`，于是 `uniqueID` 读出 `false`、`Site_Url` 读出别人的
 * 值：LAN 指纹退回接入 URL 归一化 → 两台设备一边用 IP 一边用主机名就永远发现不了
 * 对方（issue #369 的症状），而日志上看不出跟指纹不匹配的区别。
 *
 * 这里用真机上抓到的响应形状（RC 6.0：`count=50 total=359`，首条是 `API_*`，
 * `uniqueID` 不在第一页）把这个缺陷钉死。
 */
const originalFetch = globalThis.fetch;

/** 老服务端：忽略 `_id`，按页返回；`count=0` 才给全量。 */
function stubLegacyFetch(all: { _id: string; value: unknown }[]): () => number {
  let calls = 0;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    calls += 1;
    const url = String(input);
    const wantsAll = url.includes('count=0');
    const count = Number(new URL(url).searchParams.get('count') ?? 50);
    const settings = wantsAll || count === 0 ? all : all.slice(0, 50);
    return new Response(JSON.stringify({ settings, count: settings.length, total: all.length, success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => calls;
}

// Node 里没有可用的 localStorage（测试宿主只提供半成品），而 `getServerBase()`
// 要从它读服务端地址。
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
};

function stubFetch(payload: unknown, ok = true): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  // 走一次「换服务器」把 `setServerBase` 内部的缓存清理路径跑到，再复位。
  setServerBase('http://reset.invalid');
  setServerBase('');
  store.clear();
});

test('老服务端忽略 _id 过滤时，仍然取到我们要的那个设置值（issue #369）', async () => {
  setServerBase('http://chat.corp:3300');
  // uniqueID 按字母序排在 359 条设置的末尾，第一页 50 条里没有。
  const all = [
    { _id: 'API_Apply_permission_view-outside-room_on_users-list', value: false },
    { _id: 'API_Embed', value: true },
    ...Array.from({ length: 60 }, (_, index) => ({ _id: `Filler_${index}`, value: index })),
    { _id: 'uniqueID', value: '2cfa8f73-0198-4d12-99d0-9cbdd50f21dc' },
  ];
  const calls = stubLegacyFetch(all);

  // 旧实现返回首条的 `false`（把唯一 ID 变成布尔值）；只按 _id 匹配则返回 undefined。
  assert.equal(await getPublicSetting('uniqueID'), '2cfa8f73-0198-4d12-99d0-9cbdd50f21dc');
  // 服务端没给这个设置时必须返回 undefined（调用方据此退回旧算法），
  // 而不是把首条那个无关设置的值当成答案。
  assert.equal(await getPublicSetting('Message_Read_Receipt_Enabled'), undefined);
  assert.equal(calls(), 2, '老服务端先试一次按页查询、再拉一次全量；第二个设置直接从全量结果里取');
});

test('读到的设置会被缓存，限流时不再重复打服务端（issue #369）', async () => {
  setServerBase('http://chat.corp:3300');
  const calls = stubLegacyFetch([{ _id: 'uniqueID', value: 'cached-id' }]);

  assert.equal(await getPublicSetting('uniqueID'), 'cached-id');
  const afterFirst = calls();
  assert.equal(await getPublicSetting('uniqueID'), 'cached-id');
  assert.equal(calls(), afterFirst, '第二次读取必须命中本地缓存');
});

/** Rocket.Chat 限流时的真实形状：429 + JSON 错误体（不是网络异常）。 */
function rateLimited(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: 'Error, too many requests. Please slow down. [error-too-many-requests]',
    }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );
}

test('读取失败不写缓存，下次仍会重试', async () => {
  setServerBase('http://chat.corp:3300');
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return rateLimited();
  }) as typeof fetch;

  assert.equal(await getPublicSetting('uniqueID'), undefined);
  const afterFailure = calls;
  assert.equal(await getPublicSetting('uniqueID'), undefined);
  assert.ok(calls > afterFailure, '失败结果不进缓存，下次仍会重新请求');
});

test('429 的 JSON 错误体是「失败」而不是「没有这个设置」，退避后重试能拿到值（issue #369）', async () => {
  // 旧实现：httpFetch 不对非 2xx 抛错，429 的 JSON 被当成「没找到」，30ms 内返回
  // undefined，指纹当次静默退回接入 URL——正是 #369 的单边降级。
  setServerBase('http://chat.corp:3300');
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) return rateLimited();
    return new Response(
      JSON.stringify({ settings: [{ _id: 'uniqueID', value: 'after-backoff' }], success: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const startedAt = Date.now();
  assert.equal(await getPublicSetting('uniqueID'), 'after-backoff');
  assert.equal(calls, 2, '限流后只退避重试一次按页查询，不该把 429 当成老服务端去拉全量');
  assert.ok(Date.now() - startedAt >= 500, '重试前必须真的退避');
});

test('区分「失败」与「服务端没有这个设置」：LAN 指纹只在后者才允许退回 URL（issue #369）', async () => {
  setServerBase('http://chat.corp:3300');
  globalThis.fetch = (async () => rateLimited()) as typeof fetch;
  assert.deepEqual(await readPublicSettingResult('uniqueID'), { status: 'failed' });

  setServerBase('http://new.corp:3300');
  // 新服务端尊重 `_id` 过滤：没有这个设置时返回空列表，不必再拉全量。
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ settings: [], count: 0, total: 0, success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  assert.deepEqual(await readPublicSettingResult('uniqueID'), { status: 'missing' });
  assert.equal(calls, 1, '空列表说明服务端已按 _id 过滤，不该再发 count=0 的重查询');
});

test('同一设置的并发读取只发一次请求（启动时 init 与 LAN 各读一次 Site_Url）', async () => {
  setServerBase('http://chat.corp:3300');
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(
      JSON.stringify({ settings: [{ _id: 'Site_Url', value: 'http://chat.corp:3300/' }], success: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const [first, second] = await Promise.all([ensureSiteUrl(), getPublicSetting('Site_Url')]);
  assert.equal(first, 'http://chat.corp:3300');
  assert.equal(second, 'http://chat.corp:3300/');
  assert.equal(calls, 1);
});

test('老服务端的全量设置只拉一次，之后的设置直接从同一份结果里取', async () => {
  setServerBase('http://chat.corp:3300');
  const all = [
    { _id: 'API_Embed', value: true },
    ...Array.from({ length: 60 }, (_, index) => ({ _id: `Filler_${index}`, value: index })),
    { _id: 'Discussion_enabled', value: true },
    { _id: 'Site_Url', value: 'http://chat.corp:3300/' },
    { _id: 'uniqueID', value: 'legacy-id' },
  ];
  const calls = stubLegacyFetch(all);

  assert.equal(await getPublicSetting('uniqueID'), 'legacy-id');
  assert.equal(await getPublicSetting('Discussion_enabled'), true);
  assert.equal(await getPublicSetting('Message_Read_Receipt_Enabled'), undefined);
  assert.equal(await ensureSiteUrl(), 'http://chat.corp:3300');
  assert.equal(calls(), 2, '一次按页查询发现是老服务端，一次全量；其余都从全量结果里取');
});

test('Site_Url 不再取到无关设置的值（issue #369 连带缺陷）', async () => {
  setServerBase('http://chat.corp:3300');
  stubLegacyFetch([
    { _id: 'API_Embed', value: true },
    { _id: 'Site_Url', value: 'http://chat.corp:3300/' },
  ]);

  // 旧实现拿到首条的 `true`（非字符串）→ 缓存为空 → 引用链接前缀退回接入地址。
  assert.equal(await ensureSiteUrl(), 'http://chat.corp:3300');
});

test('新服务端只返回一条时不多发第二次请求', async () => {
  setServerBase('http://chat.corp:3300');
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        settings: [{ _id: 'uniqueID', value: 'single-value' }],
        count: 1,
        total: 1,
        success: true,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  assert.equal(await getPublicSetting('uniqueID'), 'single-value');
  assert.equal(calls, 1);
});

test('请求失败时返回 undefined，而不是抛错或猜一个值', async () => {
  setServerBase('http://chat.corp:3300');
  stubFetch({ status: 'error' }, false);

  assert.equal(await getPublicSetting('uniqueID'), undefined);
});
