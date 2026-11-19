/** Real isolated Tauri / Pi catalog smoke. No thread, turn or provider authentication request. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

async function main(): Promise<void> {
  const root = process.cwd();
  const output = path.join(root, '.omx/logs/pi-connection-20261116');
  await mkdir(output, { recursive: true });
  const requireRoot = createRequire(path.join(root, 'package.json'));
  const requireTsx = createRequire(requireRoot.resolve('tsx/package.json'));
  const { build } = requireTsx('esbuild');
  const bundled = await build({
    stdin: {
      contents: `
        import { AppServerClient } from './apps/web/src/agent/protocol/client';
        import { TauriPiTransport } from './apps/web/src/agent/protocol/tauriTransport';
        window.__runRealPiCatalog = async (workspaceRoot) => {
          const transport = new TauriPiTransport('connection-smoke-' + crypto.randomUUID(), workspaceRoot);
          const realWrite = transport.write.bind(transport);
          const rpcMethods = [];
          let forbiddenRequests = 0;
          transport.write = async (message) => {
            if (message.method) rpcMethods.push(message.method);
            if (message.method === 'thread/start' || message.method === 'turn/start') {
              forbiddenRequests++;
              throw new Error('This smoke cannot create threads or model turns');
            }
            return realWrite(message);
          };
          const client = new AppServerClient(transport);
          let result;
          try {
            const started = performance.now();
            const process = await client.start();
            const catalog = await client.request('model/list', { includeHidden: false });
            result = { elapsedMs: Math.round(performance.now() - started), processId: process.processId,
              modelCount: catalog.data.length, deepseekAvailable: catalog.data.some(model => model.model === 'deepseek-v4-flash' || model.model.endsWith('/deepseek-v4-flash')) };
          } finally { await client.stop(); }
          return { ...result, rpcMethods, forbiddenRequests, stopped: true };
        };
      `,
      resolveDir: root,
      sourcefile: 'pi-connection-native-smoke.ts',
      loader: 'ts',
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022',
  });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9341');
  let wroteFakeKey = false;
  let verifiedIsolation = false;
  try {
    const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('http://tauri.localhost/'));
    assert(page, 'No actual Tauri page found');
    page.setDefaultTimeout(30_000);
    const invoke = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => page.evaluate(
      ({ command, args }) => (window as any).__TAURI_INTERNALS__.invoke(command, args), { command, args },
    );
    const identifier = await invoke<string>('plugin:app|identifier');
    assert.equal(identifier, 'com.lusipad.rocketx.acceptancepi20261116', 'Refusing to configure a user instance');
    const appDataDir = await invoke<string>('plugin:path|resolve_directory', { directory: 14 });
    assert(appDataDir.toLowerCase().includes(identifier), 'Native data directory is not isolated');
    verifiedIsolation = true;
    const sidebar = page.getByRole('navigation', { name: 'AI 协作' });
    if (await sidebar.count() === 0) await page.getByRole('navigation', { name: 'RocketX 主导航' }).getByRole('button', { name: /^(AI )?管家$/ }).click();
    await sidebar.getByRole('button', { name: '管家', exact: true }).click();
    const fakeKey = `sk-${randomUUID().replace(/-/g, '')}`;
    const activate = page.getByRole('button', { name: '立即启用并开始对话', exact: true });
    const onboardingVisible = await activate.isVisible();
    if (onboardingVisible) {
      await page.getByRole('button', { name: /DeepSeek 官方/ }).click();
      await page.getByPlaceholder('sk-...', { exact: true }).fill(fakeKey);
      wroteFakeKey = true;
      await activate.click();
      await expect(page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })).toBeEnabled();
    } else {
      await invoke('pi_config_write', { input: {
        provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: fakeKey,
        defaultModel: 'deepseek-v4-flash', extraModels: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'], manualPath: '',
      } });
      wroteFakeKey = true;
    }
    const workspaceRoot = await invoke<string>('codex_butler_workspace');
    assert(workspaceRoot.toLowerCase().includes(identifier), 'Pi workspace is not isolated');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    const catalog = await page.evaluate((workspace) => (window as any).__runRealPiCatalog(workspace), workspaceRoot);
    assert(catalog.modelCount > 0 && catalog.deepseekAvailable, 'DeepSeek local catalog did not become ready');
    await expect(page.getByRole('textbox', { name: '给 Pi 的任务', exact: true })).toBeEnabled();
    await expect(page.getByText(/就绪 · 支持代码编写/)).toBeVisible();
    assert.equal(catalog.forbiddenRequests, 0);
    assert(catalog.rpcMethods.includes('initialize') && catalog.rpcMethods.includes('model/list'));
    assert(catalog.stopped, 'The explicit native smoke process was not stopped');
    const networkLog = await readFile(path.join(output, 'blocked-node-network.jsonl'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    assert.equal(networkLog.trim(), '', 'A Node process attempted remote access during local connection');
    const guardedProcesses = (await readFile(path.join(output, 'node-network-guard-starts.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
    assert(guardedProcesses.length > 0, 'The isolated Node network guard was not installed');
    const evidence = {
      checkedAt: new Date().toISOString(), identifier, appDataDir,
      verificationPath: onboardingVisible ? 'real-onboarding-ui-and-native-client' : 'isolated-fake-config-native-client-and-ready-ui',
      fakeKeyOnly: true, providerAuthenticationVerified: false, ...catalog,
      nativeTransport: 'TauriPiTransport', protocolClient: 'AppServerClient', uiReady: true,
      threadOrTurnRequests: catalog.forbiddenRequests,
      remoteNodeAttempts: 0, guardedNodeProcesses: guardedProcesses.length, explicitClientStopped: true,
    };
    await page.screenshot({ path: path.join(output, 'pi-ready-real-webview.png') });
    await writeFile(path.join(output, 'pi-connection-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (verifiedIsolation) {
      const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('http://tauri.localhost/'));
      if (page) {
        if (wroteFakeKey) await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('pi_config_write', { input: { apiKey: '' } }));
      }
    }
    await browser.close();
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
