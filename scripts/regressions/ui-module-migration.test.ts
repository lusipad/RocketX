import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORK_ITEM_STATE_FILTER,
  migratePersistedModule,
  readPersistedModule,
  readPersistedWorkbenchTab,
  readPersistedWorkItemStateFilter,
  UI_MODULE_STORAGE_KEY,
  useUI,
} from '../../apps/web/src/stores/ui';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('退役的 today / ai-assistant / codex 持久化值不再迁移到新页面，统一回到安全默认模块', () => {
  assert.equal(migratePersistedModule('today'), 'messages');
  assert.equal(migratePersistedModule('ai-assistant'), 'messages');
  assert.equal(migratePersistedModule('codex'), 'messages');
  assert.equal(migratePersistedModule('butler-view'), 'butler-view');
  assert.equal(migratePersistedModule('contributions'), 'workbench');
  assert.equal(migratePersistedModule('downloads'), 'downloads');
  assert.equal(migratePersistedModule('unknown'), 'messages');

  const storage = new MemoryStorage();
  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ module: 'today' }));
  assert.equal(readPersistedModule(storage), 'messages');
  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ state: { module: 'ai-assistant' } }));
  assert.equal(readPersistedModule(storage), 'messages');
  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ state: { module: 'codex' } }));
  assert.equal(readPersistedModule(storage), 'messages');

  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ module: 'contributions' }));
  assert.equal(readPersistedModule(storage), 'workbench');
  assert.equal(readPersistedWorkbenchTab(storage), 'contributions');

  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ state: { module: 'contributions' } }));
  assert.equal(readPersistedModule(storage), 'workbench');
  assert.equal(readPersistedWorkbenchTab(storage), 'contributions');

  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ module: 'workbench' }));
  assert.equal(readPersistedWorkbenchTab(storage), 'overview');
});

test('工作项状态筛选默认隐藏搁置，并兼容旧存储形态', () => {
  const storage = new MemoryStorage();
  assert.equal(readPersistedWorkItemStateFilter(storage), DEFAULT_WORK_ITEM_STATE_FILTER);

  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ workItemStateFilter: '全部' }));
  assert.equal(readPersistedWorkItemStateFilter(storage), '全部');

  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ state: { workItemStateFilter: '活动' } }));
  assert.equal(readPersistedWorkItemStateFilter(storage), '活动');
});

test('可编程入口只通过 butlerView 驱动任务、已安排、插件三个工作面', () => {
  useUI.setState({ module: 'messages', butlerView: 'conversation' });
  useUI.getState().openButlerConversation();
  assert.equal(useUI.getState().module, 'butler-view');
  assert.equal(useUI.getState().butlerView, 'conversation');

  useUI.getState().setButlerView('routines');
  assert.equal(useUI.getState().module, 'butler-view');
  assert.equal(useUI.getState().butlerView, 'routines');

  useUI.getState().setButlerView('plugins');
  assert.equal(useUI.getState().module, 'butler-view');
  assert.equal(useUI.getState().butlerView, 'plugins');

  useUI.getState().setModule('butler-view');
  assert.equal(useUI.getState().butlerView, 'conversation');
});
