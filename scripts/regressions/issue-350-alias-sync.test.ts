import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { RcPreferences } from '../../packages/rc-client/src/index';
import { rest, realtime } from '../../apps/web/src/lib/client';
import { useAliases, type NameFormat } from '../../apps/web/src/stores/aliases';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

type AliasMap = Record<string, string>;

const originalGetExplicitPreferences = rest.getExplicitPreferences;
const originalSetPreferences = rest.setPreferences;
const originalRealtimeCall = realtime.call;
const storage = new MemoryStorage();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

/** 记录 sync/写回期间发往服务端的 preferences */
let writes: Partial<RcPreferences>[] = [];

function reset(aliases: AliasMap = {}, nameFormat: NameFormat = 'alias') {
  useAliases.setState({ aliases, nameFormat });
  storage.removeItem('rcx-aliases');
  storage.removeItem('rcx-name-format');
  writes = [];
}

test.afterEach(() => {
  rest.getExplicitPreferences = originalGetExplicitPreferences;
  rest.setPreferences = originalSetPreferences;
  (realtime as { call: unknown }).call = originalRealtimeCall;
  realtime.status = 'idle';
  reset();
});

test('登录合并：服务端备注优先，本地独有的键保留并写回本机缓存', async () => {
  reset({ 'u:zhangsan': '本机备注', 'u:lisi': '只在本机' });
  rest.getExplicitPreferences = async () => ({
    rcxAliases: { 'u:zhangsan': '服务端备注' },
    rcxNameFormat: 'aliasWithReal',
  });
  rest.setPreferences = async (data) => {
    writes.push(data);
  };

  await useAliases.getState().sync();

  assert.deepEqual(useAliases.getState().aliases, {
    'u:zhangsan': '服务端备注',
    'u:lisi': '只在本机',
  });
  assert.equal(useAliases.getState().nameFormat, 'aliasWithReal');
  assert.equal(
    storage.getItem('rcx-aliases'),
    JSON.stringify({ 'u:zhangsan': '服务端备注', 'u:lisi': '只在本机' }),
  );
  assert.equal(storage.getItem('rcx-name-format'), 'aliasWithReal');
  // 服务端已有数据，同步过程不应再写回
  assert.equal(writes.length, 0);
});

test('备注与显示格式的修改在本地生效之外乐观写回服务端', async () => {
  reset();
  rest.setPreferences = async (data) => {
    writes.push(data);
  };

  useAliases.getState().setUserAlias('zhangsan', '张三');
  assert.deepEqual(writes.at(-1), { rcxAliases: { 'u:zhangsan': '张三' } });
  assert.equal(storage.getItem('rcx-aliases'), JSON.stringify({ 'u:zhangsan': '张三' }));

  useAliases.getState().setRoomAlias('room-1', '值班群');
  assert.deepEqual(writes.at(-1), {
    rcxAliases: { 'u:zhangsan': '张三', 'r:room-1': '值班群' },
  });

  useAliases.getState().setNameFormat('aliasWithReal');
  assert.deepEqual(writes.at(-1), { rcxNameFormat: 'aliasWithReal' });
  assert.equal(storage.getItem('rcx-name-format'), 'aliasWithReal');
});

test('写回失败不回滚本地，下次登录以服务端为准', async () => {
  reset();
  rest.setPreferences = async () => {
    throw new Error('离线');
  };

  useAliases.getState().setUserAlias('wangwu', '王五');
  // 等 fire-and-forget 的 .catch 落定
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(useAliases.getState().aliases, { 'u:wangwu': '王五' });
  assert.equal(storage.getItem('rcx-aliases'), JSON.stringify({ 'u:wangwu': '王五' }));
});

test('首次登录迁移：服务端为空时把本机备注与格式上传，而不是被空值覆盖', async () => {
  reset({ 'u:zhangsan': '本机备注' }, 'aliasWithReal');
  rest.getExplicitPreferences = async () => ({ rcxAliases: {} });
  rest.setPreferences = async (data) => {
    writes.push(data);
  };

  await useAliases.getState().sync();

  assert.deepEqual(writes, [
    { rcxAliases: { 'u:zhangsan': '本机备注' }, rcxNameFormat: 'aliasWithReal' },
  ]);
  // 本地数据原样保留
  assert.deepEqual(useAliases.getState().aliases, { 'u:zhangsan': '本机备注' });
  assert.equal(useAliases.getState().nameFormat, 'aliasWithReal');
});

test('服务端与本机都没有备注时，同步不发起写回', async () => {
  reset();
  rest.getExplicitPreferences = async () => ({});
  rest.setPreferences = async (data) => {
    writes.push(data);
  };

  await useAliases.getState().sync();

  assert.equal(writes.length, 0);
  assert.deepEqual(useAliases.getState().aliases, {});
});

test('同步失败（未登录/断网）时保留本机缓存，不阻塞使用', async () => {
  reset({ 'u:zhangsan': '本机备注' });
  rest.getExplicitPreferences = async () => {
    throw new Error('未登录');
  };

  await useAliases.getState().sync();

  assert.deepEqual(useAliases.getState().aliases, { 'u:zhangsan': '本机备注' });
});

test('登录/resume 成功后触发备注同步，且 rcx-aliases 仍在账号隔离清单内', async () => {
  const [auth, accountScope] = await Promise.all([
    readFile(new URL('../../apps/web/src/stores/auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/lib/accountScope.ts', import.meta.url), 'utf8'),
  ]);

  // login 与 resume 两条路径都要同步
  assert.equal(auth.match(/useAliases\.getState\(\)\.sync\(\)/g)?.length, 2);
  // 账号隔离：换账号时本机缓存照样归档/还原，不能被服务端同步绕过
  assert.match(accountScope, /'rcx-aliases'/);
});

test('没有保存过显示格式时默认显示备注名和原名', async () => {
  const aliases = await readFile(new URL('../../apps/web/src/stores/aliases.ts', import.meta.url), 'utf8');
  assert.match(aliases, /localStorage\.getItem\(FORMAT_KEY\) === 'alias' \? 'alias' : 'aliasWithReal'/);
  assert.match(aliases, /catch \{\s*return 'aliasWithReal';/);
});

// ---- 写通道：DDP 优先（issue #350 live 验证发现 RC 8.x REST 端点拒绝自定义键）----

test('实时连接就绪时写回走 DDP saveUserPreferences，自定义键不经 REST schema 校验', async () => {
  reset();
  const ddpWrites: unknown[][] = [];
  let restWrites = 0;
  realtime.status = 'connected';
  (realtime as { call: unknown }).call = async (method: string, ...params: unknown[]) => {
    ddpWrites.push([method, ...params]);
    return true;
  };
  rest.setPreferences = async () => {
    restWrites += 1;
  };

  useAliases.getState().setUserAlias('zhangsan', '张三');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ddpWrites, [
    ['saveUserPreferences', { rcxAliases: { 'u:zhangsan': '张三' } }],
  ]);
  assert.equal(restWrites, 0, 'DDP 可用时不应落 REST');
});

test('DDP 写失败（方法不存在/连接断开）时回退 REST 写回', async () => {
  reset();
  realtime.status = 'connected';
  (realtime as { call: unknown }).call = async () => {
    throw new Error('Method not found');
  };
  rest.setPreferences = async (data) => {
    writes.push(data);
  };

  useAliases.getState().setUserAlias('zhangsan', '张三');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(writes, [{ rcxAliases: { 'u:zhangsan': '张三' } }]);
});

test('实时连接未就绪时直接走 REST，不干等 DDP 超时', async () => {
  reset();
  let ddpCalls = 0;
  (realtime as { call: unknown }).call = async () => {
    ddpCalls += 1;
    return true;
  };
  rest.setPreferences = async (data) => {
    writes.push(data);
  };
  // status 保持默认 idle

  useAliases.getState().setUserAlias('zhangsan', '张三');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ddpCalls, 0);
  assert.deepEqual(writes, [{ rcxAliases: { 'u:zhangsan': '张三' } }]);
});
