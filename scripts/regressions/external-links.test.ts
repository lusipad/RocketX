import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';
import { localPermalinkMessageId } from '../../apps/web/src/lib/messageText';

test('仅识别当前 Rocket.Chat 部署路径以内的消息永久链接', () => {
  const bases = ['https://chat.example.test/rocket/', 'https://proxy.example.test'];
  assert.equal(localPermalinkMessageId('https://chat.example.test/rocket/channel/general?msg=a%2Fb', bases), 'a/b');
  assert.equal(localPermalinkMessageId('https://proxy.example.test/direct/room?msg=m', bases), 'm');
  for (const href of [
    'https://other.example.test/channel/general?msg=m',
    'https://chat.example.test/rocket2/channel/general?msg=m',
    'https://proxy.example.test/report?msg=m',
    'https://proxy.example.test/group/team',
    'invalid',
  ]) assert.equal(localPermalinkMessageId(href, bases), null, href);
});

test('普通 HTTP(S) 外链走受校验的原生命令，失败会明确提示（issue #129）', () => {
  const client = readFileSync('apps/web/src/lib/client.ts', 'utf8');
  const main = readFileSync('apps/web/src/main.tsx', 'utf8');

  assert.match(client, /invoke\('open_external_url', \{ url \}\)/);
  assert.match(client, /openExternal\(href\)\.catch\(onError\)/);
  assert.match(main, /t\('auth\.main\.openExternalFailed'\)/);
  assert.equal(zhCN['auth.main.openExternalFailed'], '无法用系统浏览器打开链接');
  assert.ok(enUS['auth.main.openExternalFailed'].length > 0);
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

test('桌面端允许打开已经下载到本地的文件（issue #183）', () => {
  const capability = JSON.parse(
    readFileSync('apps/desktop/src-tauri/capabilities/default.json', 'utf8'),
  ) as { permissions: Array<string | { identifier: string }> };

  assert.ok(capability.permissions.includes('opener:allow-open-path'));
});

test('局域网文件卡片通过受校验的原生命令打开（issue #357）', () => {
  const client = readFileSync('apps/web/src/lib/client.ts', 'utf8');
  const message = readFileSync('apps/web/src/components/MessageItem.tsx', 'utf8');
  const main = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  assert.match(client, /invoke\('open_local_file', \{ path \}\)/);
  assert.match(message, /await openLocalPath\(localPath\)/);
  assert.match(main, /fn open_local_file\(/);
});

test('消息正文里的 UNC 路径通过受校验的原生命令打开（issue #357）', () => {
  const client = readFileSync('apps/web/src/lib/client.ts', 'utf8');
  const message = readFileSync('apps/web/src/components/MessageItem.tsx', 'utf8');
  const main = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  assert.match(client, /invoke\('open_unc_path', \{ path \}\)/);
  assert.match(message, /await openUncPath\(path\)/);
  assert.doesNotMatch(message, /@tauri-apps\/plugin-opener/);
  assert.match(main, /fn resolve_unc_path\(/);
  assert.match(main, /fn open_unc_path\(/);
});
