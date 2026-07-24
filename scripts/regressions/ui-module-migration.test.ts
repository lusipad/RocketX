import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORK_ITEM_STATE_FILTER,
  migratePersistedModule,
  readPersistedModule,
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

test('退役的模块持久化值启动时迁到管家桌面', () => {
  assert.equal(migratePersistedModule('today'), 'butler-view');
  assert.equal(migratePersistedModule('ai-assistant'), 'butler-view');
  assert.equal(migratePersistedModule('butler-view'), 'butler-view');
  assert.equal(migratePersistedModule('downloads'), 'downloads');
  assert.equal(migratePersistedModule('unknown'), 'messages');

  const storage = new MemoryStorage();
  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ module: 'today' }));
  assert.equal(readPersistedModule(storage), 'butler-view');
  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ state: { module: 'ai-assistant' } }));
  assert.equal(readPersistedModule(storage), 'butler-view');
});

test('工作项状态筛选默认隐藏搁置，并兼容旧存储形态', () => {
  const storage = new MemoryStorage();
  assert.equal(readPersistedWorkItemStateFilter(storage), DEFAULT_WORK_ITEM_STATE_FILTER);

  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ workItemStateFilter: '全部' }));
  assert.equal(readPersistedWorkItemStateFilter(storage), '全部');

  storage.setItem(UI_MODULE_STORAGE_KEY, JSON.stringify({ state: { workItemStateFilter: '活动' } }));
  assert.equal(readPersistedWorkItemStateFilter(storage), '活动');
});

test('可编程入口原子打开管家桌面对话，收起只改变表面状态', () => {
  useUI.setState({ module: 'messages', butlerConversationOpen: false });
  useUI.getState().openButlerConversation();
  assert.equal(useUI.getState().module, 'butler-view');
  assert.equal(useUI.getState().butlerConversationOpen, true);

  useUI.getState().closeButlerConversation();
  assert.equal(useUI.getState().module, 'butler-view');
  assert.equal(useUI.getState().butlerConversationOpen, false);
});
