import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ensureHttpOrigin, prepareTauriRequestInit } from '../../apps/web/src/lib/http';

test('桌面 HTTP/HTTPS 使用系统证书库并移除 WebView Origin', async () => {
  const cargo = await readFile(
    new URL('../../apps/desktop/src-tauri/Cargo.toml', import.meta.url),
    'utf8',
  );
  const dependency = cargo.match(/tauri-plugin-http\s*=\s*\{[^}]+\}/s)?.[0] ?? '';

  assert.match(dependency, /default-features\s*=\s*false/);
  assert.match(dependency, /rustls-tls-native-roots/);
  // 这个上游兼容特性会启用 reqwest/system-proxy，Windows 与 macOS 都读取系统代理。
  assert.match(dependency, /macos-system-configuration/);
  assert.match(dependency, /unsafe-headers/);
  assert.doesNotMatch(dependency, /dangerous-settings/);

  const original = { method: 'POST', headers: { 'X-Test': 'present' } } satisfies RequestInit;
  const prepared = prepareTauriRequestInit(original);
  const headers = new Headers(prepared.headers);

  assert.equal(prepared.method, 'POST');
  assert.equal(headers.get('X-Test'), 'present');
  assert.equal(headers.get('Origin'), '');
  assert.deepEqual(original.headers, { 'X-Test': 'present' });

  assert.equal(await ensureHttpOrigin('http://chat.example.test/path'), 'http://chat.example.test');
  assert.equal(
    await ensureHttpOrigin('https://chat.example.test:8443/path'),
    'https://chat.example.test:8443',
  );
  await assert.rejects(() => ensureHttpOrigin('ftp://chat.example.test'), /只允许无凭据的 http\/https/);
});
