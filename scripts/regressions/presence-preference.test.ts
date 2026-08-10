import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  loadPresencePreference,
  savePresencePreference,
  startupPresence,
} from '../../apps/web/src/lib/presencePreference';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('没有显式状态偏好时，应用启动默认在线', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });

  assert.equal(startupPresence('https://chat.example', 'u1'), 'online');
});

test('只恢复用户显式选择的状态，并按服务器和账号隔离', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });

  savePresencePreference('HTTPS://CHAT.EXAMPLE/', 'u1', 'offline');
  assert.equal(loadPresencePreference('https://chat.example', 'u1'), 'offline');
  assert.equal(startupPresence('https://chat.example', 'u2'), 'online');
  assert.equal(startupPresence('https://other.example', 'u1'), 'online');
});

test('登录恢复和密码登录都应用启动状态，设置页只在更新成功后记录偏好', async () => {
  const [auth, settings] = await Promise.all([
    readFile(new URL('../../apps/web/src/stores/auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/src/pages/SettingsPage.tsx', import.meta.url), 'utf8'),
  ]);

  assert.equal(auth.match(/applyStartupPresence\(data\.me, data\.userId\)/g)?.length, 2);
  assert.match(auth, /startupPresence\(getServerBase\(\), userId\)/);
  assert.match(settings, /await rest\.setStatus\(next, text\);[\s\S]*savePresencePreference/);
});
