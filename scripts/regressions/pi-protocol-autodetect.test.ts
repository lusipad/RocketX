import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';
import {
  PI_API_PROTOCOL_OPTIONS,
  inferProtocolHintFromInput,
  mergeDiscoveredModels,
  normalizeOpenAiBaseUrl,
  parseConnectionSnippet,
} from '../../apps/web/src/lib/piProtocols';

function prepareChildStop(child: ChildProcess): () => Promise<void> {
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const onClose = () => {
    closed = true;
    resolveClosed();
  };
  child.once('close', onClose);
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (closed) return;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Pi fixture child did not exit within 5 seconds')), 5_000);
      });
      child.stdout?.resume();
      child.stderr?.resume();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.race([closedPromise, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      child.off('close', onClose);
    }
  };
}

test('inferProtocolHintFromInput 与 mergeDiscoveredModels 正确识别 Magpie/OpenAI/Anthropic/Gemini/Azure 信号', () => {
  assert.deepEqual(
    inferProtocolHintFromInput('https://proxy.corp/v1/responses', ''),
    { protocol: 'openai-responses', reason: 'url' },
  );
  assert.deepEqual(
    inferProtocolHintFromInput('https://proxy.corp/v1/chat/completions', ''),
    { protocol: 'openai-completions', reason: 'url' },
  );
  assert.deepEqual(
    inferProtocolHintFromInput('https://gateway.local/v1', 'sk-ant-api03-test'),
    { protocol: 'anthropic-messages', reason: 'key' },
  );
  assert.deepEqual(
    inferProtocolHintFromInput('https://generativelanguage.googleapis.com/v1beta', ''),
    { protocol: 'google-generative-ai', reason: 'url' },
  );
  assert.deepEqual(
    inferProtocolHintFromInput('https://generativelanguage.googleapis.com/v1beta/openai', ''),
    { protocol: 'openai-completions', reason: 'url' },
  );
  assert.deepEqual(
    inferProtocolHintFromInput('https://my-resource.openai.azure.com', ''),
    { protocol: 'azure-openai-responses', reason: 'url' },
  );
  assert.deepEqual(
    inferProtocolHintFromInput('http://127.0.0.1:3425/v1', ''),
    { protocol: 'openai-responses', reason: 'url' },
  );

  const merged = mergeDiscoveredModels('old-model', 'keep-a', ['m1', 'm2', 'm3'], 'm2');
  assert.equal(merged.defaultModel, 'm2');
  assert.equal(merged.extraModels, 'm1, m3, keep-a');

  const kept = mergeDiscoveredModels('m3', '', ['m1', 'm2', 'm3'], 'm1');
  assert.equal(kept.defaultModel, 'm3');
  assert.equal(kept.extraModels, 'm1, m2');

  assert.ok(PI_API_PROTOCOL_OPTIONS.some((opt) => opt.id === 'openai-responses'));
  assert.ok(PI_API_PROTOCOL_OPTIONS.some((opt) => opt.id === 'anthropic-messages'));
  assert.ok(PI_API_PROTOCOL_OPTIONS.some((opt) => opt.id === 'google-generative-ai'));
  assert.ok(PI_API_PROTOCOL_OPTIONS.some((opt) => opt.id === 'azure-openai-responses'));
});

test('Pi App-Server 按 apiProtocol 将 custom-openai 真实路由到 OpenAI Responses API (/v1/responses)', async () => {
  const seenRequests: Array<{ method: string; url: string; auth: string }> = [];
  const mockGateway = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seenRequests.push({
        method: req.method || '',
        url: req.url || '',
        auth: String(req.headers.authorization || ''),
      });
      if (req.url === '/v1/responses') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        const sse = (eventObj: unknown) => `event: ${(eventObj as any).type}\ndata: ${JSON.stringify(eventObj)}\n\n`;
        res.write(sse({
          type: 'response.created',
          response: { id: 'resp_test_1', status: 'in_progress' },
        }));
        res.write(sse({
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        }));
        res.write(sse({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'Responses OK',
        }));
        res.write(sse({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Responses OK' }],
          },
        }));
        res.write(sse({
          type: 'response.completed',
          response: {
            id: 'resp_test_1',
            status: 'completed',
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          },
        }));
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unexpected path: ${req.url}` }));
    });
  });

  await new Promise<void>((resolve) => mockGateway.listen(0, '127.0.0.1', resolve));
  const port = (mockGateway.address() as { port: number }).port;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-pi-responses-proto-'));
  const agentDir = path.join(tempRoot, 'agent');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const configFile = path.join(tempRoot, 'rocketx-pi-config.json');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      provider: 'custom-openai',
      apiProtocol: 'openai-responses',
      baseUrl: `http://127.0.0.1:${port}/v1/responses`,
      apiKey: 'sk-magpie-test',
      defaultModel: 'gpt-6.1-sol',
      extraModels: [],
    }),
    'utf8',
  );

  const serverScript = path.resolve('apps/desktop/src-tauri/src/pi_app_server.mjs');
  const piPackageDir = path.resolve('apps/pi-runtime/node_modules/@earendil-works/pi-coding-agent');
  const child = spawn(
    process.execPath,
    [
      serverScript,
      '--pi-package-dir',
      piPackageDir,
      '--agent-dir',
      agentDir,
      '--config-file',
      configFile,
      '--workspace-root',
      workspaceDir,
    ],
    { cwd: workspaceDir, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const stopChild = prepareChildStop(child);
  const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  const deltas: string[] = [];
  let turnDoneResolve: ((turn: any) => void) | null = null;
  let stderrOutput = '';
  child.stderr.on('data', (chunk) => { stderrOutput += chunk.toString('utf8'); });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const frame = JSON.parse(trimmed);
    if (typeof frame.id === 'number' && pending.has(frame.id)) {
      const waiter = pending.get(frame.id)!;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(frame.error.message || JSON.stringify(frame.error)));
      else waiter.resolve(frame.result);
    } else if (frame.method === 'item/agentMessage/delta' && typeof frame.params?.delta === 'string') {
      deltas.push(frame.params.delta);
    } else if (frame.method === 'turn/completed' && turnDoneResolve) {
      turnDoneResolve(frame.params.turn);
      turnDoneResolve = null;
    }
  });

  let seq = 1;
  const request = <T = any>(method: string, params: unknown = {}): Promise<T> => {
    const id = seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout on ${method}: ${stderrOutput}`));
      }, 15_000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  try {
    await request('initialize', {
      clientInfo: { name: 'rocketx', title: 'RocketX', version: '0.44.18' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    const threadResp = await request('thread/start', { cwd: workspaceDir, model: 'custom-openai/gpt-6.1-sol' });
    const turnDonePromise = new Promise<any>((resolve) => { turnDoneResolve = resolve; });
    await request('turn/start', {
      threadId: threadResp.thread.id,
      model: 'custom-openai/gpt-6.1-sol',
      input: [{ type: 'text', text: 'hello' }],
    });
    const completedTurn = await turnDonePromise;
    assert.equal(completedTurn.status, 'completed');
    assert.equal(deltas.join(''), 'Responses OK');
    assert.ok(seenRequests.some((r) => r.method === 'POST' && r.url === '/v1/responses'));
  } finally {
    rl.close();
    await stopChild();
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('设置页、快速引导与后端桥接完整接入多协议与 Magpie 自动探测', () => {
  const settings = fs.readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');
  const onboarding = fs.readFileSync('apps/web/src/components/PiQuickOnboardingCard.tsx', 'utf8');
  const piServer = fs.readFileSync('apps/desktop/src-tauri/src/pi_app_server.mjs', 'utf8');

  assert.match(settings, /probePiEndpoint/);
  assert.match(settings, /scanLocalPiGateways/);
  assert.match(settings, /apiProtocol: piApiProtocol/);
  assert.match(onboarding, /probePiEndpoint/);
  assert.match(onboarding, /scanLocalPiGateways/);
  assert.match(onboarding, /apiProtocol,/);
  assert.match(piServer, /SUPPORTED_API_PROTOCOLS/);
  assert.match(piServer, /normalizeBaseUrlForApi/);
  assert.match(piServer, /authHeader: useBearerAuthHeader/);

  assert.ok(zhCN['settings.ai.probeEndpoint']);
  assert.ok(enUS['settings.ai.probeEndpoint']);
  assert.ok(zhCN['butler.piOnboarding.probeEndpoint']);
  assert.ok(enUS['butler.piOnboarding.probeEndpoint']);
});

test('parseConnectionSnippet 与裸域 /v1 补全支持 NewAPI 一键粘贴配置', () => {
  assert.equal(normalizeOpenAiBaseUrl('https://api.example.com'), 'https://api.example.com/v1');
  assert.equal(normalizeOpenAiBaseUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1');
  assert.equal(normalizeOpenAiBaseUrl('https://gateway.local/custom'), 'https://gateway.local/custom');

  const snippet = parseConnectionSnippet(
    '{"_type":"newapi_channel_conn","key":"sk-newapi-sample-token","url":"https://api.example.com"}',
  );
  assert.deepEqual(snippet, {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-newapi-sample-token',
  });
  assert.equal(parseConnectionSnippet('https://api.example.com'), null);
});
