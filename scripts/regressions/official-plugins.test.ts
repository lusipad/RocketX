import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const PLUGINS = ['intranet-link'] as const;
const runtimeText = readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8');
const ipmsgBackendText = readFile(new URL('../../apps/desktop/src-tauri/src/ipmsg.rs', import.meta.url), 'utf8');
const ipmsgStoreText = readFile(new URL('../../apps/web/src/ipmsg/store.ts', import.meta.url), 'utf8');
const settingsText = readFile(new URL('../../apps/web/src/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const chatStoreText = readFile(new URL('../../apps/web/src/stores/chat.ts', import.meta.url), 'utf8');

function capabilityContract(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/capabilityBus\.register\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)]
      .map((match) => [match[1], match[2]]),
  );
}

for (const plugin of PLUGINS) {
  test(`官方插件 ${plugin} 的 manifest、入口和权限契约保持一致`, async () => {
    const root = new URL(`../../plugins/${plugin}/`, import.meta.url);
    const manifestText = await readFile(new URL('rcx.app.json', root), 'utf8');
    const manifest = JSON.parse(manifestText) as {
      runtime?: unknown;
      entry?: unknown;
      permissions?: unknown;
      enabledByDefault?: unknown;
    };
    assert.equal(manifest.runtime, 'iframe');
    assert.equal(manifest.entry, 'index.html');
    assert.ok(Array.isArray(manifest.permissions), `${plugin} 必须声明 permissions`);
    await stat(new URL(String(manifest.entry), root));

    const html = await readFile(new URL(String(manifest.entry), root), 'utf8');
    assert.match(html, /<!doctype html>/i);
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i, '官方插件必须保持单文件且不能加载外部脚本');
    assert.doesNotMatch(html, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/, '动态内容必须通过安全 DOM API 写入');
    for (const script of [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]) {
      assert.doesNotThrow(() => new Function(script[1]), `${plugin} 的内联脚本必须是合法 JavaScript`);
    }

    const methods = [...html.matchAll(/\bcall\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    const methodPermissions = capabilityContract(await runtimeText);
    for (const method of methods) {
      const permission = methodPermissions.get(method);
      assert.ok(permission, `${plugin} 调用了未知 capability: ${method}`);
      assert.ok(manifest.permissions.includes(permission), `${plugin} 调用 ${method} 但未声明 ${permission}`);
    }

    if (html.includes("method: 'rcx/requestUI'") || html.includes('method: "rcx/requestUI"')) {
      assert.ok(manifest.permissions.includes('ui:notify'), `${plugin} 请求宿主通知但未声明 ui:notify`);
    }
  });
}

test('内网通文件邀请必须由宿主选择文件，不能接受插件提供的本地路径', async () => {
  const html = await readFile(new URL('../../plugins/intranet-link/index.html', import.meta.url), 'utf8');
  const runtime = await runtimeText;
  const offerFileHandler = runtime.match(
    /capabilityBus\.register\('ipmsg\.offerFile'[\s\S]*?capabilityBus\.register\('storage\.get'/,
  )?.[0];

  assert.ok(offerFileHandler, '必须注册 ipmsg.offerFile capability');
  assert.doesNotMatch(html, /file-path|\bpath\s*:/, '插件不能提交任意本地文件路径');
  assert.doesNotMatch(offerFileHandler, /stringParam\(params, 'path'\)/, '宿主不能信任插件提供的 path');
  assert.match(offerFileHandler, /@tauri-apps\/plugin-dialog/, '宿主必须通过原生文件选择器获得路径');
});

test('内网通作为默认禁用的官方插件，不能绕过应用生命周期独立启动', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../plugins/intranet-link/rcx.app.json', import.meta.url), 'utf8'),
  ) as { enabledByDefault?: unknown };
  assert.equal(manifest.enabledByDefault, false);
  assert.match(await chatStoreText, /initializeIpmsgRuntime/);
  assert.doesNotMatch(await settingsText, /内网通兼容模式/);
  assert.match(await ipmsgStoreText, /const APP_ID = INTRANET_LINK_APP_ID/);
  assert.match(await ipmsgStoreText, /appManager\(\)\.get\(APP_ID\)\?\.enabled/);
  assert.match(await runtimeText, /app\.manifest\.id === INTRANET_LINK_APP_ID/);
  assert.match(await runtimeText, /requireIntranetLink\(context\.appId\)/);
  assert.match(await runtimeText, /if \(!ipmsg\.running\) await ipmsg\.setEnabled\(true\)/);
  assert.match(await runtimeText, /setEnabled\(false\)/);
  assert.match(await runtimeText, /activeRid === IPMSG_RID/);
  assert.match(await chatStoreText, /startLanRuntime/);
  assert.match(await settingsText, /局域网直传与离线回灌/);
});

test('9011 被占用时保留 2425 兼容模式并向界面暴露降级状态', async () => {
  assert.match(await ipmsgBackendText, /intranet_available/);
  assert.match(await ipmsgStoreText, /intranetAvailable: status\.intranetAvailable/);
  const chatArea = await readFile(new URL('../../apps/web/src/components/IpmsgChatArea.tsx', import.meta.url), 'utf8');
  assert.match(chatArea, /9011 被占用，内网通兼容不可用/);
});
