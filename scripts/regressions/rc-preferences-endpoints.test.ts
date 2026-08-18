import assert from 'node:assert/strict';
import test from 'node:test';
import { RcRestClient } from '../../packages/rc-client/src/index';

/**
 * 偏好读写端点适配（live 验证发现，issue #350/#351 跟进修复）：
 * - RC 8.x 的 users.info 不返回 settings.preferences（getFullUserData 字段表没有 settings），
 *   显式偏好必须走 users.getPreferences（只含显式键，老版本也有该端点）；
 * - RC 8.x 的 users.setPreferences 是 schema 校验端点，自定义键被拒——
 *   自定义键写入走 apps/web 侧 savePreferences（DDP 优先），REST 仅作回退。
 */

interface MockReply {
  status?: number;
  body: unknown;
}

function makeClient(handler: (url: string) => MockReply, urls: string[]): RcRestClient {
  return new RcRestClient({
    baseUrl: 'http://rc.test',
    authProvider: () => ({ authToken: 'tok', userId: 'u1' }),
    fetchImpl: (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      const reply = handler(url);
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }) as typeof fetch,
  });
}

test('getExplicitPreferences 主走 users.getPreferences（含自定义键）', async () => {
  const urls: string[] = [];
  const client = makeClient(
    () => ({ body: { success: true, preferences: { rcxAliases: { 'u:zhangsan': '备注' }, sidebarShowUnread: false } } }),
    urls,
  );

  const prefs = await client.getExplicitPreferences();

  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/api\/v1\/users\.getPreferences\?userId=u1$/);
  assert.deepEqual(prefs, { rcxAliases: { 'u:zhangsan': '备注' }, sidebarShowUnread: false });
});

test('getPreferences 不可用时回退 users.info 的 settings.preferences', async () => {
  const urls: string[] = [];
  const client = makeClient((url) => {
    if (url.includes('users.getPreferences')) {
      return { status: 400, body: { success: false, error: 'invalid-params' } };
    }
    return { body: { success: true, user: { settings: { preferences: { unreadAlert: false } } } } };
  }, urls);

  const prefs = await client.getExplicitPreferences();

  assert.deepEqual(
    urls.map((u) => u.split('?')[0].split('/api/v1/')[1]),
    ['users.getPreferences', 'users.info'],
  );
  assert.deepEqual(prefs, { unreadAlert: false });
});

test('未登录时 getExplicitPreferences 直接返回空，不发请求', async () => {
  const urls: string[] = [];
  const client = new RcRestClient({
    baseUrl: 'http://rc.test',
    authProvider: () => null,
    fetchImpl: (async (input: unknown) => {
      urls.push(String(input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.getExplicitPreferences(), {});
  assert.equal(urls.length, 0);
});
