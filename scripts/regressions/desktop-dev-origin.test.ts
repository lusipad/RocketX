import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tauri = JSON.parse(
  readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'),
) as { build?: { devUrl?: string } };
const vite = readFileSync('apps/web/vite.config.ts', 'utf8');

test('桌面开发服务器使用独立回环端口，冲突时失败而不是打开其他应用', () => {
  assert.equal(tauri.build?.devUrl, 'http://127.0.0.1:1420');
  assert.match(vite, /host:\s*['"]127\.0\.0\.1['"]/);
  assert.match(vite, /port:\s*1420/);
  assert.match(vite, /strictPort:\s*true/);
});
