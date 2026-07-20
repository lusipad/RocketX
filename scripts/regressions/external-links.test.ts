import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('普通 HTTP(S) 外链走受校验的原生命令，失败会明确提示（issue #129）', () => {
  const client = readFileSync('apps/web/src/lib/client.ts', 'utf8');
  const main = readFileSync('apps/web/src/main.tsx', 'utf8');

  assert.match(client, /invoke\('open_external_url', \{ url \}\)/);
  assert.match(client, /openExternal\(href\)\.catch\(onError\)/);
  assert.match(main, /无法用系统浏览器打开链接/);
});

test('Codex 线程 deep link 也走受校验的原生命令（issue #132）', () => {
  const transfer = readFileSync('apps/web/src/agent/codexTransfer.ts', 'utf8');
  assert.match(transfer, /invoke\('open_external_url', \{ url \}\)/);
  assert.doesNotMatch(transfer, /plugin-opener/);
});

test('Codex 协议权限是附加能力，不移除普通浏览器 URL 默认权限', () => {
  const capability = JSON.parse(
    readFileSync('apps/desktop/src-tauri/capabilities/default.json', 'utf8'),
  ) as { permissions: Array<string | { identifier: string; allow?: Array<{ url?: string }> }> };

  assert.ok(capability.permissions.includes('opener:default'));
  const custom = capability.permissions.find(
    (permission) => typeof permission !== 'string' && permission.identifier === 'opener:allow-open-url',
  );
  assert.ok(custom && typeof custom !== 'string');
  assert.ok(custom.allow?.some((scope) => scope.url === 'codex://threads/*'));
});
