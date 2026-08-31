import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('桌面通知权限查询绕过 WebView2 的 Notification.permission', async () => {
  const source = await readFile(new URL('../../apps/web/src/lib/notify.ts', import.meta.url), 'utf8');

  assert.match(source, /plugin:notification\|is_permission_granted/);
  assert.match(source, /async function tauriPermissionGranted\(\)/);
  assert.match(source, /rcx-notification-permission/);
  assert.match(source, /invoke<boolean \| null>/);
  assert.match(source, /cacheNotifyPermission\(result\)/);
  assert.doesNotMatch(source, /const \{ isPermissionGranted, requestPermission \}/);
  assert.doesNotMatch(source, /const \{ isPermissionGranted \} = await import\('@tauri-apps\/plugin-notification'\)/);
});

test('通知设置提供应用内关闭路径，不把系统权限撤销伪装成应用操作', async () => {
  const source = await readFile(
    new URL('../../apps/web/src/pages/SettingsPage.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /desktopNotifications === 'nothing'/);
  assert.match(source, /关闭桌面通知/);
  assert.match(source, /desktopNotifications: prefs\.desktopNotifications === 'nothing' \? 'all' : 'nothing'/);
});
