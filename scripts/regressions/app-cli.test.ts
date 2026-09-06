import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createProject, startDevServer, validateProject } from '../../packages/create-rcx-app/src/index';

test('脚手架生成可校验应用并拒绝越界 entry', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rocketx-create-app-'));
  const root = path.join(temporary, 'my-poll');
  // 模板只剩 hello：poll/kanban/oncall 已升级为主程序原生功能，示例不再撞名
  const project = await createProject(root, 'hello');
  assert.equal(project.manifest.id, 'dev.local.my-poll');
  assert.equal(project.manifest.entry, 'index.html');
  await validateProject(root);
  await assert.rejects(() => createProject(path.join(temporary, 'nope'), 'poll'), /Unknown template/);

  const manifestPath = path.join(root, 'rcx.app.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.entry = '../outside.html';
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  await assert.rejects(() => validateProject(root), /inside the project directory/);
});

test('开发服务器只绑定回环并注入 mock Bridge 与刷新信号', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rocketx-app-dev-'));
  const root = path.join(temporary, 'hello-preview');
  await createProject(root, 'hello');
  const development = await startDevServer(root, 0);
  try {
    assert.match(development.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const html = await fetch(development.url).then((response) => response.text());
    assert.match(html, /__RCX_BRIDGE__/);
    assert.match(html, /__rcx_reload/);
    assert.match(html, /method==='app\.info'/);
    assert.match(html, /method==='net\.fetch'/);
    assert.match(html, /method==='lan\.peers'/);
    assert.match(html, /Unsupported mock capability: '\+method/);
    const traversal = await fetch(`${development.url}/..%2F..%2Fpackage.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await development.close();
  }
});
