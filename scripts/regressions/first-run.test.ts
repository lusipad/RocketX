import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIRST_RUN_STORAGE_KEY,
  completeFirstRun,
  loadFirstRunState,
  resetFirstRun,
  shouldShowFirstRun,
} from '../../apps/web/src/lib/firstRun';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('首次启动只拦截没有服务器与团队来源的桌面新安装', () => {
  assert.equal(
    shouldShowFirstRun({ desktop: true, serverUrl: '', hasWorkspaceSource: false, state: null }),
    true,
  );
  assert.equal(
    shouldShowFirstRun({ desktop: false, serverUrl: '', hasWorkspaceSource: false, state: null }),
    false,
  );
  assert.equal(
    shouldShowFirstRun({ desktop: true, serverUrl: 'https://chat.example.com', hasWorkspaceSource: false, state: null }),
    false,
  );
  assert.equal(
    shouldShowFirstRun({ desktop: true, serverUrl: '', hasWorkspaceSource: true, state: null }),
    false,
  );
});

test('显式重放优先于已有配置，完成后不再打断登录', () => {
  const storage = new MemoryStorage();
  resetFirstRun(storage);
  assert.equal(loadFirstRunState(storage), 'pending');
  assert.equal(
    shouldShowFirstRun({ desktop: true, serverUrl: 'https://chat.example.com', hasWorkspaceSource: true, state: loadFirstRunState(storage) }),
    true,
  );

  completeFirstRun(storage);
  assert.equal(storage.getItem(FIRST_RUN_STORAGE_KEY), 'complete');
  assert.equal(
    shouldShowFirstRun({ desktop: true, serverUrl: '', hasWorkspaceSource: false, state: loadFirstRunState(storage) }),
    false,
  );
});

test('损坏的首次启动状态按未设置处理', () => {
  const storage = new MemoryStorage();
  storage.setItem(FIRST_RUN_STORAGE_KEY, 'broken');
  assert.equal(loadFirstRunState(storage), null);
});
