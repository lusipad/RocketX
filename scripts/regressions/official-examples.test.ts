import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const EXAMPLES = ['hello-app', 'kanban-app', 'poll-app', 'oncall-app'] as const;
const runtimeText = readFile(new URL('../../apps/web/src/kernel/runtime.tsx', import.meta.url), 'utf8');

function capabilityContract(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/capabilityBus\.register\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)]
      .map((match) => [match[1], match[2]]),
  );
}

for (const example of EXAMPLES) {
  test(`官方样板 ${example} 的 manifest、入口和权限契约保持一致`, async () => {
    const root = new URL(`../../examples/${example}/`, import.meta.url);
    const manifestText = await readFile(new URL('rcx.app.json', root), 'utf8');
    const manifest = JSON.parse(manifestText) as { runtime?: unknown; entry?: unknown; permissions?: unknown };
    assert.equal(manifest.runtime, 'iframe');
    assert.equal(manifest.entry, 'index.html');
    assert.ok(Array.isArray(manifest.permissions), `${example} 必须声明 permissions`);
    await stat(new URL(String(manifest.entry), root));

    const html = await readFile(new URL(String(manifest.entry), root), 'utf8');
    assert.match(html, /<!doctype html>/i);
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i, '官方样板必须保持单文件且不能加载外部脚本');
    assert.doesNotMatch(html, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/, '动态内容必须通过安全 DOM API 写入');
    for (const script of [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]) {
      assert.doesNotThrow(() => new Function(script[1]), `${example} 的内联脚本必须是合法 JavaScript`);
    }

    const methods = [...html.matchAll(/\bcall\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    const methodPermissions = capabilityContract(await runtimeText);
    for (const method of methods) {
      const permission = methodPermissions.get(method);
      assert.ok(permission, `${example} 调用了未知 capability: ${method}`);
      assert.ok(manifest.permissions.includes(permission), `${example} 调用 ${method} 但未声明 ${permission}`);
    }

    if (html.includes("method: 'rcx/requestUI'") || html.includes('method: "rcx/requestUI"')) {
      assert.ok(manifest.permissions.includes('ui:notify'), `${example} 请求宿主通知但未声明 ui:notify`);
    }
    const knownPermissions = new Set(methodPermissions.values());
    for (const permission of manifest.permissions) {
      assert.ok(knownPermissions.has(permission), `${example} 声明了未知权限 ${permission}`);
    }
  });
}
