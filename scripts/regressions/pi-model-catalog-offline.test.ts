import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('Pi 连接时使用本地模型目录，不依赖外部目录网络', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-pi-offline-catalog-'));
  const workspace = path.join(tempRoot, 'workspace');
  const configFile = path.join(tempRoot, 'config.json');
  const preloadFile = path.join(tempRoot, 'block-fetch.mjs');
  const fetchMarker = 'ROCKETX_TEST_FORBIDDEN_FETCH';
  fs.mkdirSync(workspace);
  fs.writeFileSync(configFile, JSON.stringify({
    provider: 'deepseek',
    apiKey: 'fake-offline-catalog-test-key',
    defaultModel: 'deepseek-chat',
  }));
  fs.writeFileSync(preloadFile, [
    'globalThis.fetch = async () => {',
    `  process.stderr.write('${fetchMarker}\\n');`,
    "  throw new Error('Network disabled by the offline catalog regression test');",
    '};',
  ].join('\n'));

  // Exercise the bridge's own offline setting, without inherited credentials or
  // PI_OFFLINE making an accidental network-enabled refresh appear correct.
  const env = { ...process.env };
  delete env.PI_OFFLINE;
  for (const name of Object.keys(env)) {
    if (/API_KEY|TOKEN|SECRET|CREDENTIAL/i.test(name)) delete env[name];
  }
  const child = spawn(process.execPath, [
    '--import', pathToFileURL(preloadFile).href,
    path.resolve('apps/desktop/src-tauri/src/pi_app_server.mjs'),
    '--pi-package-dir', path.resolve('apps/pi-runtime/node_modules/@earendil-works/pi-coding-agent'),
    '--agent-dir', path.join(tempRoot, 'agent'),
    '--config-file', configFile,
    '--workspace-root', workspace,
  ], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  const rejectPending = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', () => rejectPending(new Error('Pi exited before its catalog response')));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const frame = JSON.parse(line);
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(frame.error.message));
      else waiter.resolve(frame.result);
    } catch {
      rejectPending(new Error('Pi emitted invalid JSON during catalog startup'));
    }
  });
  let nextId = 1;
  const request = (method: string): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Pi startup timed out: ${method}`));
      }, 10_000);
      pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ id, method, params: {} })}\n`);
    });
  };

  try {
    const initialized = await request('initialize');
    assert.match(initialized.userAgent, /^rocketx\//);
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const catalog = await request('model/list');
    assert.ok(catalog.data.some((model: { model: string; isDefault: boolean }) => (
      model.model === 'deepseek/deepseek-chat' && model.isDefault
    )), 'Configured default model must remain available without network');
    assert.equal(stderr.split(fetchMarker).length - 1, 0,
      'Pi startup must not refresh remote model catalogs');
  } finally {
    lines.close();
    child.kill();
    await closed;
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
