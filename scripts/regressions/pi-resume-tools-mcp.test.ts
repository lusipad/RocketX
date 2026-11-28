import '../../apps/web/src/agent/acpButlerWiring';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';
import test from 'node:test';
import {
  executeRocketxDynamicTool,
  ROCKETX_DYNAMIC_TOOLS,
} from '../../apps/web/src/agent/codexHostTools';
import { createExternalActionExecutor } from '../../apps/web/src/agent/externalActionExecutor';
import type { NativeDispatchActionRecord, NativeWorkCard } from '../../apps/web/src/platform/desktopCommands';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';

interface JsonRpcResponse {
  id: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

test('pi_app_server keeps initialize/model/list offline and lazily wires resumed/forked dynamicTools + MCP on turn start', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rcx-pi-resume-'));
  const piPkgDir = path.resolve(process.cwd(), 'apps', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const scriptPath = path.resolve(process.cwd(), 'apps', 'desktop', 'src-tauri', 'src', 'pi_app_server.mjs');
  const agentDir = path.join(tempRoot, 'agent');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const configPath = path.join(tempRoot, 'pi-config.json');
  const mockMcpScript = path.join(tempRoot, 'mock-mcp.mjs');
  const mcpMarker = path.join(tempRoot, 'mcp-started.txt');

  let llmCallCount = 0;
  let lastBody = '';
  let observedToolNames: string[] = [];
  let sawMcpToolSchema = false;
  let sawDynamicToolSchema = false;
  let sawMcpCallResultInNextPrompt = false;
  let sawDynamicToolResultInFinalPrompt = false;

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
      try {
        const parsedBody = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> };
        observedToolNames = (parsedBody.tools ?? []).map((item) => item.function?.name ?? item.name ?? '').filter(Boolean);
      } catch {
        observedToolNames = [];
      }
      sawMcpToolSchema = body.includes('mcp__demo__ping');
      sawDynamicToolSchema = body.includes('list_work_cards');
      res.write(`data: ${JSON.stringify({
        id: 'cmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_mcp_1',
              type: 'function',
              function: { name: 'mcp__demo__ping', arguments: '{"msg":"hi"}' },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'cmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (llmCallCount === 2) {
      sawMcpCallResultInNextPrompt = body.includes('pong-from-mock-mcp') && body.includes('envLeaked=false');
      res.write(`data: ${JSON.stringify({
        id: 'cmpl-2',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_dyn_1',
              type: 'function',
              function: { name: 'list_work_cards', arguments: '{}' },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'cmpl-2',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    lastBody = body;
    sawDynamicToolResultInFinalPrompt = body.includes('card-from-fork');
    res.write(`data: ${JSON.stringify({
      id: 'cmpl-3',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Verified MCP + DynamicTools.' }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'cmpl-3',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise<void>((resolve) => mockGateway.listen(0, '127.0.0.1', resolve));
  const addr = mockGateway.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}/v1`;

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    provider: 'custom-openai',
    baseUrl,
    defaultModel: 'deepseek-v4-flash',
    extraModels: [],
  }));
  writeFileSync(mockMcpScript, [
    "import * as fs from 'node:fs';",
    "import * as readline from 'node:readline';",
    `fs.writeFileSync(${JSON.stringify(mcpMarker)}, 'started');`,
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "rl.on('line', (line) => {",
    "  const req = JSON.parse(line);",
    "  if (req.method === 'initialize') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n');",
    "  } else if (req.method === 'tools/list') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] } }) + '\\n');",
    "  } else if (req.method === 'tools/call') {",
    "    const leaked = Boolean(process.env.ROCKETX_PI_API_KEY);",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `pong-from-mock-mcp envLeaked=${leaked}` }] } }) + '\\n');",
    "  }",
    "});",
  ].join('\n'));

  const child = spawn(process.execPath, [
    scriptPath,
    '--pi-package-dir', piPkgDir,
    '--agent-dir', agentDir,
    '--config-file', configPath,
    '--workspace-root', workspaceDir,
  ], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      ROCKETX_PI_API_KEY: 'sk-test-secret-do-not-leak',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<string, { resolve: (msg: JsonRpcResponse) => void; reject: (err: Error) => void }>();
  let nextId = 1;
  let dynamicCalls = 0;
  let turnDoneResolve: ((turn: Record<string, unknown>) => void) | null = null;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return;
    }
    if (parsed.id !== undefined && !parsed.method && pending.has(String(parsed.id))) {
      const entry = pending.get(String(parsed.id))!;
      pending.delete(String(parsed.id));
      entry.resolve(parsed);
      return;
    }
    if (parsed.id !== undefined && parsed.method === 'item/tool/call') {
      dynamicCalls += 1;
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify([{ id: 'card-from-fork', title: 'Restored Dynamic Tool' }]) }],
        },
      })}\n`);
      return;
    }
    if (parsed.method === 'turn/completed' && turnDoneResolve) {
      turnDoneResolve((parsed.params?.turn ?? {}) as Record<string, unknown>);
      turnDoneResolve = null;
    }
  });

  function callRpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`RPC timeout: ${method}${stderr ? `\nstderr:\n${stderr}` : ''}`));
      }, 10_000);
      pending.set(String(id), {
        resolve: (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(`${method} error: ${msg.error.message}`));
          else resolve(msg.result ?? {});
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  try {
    const init = await callRpc('initialize', { clientInfo: { name: 'test', title: 'test', version: '1.0.0' } });
    assert.ok(init.userAgent);
    const models = await callRpc('model/list', { includeHidden: false });
    assert.ok(Array.isArray(models.data) && models.data.length > 0);
    assert.equal(existsSync(mcpMarker), false, 'MCP server must not start during initialize or model/list');

    const started = await callRpc('thread/start', {
      cwd: workspaceDir,
      dynamicTools: ROCKETX_DYNAMIC_TOOLS.slice(0, 1),
      config: {
        mcp_servers: {
          demo: { command: process.execPath, args: [mockMcpScript] },
        },
      },
    });
    const threadId = (started.thread as { id: string }).id;
    assert.ok(threadId);
    assert.equal(existsSync(mcpMarker), false, 'MCP server must stay lazy before any turn runs');

    await callRpc('thread/resume', {
      threadId,
      dynamicTools: ROCKETX_DYNAMIC_TOOLS,
      config: {
        mcp_servers: {
          demo: { command: process.execPath, args: [mockMcpScript] },
        },
      },
    });

    const forked = await callRpc('thread/fork', {
      threadId,
      cwd: workspaceDir,
    });
    const forkedId = (forked.thread as { id: string }).id;
    assert.ok(forkedId && forkedId !== threadId);

    const turnFinished = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`turn/completed timeout\nstderr:\n${stderr}`)), 15_000);
      turnDoneResolve = (turn) => {
        clearTimeout(timer);
        resolve(turn);
      };
    });

    await callRpc('turn/start', {
      threadId: forkedId,
      input: [{ type: 'text', text: 'Call ping then list_work_cards' }],
      model: 'deepseek-v4-flash',
    });

    const turn = await turnFinished;
    assert.equal(turn.status, 'completed');
    assert.equal(existsSync(mcpMarker), true, `MCP server must initialize lazily on first turn; stderr=${stderr}`);
    assert.equal(sawMcpToolSchema, true, `Expected mcp__demo__ping in tools=[${observedToolNames.join(', ')}]; stderr=${stderr}`);
    assert.equal(sawDynamicToolSchema, true, `Expected dynamic tool in tools=[${observedToolNames.join(', ')}]; stderr=${stderr}`);
    assert.ok(sawMcpCallResultInNextPrompt, `Expected pong in prompt 2; lastBody=${lastBody}; stderr=${stderr}`);
    assert.ok(sawDynamicToolResultInFinalPrompt, `Expected card-from-fork in prompt 3 (calls=${llmCallCount}, dynamicCalls=${dynamicCalls}); msgs=${JSON.stringify((JSON.parse(lastBody).messages ?? []))}; stderr=${stderr}`);
    assert.equal(dynamicCalls, 1);

    const metaPath = path.join(agentDir, 'rocketx-thread-meta.json');
    if (existsSync(metaPath)) {
      const metaRaw = readFileSync(metaPath, 'utf8');
      assert.ok(metaRaw.includes(forkedId));
    }
  } finally {
    rl.close();
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
    mockGateway.close();
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore transient Windows handle teardown delay in temp dir cleanup
    }
  }
});

test('acp_dispatch_task respects custom title and caps autonomyMode below card ceiling', async () => {
  const prevWork = useWorkLedger.getState();
  const prevAcp = useAcpAgents.getState();
  let capturedAction: { specJson: string; requireConfirmation: boolean } | null = null;

  const card: NativeWorkCard = {
    id: 'todo-cap-1',
    source: 'manual',
    title: 'Original Card Title',
    done: false,
    priority: 2,
    state: {
      todoId: 'todo-cap-1',
      stage: 'ready',
      waitState: 'none',
      autonomyMode: 'confirm',
      goal: 'Investigate caching bug',
      acceptance: ['Reproduction test passes'],
      boundaries: ['Do not edit auth config'],
      requirementsVersion: 2,
      contentVersion: 3,
      updatedAt: Date.now(),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  useWorkLedger.setState({
    cards: [card],
    links: [{ id: 'link-1', todoId: card.id, kind: 'kanban_card', stateSnapshot: 'workspace', repo: '/tmp/repo-cap', createdAt: Date.now(), updatedAt: Date.now() } as typeof prevWork.links[number]],
    sessions: [],
    prepareDispatchAction: async (input) => {
      capturedAction = {
        specJson: String(input.specJson),
        requireConfirmation: Boolean(input.requireConfirmation),
      };
      return {
        id: 'act-acp-1',
        todoId: card.id,
        idempotencyKey: input.idempotencyKey,
        actionKind: input.actionKind,
        specJson: input.specJson,
        state: input.requireConfirmation ? 'awaiting_approval' : 'prepared',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
  });
  useAcpAgents.setState({
    agents: [{
      id: 'acp-codex',
      name: 'Codex ACP',
      preset: 'codex',
      command: 'codex-acp',
      args: [],
      env: {},
      enabled: true,
      autoApproveSafeReads: true,
    }],
  });

  try {
    const escalated = await executeRocketxDynamicTool({
      tool: 'acp_dispatch_task',
      arguments: {
        todoId: card.id,
        prompt: 'Check cache eviction path',
        requestId: 'req-escalate',
        title: 'Custom Delegated Slice',
        autonomyMode: 'autonomous',
      },
    });
    const payload1 = JSON.parse(escalated.contentItems[0]?.text ?? '{}') as Record<string, unknown>;
    assert.equal(payload1.title, 'Custom Delegated Slice');
    assert.equal(payload1.autonomyMode, 'confirm');
    assert.equal(capturedAction?.requireConfirmation, true);

    const narrowed = await executeRocketxDynamicTool({
      tool: 'acp_dispatch_task',
      arguments: {
        todoId: card.id,
        prompt: 'Read-only scan',
        requestId: 'req-narrow',
        autonomyMode: 'readonly',
      },
    });
    const payload2 = JSON.parse(narrowed.contentItems[0]?.text ?? '{}') as Record<string, unknown>;
    assert.equal(payload2.autonomyMode, 'readonly');
    assert.equal(JSON.parse(capturedAction?.specJson ?? '{}').autonomyMode, 'readonly');
  } finally {
    useWorkLedger.setState({
      cards: prevWork.cards,
      links: prevWork.links,
      sessions: prevWork.sessions,
      prepareDispatchAction: prevWork.prepareDispatchAction,
    });
    useAcpAgents.setState({ agents: prevAcp.agents });
  }
});

test('externalActionExecutor executes ado_comment via writeAdoComment with receipt', async () => {
  let savedAction: NativeDispatchActionRecord | null = null;
  let commentedText = '';
  const executor = createExternalActionExecutor({
    prepare: async (spec, approved) => {
      savedAction = {
        id: 'act-comment-1',
        todoId: spec.workId,
        idempotencyKey: spec.operationId,
        actionKind: spec.kind,
        specJson: JSON.stringify(spec),
        state: approved ? 'prepared' : 'awaiting_approval',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      return savedAction;
    },
    transition: async (action, state, receipt, error) => {
      savedAction = {
        ...action,
        state,
        receiptRef: receipt ? JSON.stringify(receipt) : action.receiptRef,
        errorMessage: error,
        updatedAt: Date.now(),
      };
      return savedAction;
    },
    validate: async () => undefined,
    writeAdo: async () => {
      throw new Error('writeAdo should not be called for ado_comment');
    },
    writeAdoComment: async (spec) => {
      commentedText = spec.commentText;
      return { revision: 12, state: 'Active' };
    },
    readAdo: async () => ({ revision: 12, state: 'Active' }),
    sendMessage: async () => {
      throw new Error('sendMessage should not be called');
    },
    readMessage: async () => null,
    isUnknownAdoError: () => false,
  });

  const result = await executor.execute({
    version: 1,
    kind: 'ado_comment',
    workId: 'todo-1',
    operationId: 'op-comment-1',
    requirementsVersion: 1,
    actor: { userId: 'u1', server: 'https://rc.example' },
    adoBase: 'https://dev.azure.com/org/proj',
    workItemId: 4242,
    commentText: 'Root cause verified with regression suite.',
    expectedRevision: 11,
  }, true);

  assert.equal(commentedText, 'Root cause verified with regression suite.');
  assert.equal(result.state, 'acknowledged');
  assert.match(result.receiptRef ?? '', /"revision":12/);
});
