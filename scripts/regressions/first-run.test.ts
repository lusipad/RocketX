import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESKTOP_DEFAULTS_STORAGE_KEY,
  FIRST_RUN_STORAGE_KEY,
  applyDesktopDefaults,
  completeFirstRun,
  hasExistingRocketXUserState,
  loadDesktopDefaultsRecord,
  loadFirstRunState,
  prepareDesktopDefaultsRecord,
  resetFirstRun,
  saveAppliedDesktopDefaults,
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

class TrackingStorage extends MemoryStorage {
  public getCount = 0;
  public setCount = 0;

  override getItem(key: string): string | null {
    this.getCount += 1;
    return super.getItem(key);
  }

  override setItem(key: string, value: string): void {
    this.setCount += 1;
    super.setItem(key, value);
  }
}

class FailingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error('storage unavailable');
  }
}

test('旧安装识别保护既有用户配置，但忽略新策略与启动时生成的设备状态', () => {
  const storage = new MemoryStorage();
  assert.equal(hasExistingRocketXUserState(storage), false);

  storage.setItem(DESKTOP_DEFAULTS_STORAGE_KEY, JSON.stringify({ version: 1 }));
  storage.setItem('rcx-ui', JSON.stringify({ sidebar: {} }));
  storage.setItem('rcx-agent-device-id', 'generated-on-startup');
  assert.equal(hasExistingRocketXUserState(storage), false);

  storage.setItem('rcx-owner', 'user@example.com');
  assert.equal(hasExistingRocketXUserState(storage), true);
});

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
    shouldShowFirstRun({
      desktop: true,
      serverUrl: 'https://chat.example.com',
      hasWorkspaceSource: true,
      state: loadFirstRunState(storage),
    }),
    true,
  );

  completeFirstRun(storage);
  assert.equal(storage.getItem(FIRST_RUN_STORAGE_KEY), 'complete');
  assert.equal(
    shouldShowFirstRun({ desktop: true, serverUrl: '', hasWorkspaceSource: false, state: loadFirstRunState(storage) }),
    false,
  );
});

test('prepare 为桌面新设备写入 fresh + pending 记录', () => {
  const storage = new MemoryStorage();
  const record = prepareDesktopDefaultsRecord({
    storage,
    releaseDesktop: true,
    hasExistingUserState: false,
  });

  assert.deepEqual(record, {
    version: 1,
    status: 'fresh',
    notifications: 'pending',
    autostart: 'pending',
  });
  assert.deepEqual(loadDesktopDefaultsRecord(storage), record);
});

test('设备策略无法写盘时不伪造 fresh 或 applied 记录', () => {
  const storage = new FailingStorage();
  assert.equal(prepareDesktopDefaultsRecord({
    storage,
    releaseDesktop: true,
    hasExistingUserState: false,
  }), null);
  assert.equal(saveAppliedDesktopDefaults(storage, {
    notifications: 'enabled',
    autostart: 'enabled',
  }), null);
});

test('prepare 读取到 applied 记录时直接复用', () => {
  const storage = new MemoryStorage();
  saveAppliedDesktopDefaults(storage, {
    notifications: 'enabled',
    autostart: 'denied',
  });

  const record = prepareDesktopDefaultsRecord({
    storage,
    releaseDesktop: true,
    hasExistingUserState: false,
  });

  assert.deepEqual(record, {
    version: 1,
    status: 'applied',
    notifications: 'enabled',
    autostart: 'denied',
  });
});

test('prepare 在已有用户状态时迁移为 legacy-migrated + preserved', () => {
  const storage = new MemoryStorage();
  const record = prepareDesktopDefaultsRecord({
    storage,
    releaseDesktop: true,
    hasExistingUserState: true,
  });

  assert.deepEqual(record, {
    version: 1,
    status: 'legacy-migrated',
    notifications: 'preserved',
    autostart: 'preserved',
  });
  assert.deepEqual(loadDesktopDefaultsRecord(storage), record);
});

test('损坏记录与未知版本都会安全迁移，绝不重置为 fresh', () => {
  const emptyStorage = new MemoryStorage();
  emptyStorage.setItem(DESKTOP_DEFAULTS_STORAGE_KEY, '');
  assert.equal(prepareDesktopDefaultsRecord({
    storage: emptyStorage,
    releaseDesktop: true,
    hasExistingUserState: false,
  })?.status, 'legacy-migrated');

  const brokenStorage = new MemoryStorage();
  brokenStorage.setItem(DESKTOP_DEFAULTS_STORAGE_KEY, '{oops');

  const broken = prepareDesktopDefaultsRecord({
    storage: brokenStorage,
    releaseDesktop: true,
    hasExistingUserState: false,
  });
  assert.equal(broken?.status, 'legacy-migrated');
  assert.equal(broken?.notifications, 'preserved');
  assert.equal(broken?.autostart, 'preserved');

  const unknownVersionStorage = new MemoryStorage();
  unknownVersionStorage.setItem(
    DESKTOP_DEFAULTS_STORAGE_KEY,
    JSON.stringify({
      version: 9,
      status: 'fresh',
      notifications: 'pending',
      autostart: 'pending',
    }),
  );

  const migrated = prepareDesktopDefaultsRecord({
    storage: unknownVersionStorage,
    releaseDesktop: true,
    hasExistingUserState: false,
  });
  assert.equal(migrated?.status, 'legacy-migrated');
  assert.equal(migrated?.notifications, 'preserved');
  assert.equal(migrated?.autostart, 'preserved');

  const invalidCombinationStorage = new MemoryStorage();
  invalidCombinationStorage.setItem(DESKTOP_DEFAULTS_STORAGE_KEY, JSON.stringify({
    version: 1,
    status: 'applied',
    notifications: 'pending',
    autostart: 'enabled',
  }));
  assert.equal(prepareDesktopDefaultsRecord({
    storage: invalidCombinationStorage,
    releaseDesktop: true,
    hasExistingUserState: false,
  })?.status, 'legacy-migrated');
});

test('resetFirstRun 不清理设备级默认策略记录', () => {
  const storage = new MemoryStorage();
  saveAppliedDesktopDefaults(storage, {
    notifications: 'enabled',
    autostart: 'enabled',
  });

  resetFirstRun(storage);

  assert.equal(storage.getItem(FIRST_RUN_STORAGE_KEY), 'pending');
  assert.deepEqual(loadDesktopDefaultsRecord(storage), {
    version: 1,
    status: 'applied',
    notifications: 'enabled',
    autostart: 'enabled',
  });
});

test('非正式桌面 prepare 不读写，apply 不触发任何副作用', async () => {
  const storage = new TrackingStorage();
  const prepare = prepareDesktopDefaultsRecord({
    storage,
    releaseDesktop: false,
    hasExistingUserState: false,
  });

  let notificationsCalled = 0;
  let autostartCalled = 0;
  const result = await applyDesktopDefaults({
    releaseDesktop: false,
    notificationsChecked: true,
    autostartChecked: true,
    requestNotifications: async () => {
      notificationsCalled += 1;
      return 'granted';
    },
    enableAutostart: async () => {
      autostartCalled += 1;
      return true;
    },
  });

  assert.equal(prepare, null);
  assert.equal(storage.getCount, 0);
  assert.equal(storage.setCount, 0);
  assert.equal(notificationsCalled, 0);
  assert.equal(autostartCalled, 0);
  assert.deepEqual(result, {
    notifications: 'skipped',
    autostart: 'skipped',
  });
});

test('取消选项时不调用副作用并返回 skipped', async () => {
  let notificationsCalled = 0;
  let autostartCalled = 0;

  const result = await applyDesktopDefaults({
    releaseDesktop: true,
    notificationsChecked: false,
    autostartChecked: false,
    requestNotifications: async () => {
      notificationsCalled += 1;
      return 'granted';
    },
    enableAutostart: async () => {
      autostartCalled += 1;
      return true;
    },
  });

  assert.equal(notificationsCalled, 0);
  assert.equal(autostartCalled, 0);
  assert.deepEqual(result, {
    notifications: 'skipped',
    autostart: 'skipped',
  });
});

test('通知拒绝与自启动回读不一致分别映射到 denied 和 failed', async () => {
  const result = await applyDesktopDefaults({
    releaseDesktop: true,
    notificationsChecked: true,
    autostartChecked: true,
    requestNotifications: async () => 'denied',
    enableAutostart: async () => false,
  });

  assert.deepEqual(result, {
    notifications: 'denied',
    autostart: 'failed',
  });
});

test('通知失败时仍继续执行自启动，并通过进度回调暴露结果', async () => {
  const progress: Array<{ step: string; result: string }> = [];
  let autostartCalled = 0;

  const result = await applyDesktopDefaults({
    releaseDesktop: true,
    notificationsChecked: true,
    autostartChecked: true,
    requestNotifications: async () => {
      throw new Error('boom');
    },
    enableAutostart: async () => {
      autostartCalled += 1;
      return true;
    },
    onProgress: (step, stepResult) => {
      progress.push({ step, result: stepResult });
    },
  });

  assert.equal(autostartCalled, 1);
  assert.deepEqual(progress, [
    { step: 'notifications', result: 'failed' },
    { step: 'autostart', result: 'enabled' },
  ]);
  assert.deepEqual(result, {
    notifications: 'failed',
    autostart: 'enabled',
  });
});
