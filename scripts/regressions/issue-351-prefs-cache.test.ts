import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { rest } from '../../apps/web/src/lib/client';
import { ensureAccountScope } from '../../apps/web/src/lib/accountScope';
import { loadPrefsCache, mergePrefsCache, PREFS_CACHE_KEY } from '../../apps/web/src/lib/prefsCache';
import { usePrefs } from '../../apps/web/src/stores/prefs';

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

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return storage;
}

function resetPrefsStore(): void {
  usePrefs.setState({ loaded: false, error: null });
}

test('update 成功后把 patch 追加写入本地镜像；写失败不落镜像', async () => {
  installStorage();
  resetPrefsStore();

  const original = rest.setPreferences.bind(rest);
  try {
    (rest as { setPreferences: unknown }).setPreferences = async () => {};
    await usePrefs.getState().update({ unreadAlert: false });
    assert.equal(loadPrefsCache().unreadAlert, false);

    // 再次更新别的键：同键覆盖、未动的键保留
    await usePrefs.getState().update({ unreadAlert: true, desktopNotifications: 'none' });
    assert.deepEqual(loadPrefsCache(), { unreadAlert: true, desktopNotifications: 'none' });
    assert.equal(usePrefs.getState().prefs.unreadAlert, true);

    // 服务端写失败：回滚界面状态，且不污染镜像
    (rest as { setPreferences: unknown }).setPreferences = async () => {
      throw new Error('network down');
    };
    await usePrefs.getState().update({ unreadAlert: false });
    assert.equal(usePrefs.getState().prefs.unreadAlert, true);
    assert.equal(loadPrefsCache().unreadAlert, true);
  } finally {
    (rest as { setPreferences: unknown }).setPreferences = original;
  }
});

test('load 合并顺序：DEFAULTS ← 本地镜像 ← 服务端显式值（服务端优先）', async () => {
  installStorage();
  resetPrefsStore();
  mergePrefsCache({ unreadAlert: false, desktopNotifications: 'none' });

  const original = rest.getExplicitPreferences.bind(rest);
  try {
    (rest as { getExplicitPreferences: unknown }).getExplicitPreferences = async () => ({
      unreadAlert: true, // 服务端显式值覆盖镜像
    });
    await usePrefs.getState().load();

    const { prefs, loaded, error } = usePrefs.getState();
    assert.equal(loaded, true);
    assert.equal(error, null);
    assert.equal(prefs.unreadAlert, true, '服务端显式值优先于镜像');
    assert.equal(prefs.desktopNotifications, 'none', '服务端没有的键用镜像兜底');
    assert.equal(prefs.sendOnEnter, 'normal', '镜像和服务端都没有的键用默认值');
  } finally {
    (rest as { getExplicitPreferences: unknown }).getExplicitPreferences = original;
  }
});

test('服务端拉取失败时用本地镜像兜底而不是裸默认值', async () => {
  installStorage();
  resetPrefsStore();
  mergePrefsCache({ desktopNotifications: 'mentions', unreadAlert: false });

  const original = rest.getExplicitPreferences.bind(rest);
  try {
    (rest as { getExplicitPreferences: unknown }).getExplicitPreferences = async () => {
      throw new Error('502 Bad Gateway');
    };
    await usePrefs.getState().load();

    const { prefs, loaded, error } = usePrefs.getState();
    assert.equal(loaded, false, '加载失败仍允许设置页重试');
    assert.ok(error, '失败原因要可见');
    assert.equal(prefs.desktopNotifications, 'mentions');
    assert.equal(prefs.unreadAlert, false);
    assert.equal(prefs.sendOnEnter, 'normal', '镜像没有的键回退默认值');
  } finally {
    (rest as { getExplicitPreferences: unknown }).getExplicitPreferences = original;
  }
});

test('镜像损坏或存储不可用时按空镜像处理', () => {
  const storage = installStorage();
  storage.setItem(PREFS_CACHE_KEY, '{broken json');
  assert.deepEqual(loadPrefsCache(), {});
  storage.setItem(PREFS_CACHE_KEY, '[1,2]');
  assert.deepEqual(loadPrefsCache(), {});
});

test('镜像纳入 SCOPED_KEYS：换账号时归档/还原，不串账号', () => {
  const storage = installStorage();

  // 账号 A 登录（首次认领），写下自己的镜像
  assert.equal(ensureAccountScope('user-a'), 'ok');
  mergePrefsCache({ unreadAlert: false });

  // 换成账号 B：A 的镜像被归档，B 看到的是干净状态
  assert.equal(ensureAccountScope('user-b'), 'switched');
  assert.equal(storage.getItem(PREFS_CACHE_KEY), null);
  assert.deepEqual(loadPrefsCache(), {});
  assert.ok(storage.getItem(`${PREFS_CACHE_KEY}#user-a@same-origin`), 'A 的镜像已按账号归档');

  // B 写自己的镜像后再换回 A：A 的镜像原样搬回
  mergePrefsCache({ desktopNotifications: 'none' });
  assert.equal(ensureAccountScope('user-a'), 'switched');
  assert.deepEqual(loadPrefsCache(), { unreadAlert: false });
  assert.ok(storage.getItem(`${PREFS_CACHE_KEY}#user-b@same-origin`), 'B 的镜像已归档');
});

test('prefs 镜像 key 常量与 accountScope 清单保持一致', async () => {
  const scope = await readFile(new URL('../../apps/web/src/lib/accountScope.ts', import.meta.url), 'utf8');
  assert.ok(scope.includes(`'${PREFS_CACHE_KEY}'`), 'SCOPED_KEYS 必须包含 rcx-prefs-cache');
});
