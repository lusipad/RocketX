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

test('正式版启动时会把已有启动项刷新到当前可执行文件', () => {
  const source = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  assert.match(source, /refresh_autostart_registration\(app\)/);
  assert.match(source, /let manager = app\.autolaunch\(\)/);
  assert.match(source, /manager\.is_enabled\(\)/);
  assert.match(source, /manager\.enable\(\)/);
  assert.match(source, /cfg!\(debug_assertions\)/);
});

test('Debug 版不会允许登记依赖开发服务器的启动项', () => {
  const source = readFileSync('apps/web/src/lib/autostart.ts', 'utf8');
  assert.match(source, /import\.meta\.env\?\.DEV/);
  assert.match(source, /Debug 版依赖开发服务器/);
});
