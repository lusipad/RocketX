import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import test from 'node:test';
import {
  AppServerClient,
  type CodexTransport,
} from '../../apps/web/src/agent/protocol/client';
import { evaluateSessionControlMode } from '../../apps/web/src/agent/sessionAdapter';
import {
  getAiRuntimeStartupResolution,
  initializeStartupAiRuntimeProvider,
} from '../../apps/web/src/lib/aiRuntimeBootstrap';
import {
  AI_RUNTIME_PROVIDER_STORAGE_KEY,
  PI_CONFIGURED_STORAGE_KEY,
  isNativeButlerRuntime,
  normalizeAiRuntimeProvider,
  resetAiRuntimeProviderForTests,
  runtimeFeatures,
  selectStartupAiRuntimeProvider,
  type RuntimeModeStorage,
} from '../../apps/web/src/lib/runtimeMode';

function prepareFixtureChildStop(child: ChildProcess): () => Promise<void> {
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
        timer = setTimeout(() => reject(new Error('Pi fixture child did not close within 5 seconds')), 5_000);
      });
      // readline.close() pauses stdout; drain both streams so close can follow process exit.
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

function memoryStorage(initial: Record<string, string> = {}): RuntimeModeStorage {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

test('Pi 运行时选择、启动决策与受控会话能力矩阵完整对齐原生管家', async () => {
  assert.equal(normalizeAiRuntimeProvider('pi'), 'pi');
  assert.equal(isNativeButlerRuntime('pi'), true);
  assert.equal(isNativeButlerRuntime('none'), false);

  assert.equal(
    selectStartupAiRuntimeProvider('pi', { pi: true }),
    'pi',
  );
  assert.equal(
    selectStartupAiRuntimeProvider(undefined, { pi: true }),
    'pi',
  );

  const features = runtimeFeatures('standard', 'pi');
  assert.equal(features.ai, true);
  assert.equal(features.butler, true);
  assert.equal(features.sharedAgent, true);
  assert.equal(features.runtimeProbes, true);
  assert.equal(features.routines, true);

  const controlOwned = evaluateSessionControlMode({
    runtime: 'pi',
    nativeSessionId: 'pi-thread-1',
    origin: 'rocketx_managed',
    workspaceRoot: 'd:/Repos/rocketchatx',
    workspaceExists: true,
    hasOwnedLiveController: true,
    currentDeviceId: 'dev-1',
  });
  assert.equal(controlOwned.controlMode, 'controllable');

  const controlResumable = evaluateSessionControlMode({
    runtime: 'pi',
    nativeSessionId: 'pi-thread-2',
    origin: 'rocketx_managed',
    workspaceRoot: 'd:/Repos/rocketchatx',
    workspaceExists: true,
    hasOwnedLiveController: false,
    currentDeviceId: 'dev-1',
  });
  assert.equal(controlResumable.controlMode, 'resumable');

  resetAiRuntimeProviderForTests('none');
  const storage = memoryStorage({
    [AI_RUNTIME_PROVIDER_STORAGE_KEY]: 'pi',
    [PI_CONFIGURED_STORAGE_KEY]: '1',
  });
  const calls: string[] = [];
  const active = await initializeStartupAiRuntimeProvider({
    desktop: true,
    storage,
    invokeRuntime: async <T>(command: string): Promise<T> => {
      calls.push(command);
      return { ready: true } as T;
    },
  });
  assert.equal(active, 'pi');
  assert.deepEqual(calls, ['pi_runtime_probe']);
  assert.equal(getAiRuntimeStartupResolution().source, 'explicit');
});

test('pi_app_server.mjs 基于真实 @earendil-works/pi-coding-agent 走通握手、Skill、动态工具桥与流式 Turn 全闭环', async () => {
  // Local mock OpenAI-compatible SSE gateway to exercise a real Pi AgentSession turn + dynamic tool call!
  let llmCallCount = 0;
  const mockGateway = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    llmCallCount += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (llmCallCount === 1) {
      // First call: invoke RocketX dynamic tool `butler_list_work_cards`
      const chunk1 = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_kanban_1',
                  type: 'function',
                  function: { name: 'butler_list_work_cards', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      const chunk2 = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      };
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // Second call after receiving tool result: stream assistant final markdown answer
      assert.match(body, /Issue #400 Super Agent/);
      const chunk1 = {
        id: 'chatcmpl-2',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta: { role: 'assistant', content: '已读取看板：' }, finish_reason: null }],
      };
      const chunk2 = {
        id: 'chatcmpl-2',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta: { content: '共 1 张进行中卡片（Issue #400 Super Agent）。' }, finish_reason: null }],
      };
      const chunk3 = {
        id: 'chatcmpl-2',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
      res.write(`data: ${JSON.stringify(chunk3)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  await new Promise<void>((resolve) => mockGateway.listen(0, '127.0.0.1', resolve));
  const address = mockGateway.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-pi-rpc-test-'));
  const agentDir = path.join(tempRoot, 'agent');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const skillsDir = path.join(tempRoot, 'extra-skills');
  const demoSkillDir = path.join(skillsDir, 'rcx-test-skill');
  const configFile = path.join(tempRoot, 'rocketx-pi-config.json');

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(demoSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(demoSkillDir, 'SKILL.md'),
    [
      '---',
      'name: rcx-test-skill',
      'description: RocketX integration test skill loaded by Pi ResourceLoader',
      '---',
      '# RocketX Test Skill',
      'Verify skill discovery via skills/extraRoots/set.',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      provider: 'deepseek',
      baseUrl,
      apiKey: 'sk-test-pi-integration-key',
      defaultModel: 'deepseek-chat',
      extraModels: ['deepseek-reasoner', 'qwen-plus'],
    }),
    'utf8',
  );

  const serverScript = path.resolve('apps/desktop/src-tauri/src/pi_app_server.mjs');
  const piPackageDir = path.resolve('apps/pi-runtime/node_modules/@earendil-works/pi-coding-agent');
  assert.ok(fs.existsSync(serverScript), 'pi_app_server.mjs should exist');
  assert.ok(fs.existsSync(piPackageDir), 'pi-coding-agent package should be installed');

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
    {
      cwd: workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  const notifications: Array<{ method: string; params: any }> = [];
  let dynamicToolCalls = 0;
  const stopChild = prepareFixtureChildStop(child);
  let turnCompletedResolve: ((turn: any) => void) | null = null;
  let stderrOutput = '';

  child.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString('utf8');
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const frame = JSON.parse(trimmed);
    if (typeof frame.id === 'number' && pending.has(frame.id)) {
      const waiter = pending.get(frame.id)!;
      pending.delete(frame.id);
      if (frame.error) {
        waiter.reject(new Error(frame.error.message || JSON.stringify(frame.error)));
      } else {
        waiter.resolve(frame.result);
      }
    } else if (frame.id !== undefined && typeof frame.method === 'string') {
      // Server-to-host RPC request (e.g., item/tool/call)
      if (frame.method === 'item/tool/call') {
        dynamicToolCalls += 1;
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            success: true,
            contentItems: [
              { type: 'inputText', text: JSON.stringify([{ id: 'card-1', title: 'Issue #400 Super Agent', stage: 'in_progress' }]) },
            ],
          },
        })}\n`);
      }
    } else if (typeof frame.method === 'string' && frame.id === undefined) {
      notifications.push({ method: frame.method, params: frame.params });
      if (frame.method === 'turn/completed' && turnCompletedResolve) {
        turnCompletedResolve(frame.params.turn);
        turnCompletedResolve = null;
      }
    }
  });

  let reqSeq = 1;
  const request = <T = any>(method: string, params: unknown = {}): Promise<T> => {
    const id = reqSeq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout on ${method}. stderr: ${stderrOutput}`));
      }, 15_000);
      pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  try {
    const init = await request('initialize', {
      clientInfo: { name: 'rocketx', title: 'RocketX', version: '0.44.18' },
      capabilities: { experimentalApi: true },
    });
    assert.match(init.userAgent, /^rocketx\/1\.5\.0/);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    const perms = await request('permissionProfile/list', { cwd: workspaceDir });
    assert.equal(perms.data.length, 2);
    assert.ok(perms.data.every((p: any) => p.allowed === true));

    const modelsResp = await request('model/list', { includeHidden: false });
    assert.ok(modelsResp.data.length >= 3);
    const defaultModel = modelsResp.data.find((m: any) => m.isDefault);
    assert.equal(defaultModel?.model, 'deepseek/deepseek-chat');
    const reasoner = modelsResp.data.find((m: any) => m.model === 'deepseek/deepseek-reasoner');
    assert.ok(reasoner, 'deepseek/deepseek-reasoner should be listed');
    assert.ok(reasoner.supportedReasoningEfforts.length >= 3);

    await request('skills/extraRoots/set', { extraRoots: [skillsDir] });
    const skillsResp = await request('skills/list', { cwds: [workspaceDir], forceReload: true });
    const allSkills = skillsResp.data.flatMap((entry: any) => entry.skills);
    assert.ok(
      allSkills.some((s: any) => s.name === 'rcx-test-skill'),
      `Expected rcx-test-skill in ${JSON.stringify(allSkills.map((s: any) => s.name))}`,
    );

    const started = await request('thread/start', {
      cwd: workspaceDir,
      model: 'deepseek/deepseek-chat',
      approvalPolicy: 'on-request',
      dynamicTools: [
        {
          name: 'butler_list_work_cards',
          description: 'List Kanban work cards',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    const threadId = started.thread.id;
    assert.ok(typeof threadId === 'string' && threadId.length > 0);
    assert.ok(notifications.some((n) => n.method === 'thread/started' && n.params?.thread?.id === threadId));

    // Execute a real streaming turn with dynamic host tool execution!
    const completedPromise = new Promise<any>((resolve) => {
      turnCompletedResolve = resolve;
    });
    const turnStart = await request('turn/start', {
      threadId,
      model: 'deepseek/deepseek-chat',
      input: [{ type: 'text', text: '请查看当前统一看板有哪些任务', text_elements: [] }],
    });
    assert.ok(turnStart.turn.id);
    const completedTurn = await completedPromise;
    assert.equal(completedTurn.status, 'completed', `Turn failed: ${JSON.stringify(completedTurn.error)} | stderr: ${stderrOutput}`);
    assert.equal(dynamicToolCalls, 1);

    const deltaTexts = notifications
      .filter((n) => n.method === 'item/agentMessage/delta')
      .map((n) => n.params.delta)
      .join('');
    assert.match(deltaTexts, /Issue #400 Super Agent/);

    await request('thread/name/set', { threadId, name: 'Pi 原生三栏测试任务' });

    const listed = await request('thread/list', { cwd: workspaceDir });
    const found = listed.data.find((t: any) => t.id === threadId);
    assert.ok(found, 'Created Pi thread should be returned by thread/list');
    assert.equal(found.name, 'Pi 原生三栏测试任务');

    const loaded = await request('thread/read', { threadId, includeTurns: true });
    assert.equal(loaded.thread.id, threadId);
    assert.equal(loaded.thread.name, 'Pi 原生三栏测试任务');
    assert.ok(loaded.thread.turns.length >= 1, 'Persisted turn should be readable via thread/read');

    await request('thread/archive', { threadId });
    const afterArchive = await request('thread/list', { cwd: workspaceDir });
    assert.ok(!afterArchive.data.some((t: any) => t.id === threadId));
  } finally {
    rl.close();
    try {
      await stopChild();
    } finally {
      mockGateway.close();
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('Pi Super Agent 完整支持流式思维链(reasoning_content)、中途中断(turn/interrupt)与现代化模型目录映射', async () => {
  let llmCallCount = 0;
  let activeRes: http.ServerResponse | null = null;

  const mockGateway = http.createServer(async (req, res) => {
    llmCallCount += 1;
    const currentCall = llmCallCount;
    activeRes = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (currentCall === 1) {
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-stream-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-pro',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: '第一步：分析任务需求；' },
            finish_reason: null,
          },
        ],
      })}\n\n`);

      setTimeout(() => {
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-stream-1',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-v4-pro',
          choices: [
            {
              index: 0,
              delta: { reasoning_content: '第二步：得出验证结论。' },
              finish_reason: null,
            },
          ],
        })}\n\n`);

        setTimeout(() => {
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-stream-1',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'deepseek-v4-pro',
            choices: [
              {
                index: 0,
                delta: { content: '思维链验证完成，准备执行。' },
                finish_reason: null,
              },
            ],
          })}\n\n`);

          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-stream-1',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'deepseek-v4-pro',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }, 30);
      }, 30);
    } else {
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-stream-2',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-pro',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '正在执行耗时任务，等待中断信号...' },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      req.on('close', () => {
        try {
          res.end();
        } catch {}
      });
    }
  });

  await new Promise<void>((resolve) => mockGateway.listen(0, '127.0.0.1', resolve));
  const address = mockGateway.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-pi-stream-test-'));
  const agentDir = path.join(tempRoot, 'agent');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const configFile = path.join(tempRoot, 'rocketx-pi-config.json');

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      provider: 'custom-openai',
      baseUrl,
      apiKey: 'sk-test-custom-gateway',
      defaultModel: 'deepseek-v4-pro',
      extraModels: [
        'deepseek-v4-flash',
        'claude-sonnet-5.5',
        'gpt-6.1-sol',
        'gemini-4-argon',
        'qwen3-coder',
        'custom-intranet-model',
      ],
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
    {
      cwd: workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  const notifications: Array<{ method: string; params: any }> = [];
  let turnCompletedResolve: ((turn: any) => void) | null = null;
  let firstDeltaResolve: (() => void) | null = null;
  const stopChild = prepareFixtureChildStop(child);
  let stderrOutput = '';

  child.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString('utf8');
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const frame = JSON.parse(trimmed);
    if (typeof frame.id === 'number' && pending.has(frame.id)) {
      const waiter = pending.get(frame.id)!;
      pending.delete(frame.id);
      if (frame.error) {
        waiter.reject(new Error(frame.error.message || JSON.stringify(frame.error)));
      } else {
        waiter.resolve(frame.result);
      }
    } else if (typeof frame.method === 'string' && frame.id === undefined) {
      notifications.push({ method: frame.method, params: frame.params });
      if (frame.method === 'item/agentMessage/delta' && firstDeltaResolve) {
        firstDeltaResolve();
        firstDeltaResolve = null;
      }
      if (frame.method === 'turn/completed' && turnCompletedResolve) {
        turnCompletedResolve(frame.params.turn);
        turnCompletedResolve = null;
      }
    }
  });

  let reqSeq = 1;
  const request = <T = any>(method: string, params: unknown = {}): Promise<T> => {
    const id = reqSeq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout on ${method}. stderr: ${stderrOutput}`));
      }, 15_000);
      pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
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

    const modelsResp = await request('model/list', { includeHidden: false });
    const modelIds = modelsResp.data.map((m: any) => m.model);
    assert.ok(modelIds.includes('custom-openai/deepseek-v4-pro'), 'DeepSeek V4 Pro should be in catalog');
    assert.ok(modelIds.includes('custom-openai/deepseek-v4-flash'), 'DeepSeek V4 Flash should be in catalog');
    assert.ok(modelIds.includes('custom-openai/claude-sonnet-5.5'), 'Claude Sonnet 5.5 should be in catalog');
    assert.ok(modelIds.includes('custom-openai/gpt-6.1-sol'), 'GPT-6.1 Sol should be in catalog');
    assert.ok(modelIds.includes('custom-openai/gemini-4-argon'), 'Gemini 4 Argon should be in catalog');
    assert.ok(modelIds.includes('custom-openai/qwen3-coder'), 'Qwen 3 Coder should be in catalog');
    assert.ok(modelIds.includes('custom-openai/custom-intranet-model'), 'Custom intranet model should be preserved');

    const v4ProModel = modelsResp.data.find((m: any) => m.model === 'custom-openai/deepseek-v4-pro');
    assert.equal(v4ProModel.canReason, true);
    assert.equal(v4ProModel.isDefault, true);

    const started = await request('thread/start', {
      cwd: workspaceDir,
      model: 'custom-openai/deepseek-v4-pro',
      approvalPolicy: 'on-request',
    });
    const threadId = started.thread.id;

    let completedPromise = new Promise<any>((resolve) => {
      turnCompletedResolve = resolve;
    });
    const turn1Start = await request('turn/start', {
      threadId,
      model: 'custom-openai/deepseek-v4-pro',
      input: [{ type: 'text', text: '请输出两步思考后回答', text_elements: [] }],
    });
    assert.ok(turn1Start.turn.id);

    const completedTurn1 = await completedPromise;
    assert.equal(completedTurn1.status, 'completed');

    const reasoningStarted = notifications.find(
      (n) => n.method === 'item/started' && n.params?.item?.type === 'reasoning',
    );
    assert.ok(reasoningStarted, 'Expected item/started notification for reasoning item');

    const reasoningDeltas = notifications
      .filter((n) => n.method === 'item/reasoning/textDelta')
      .map((n) => n.params?.delta)
      .join('');
    assert.match(reasoningDeltas, /第一步：分析任务需求；/);
    assert.match(reasoningDeltas, /第二步：得出验证结论。/);

    const reasoningCompleted = notifications.find(
      (n) => n.method === 'item/completed' && n.params?.item?.type === 'reasoning',
    );
    assert.ok(reasoningCompleted, 'Expected item/completed notification for reasoning item');
    assert.match(
      JSON.stringify(reasoningCompleted.params?.item?.content),
      /第一步：分析任务需求；第二步：得出验证结论。/,
    );

    assert.ok(
      completedTurn1.items.some(
        (it: any) => it.type === 'reasoning' && JSON.stringify(it.content).includes('分析任务需求'),
      ),
      'Turn items should preserve reasoning block',
    );

    completedPromise = new Promise<any>((resolve) => {
      turnCompletedResolve = resolve;
    });
    const firstDeltaPromise = new Promise<void>((resolve) => {
      firstDeltaResolve = resolve;
    });

    const turn2Start = await request('turn/start', {
      threadId,
      model: 'custom-openai/deepseek-v4-pro',
      input: [{ type: 'text', text: '执行耗时任务，稍后触发中断', text_elements: [] }],
    });
    const turn2Id = turn2Start.turn.id;

    await firstDeltaPromise;

    const interruptResult = await request('turn/interrupt', {
      threadId,
      turnId: turn2Id,
    });
    assert.ok(interruptResult, 'Interrupt should return success object');

    const completedTurn2 = await completedPromise;
    assert.equal(completedTurn2.status, 'interrupted', `Expected turn to be interrupted, got ${completedTurn2.status}`);
  } finally {
    if (activeRes) {
      try {
        activeRes.end();
      } catch {}
    }
    rl.close();
    try {
      await stopChild();
    } finally {
      mockGateway.close();
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('Pi 原生进程异常退出时结构化 diagnostics 诊断信息完整透传且不崩溃', async () => {
  const mockTransport: CodexTransport = {
    start: async (handlers) => {
      setTimeout(() => {
        handlers.onExit(1, 'Pi runtime encountered ECONNREFUSED connecting to Ollama at http://127.0.0.1:11434');
      }, 10);
      return {
        processId: 'pi-mock-proc',
        version: '1.5.0',
        runtimeSource: 'bundled',
        managedSkillRoots: [],
      };
    },
    write: async () => {},
    stop: async () => {},
  };

  const client = new AppServerClient(mockTransport);

  await assert.rejects(
    async () => {
      await client.start();
    },
    (err: Error) => {
      assert.match(err.message, /ECONNREFUSED connecting to Ollama/);
      return true;
    },
  );
});

test('零登录本地模式工作区自动水合与设置页 Pi 配置闭环契约', () => {
  const history = fs.readFileSync('apps/web/src/components/ButlerConversationHistory.tsx', 'utf8');
  const settings = fs.readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');
  const conversation = fs.readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');

  assert.match(history, /'local:workspace'/);
  assert.match(history, /const nativeRuntime = piRuntime/);
  assert.match(settings, /Pi（内建通用引擎）/);
  assert.match(settings, /保存配置并立即启用 Pi/);
  assert.match(settings, /writePiConfig/);
  assert.match(settings, /reconnectRuntime/);
  assert.match(conversation, /const isPi = aiRuntimeProvider === 'pi'/);
});
