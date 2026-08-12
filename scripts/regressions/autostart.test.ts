import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  readAutostartEnabled,
  updateAutostartEnabled,
} from '../../apps/web/src/lib/autostart';

test('Web 端不读取或修改操作系统开机自启', async () => {
  assert.equal(await readAutostartEnabled(), null);
  await assert.rejects(updateAutostartEnabled(true), /仅桌面端可用/);
});

test('正式安装版启动时会把已有启动项刷新到当前可执行文件', () => {
  const source = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  assert.match(source, /refresh_autostart_registration\(app\)/);
  assert.match(source, /let manager = app\.autolaunch\(\)/);
  assert.match(source, /manager\.is_enabled\(\)/);
  assert.match(source, /manager\.enable\(\)/);
  assert.match(source, /autostart_registration_allowed/);
  assert.match(source, /std::env::current_exe/);
});

test('本地 release 构建和前端都不能绕过正式安装版守卫', () => {
  const nativeSource = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  const webSource = readFileSync('apps/web/src/lib/autostart.ts', 'utf8');
  const capability = readFileSync('apps/desktop/src-tauri/capabilities/default.json', 'utf8');

  assert.match(nativeSource, /autostart_registration_allowed/);
  assert.match(nativeSource, /set_autostart_enabled/);
  assert.match(nativeSource, /read_autostart_enabled/);
  assert.match(webSource, /invoke<boolean \| null>\('read_autostart_enabled'\)/);
  assert.match(webSource, /invoke<boolean>\('set_autostart_enabled'/);
  assert.doesNotMatch(webSource, /plugin-autostart/);
  assert.doesNotMatch(capability, /autostart:allow-/);
});

test('系统登录自启动带来源标记且主窗口默认保持隐藏', () => {
  const source = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  const settings = readFileSync('apps/web/src/pages/SettingsPage.tsx', 'utf8');
  const config = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8')) as {
    app: { windows: Array<{ visible?: boolean }> };
  };
  assert.match(source, /const AUTOSTART_ARG: &str = "--autostart"/);
  assert.match(source, /Some\(vec!\[AUTOSTART_ARG\]\)/);
  assert.match(source, /is_autostart_launch/);
  assert.match(source, /let show_main_on_launch = launch_opens_main_window\(&launch_args\)/);
  assert.match(source, /if show_main_on_launch \{\s*show_main\(app\.handle\(\)\);\s*\}/);
  assert.match(settings, /登录系统后会静默启动到托盘/);
  assert.equal(config.app.windows[0]?.visible, false);
});

test('Debug 与任意 release 目录中的本地构建都不会登记启动项', () => {
  const source = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  assert.match(source, /cfg!\(debug_assertions\)/);
  assert.match(source, /eq_ignore_ascii_case\("debug"\)/);
  assert.match(source, /eq_ignore_ascii_case\("release"\)/);
  assert.match(source, /本地构建版不能设置开机启动/);
});
