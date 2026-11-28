import '../../apps/web/src/agent/acpButlerWiring';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import test from 'node:test';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const shim = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
  return shim;
}

installMemoryLocalStorage();

import { AcpController } from '../../apps/web/src/agent/acp/AcpController';
import { JsonRpcAcpClient } from '../../apps/web/src/agent/acp/acpClient';
import type {
  AcpSessionUpdateNotificationParams,
  AcpTransport,
  AcpTransportExitHandler,
  AcpTransportLineHandler,
} from '../../apps/web/src/agent/acp/acpTypes';
import { buildWorkflowExecutionReport } from '../../apps/web/src/agent/workflowReport';
import {
  ACP_PRESET_TEMPLATES,
  evaluateAcpPermissionPolicy,
  useAcpAgents,
} from '../../apps/web/src/stores/acpAgents';
import { useTodos } from '../../apps/web/src/stores/todos';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';

const MOCK_ACP_AGENT_SCRIPT = `
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextHostReqId = 1;
const pendingHostRequests = new Map();
let currentMode = 'code';
let activePrompt = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

function notifySessionUpdate(sessionId, update) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  });
}

function requestHost(method, params) {
  const id = 'host-' + nextHostReqId++;
  return new Promise((resolve, reject) => {
    pendingHostRequests.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

async function handleRequest(req) {
  const { id, method, params = {} } = req;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'mock-acp-agent', title: 'Mock ACP Agent', version: '1.0.0' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true },
        },
        receivedClientFsRead: Boolean(params?.clientCapabilities?.fs?.readTextFile),
      },
    });
    return;
  }

  if (method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId: 'acp-sess-1',
        modes: {
          currentModeId: currentMode,
          availableModes: [
            { id: 'code', name: 'Code' },
            { id: 'architect', name: 'Architect' },
          ],
        },
        models: {
          currentModelId: 'mock-model-v1',
          availableModels: [{ id: 'mock-model-v1', name: 'Mock Model v1' }],
        },
      },
    });
    return;
  }

  if (method === 'session/set_mode') {
    currentMode = params.modeId || currentMode;
    notifySessionUpdate(params.sessionId, {
      sessionUpdate: 'current_mode_update',
      currentModeId: currentMode,
    });
    send({ jsonrpc: '2.0', id, result: { ok: true, modeId: currentMode } });
    return;
  }

  if (method === 'session/prompt') {
    const sessionId = params.sessionId;
    const text = (params.prompt || []).map((b) => b.text || '').join('\\n');

    if (text.includes('slow_cancel')) {
      notifySessionUpdate(sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Starting long task...' },
      });
      activePrompt = { id, sessionId };
      return;
    }

    notifySessionUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Inspecting workspace context. ' },
    });
    notifySessionUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Preparing execution plan.' },
    });
    notifySessionUpdate(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read project readme', priority: 'high', status: 'in_progress' },
        { content: 'Apply requested edit', priority: 'medium', status: 'pending' },
      ],
    });

    if (text.includes('read_and_report')) {
      notifySessionUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-read-1',
        title: 'Read README.md',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: 'README.md', line: 1 }],
      });
      const fileRes = await requestHost('fs/read_text_file', {
        sessionId,
        path: 'README.md',
        line: 1,
        limit: 10,
      });
      notifySessionUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-read-1',
        status: 'completed',
        rawOutput: fileRes.content,
      });
      notifySessionUpdate(sessionId, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read project readme', priority: 'high', status: 'completed' },
          { content: 'Apply requested edit', priority: 'medium', status: 'completed' },
        ],
      });
      notifySessionUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Read file content: ' + fileRes.content.trim() },
      });
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text.includes('run_with_permission')) {
      notifySessionUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-edit-1',
        title: 'Write config.json',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: 'config.json', line: 3 }],
      });

      const permRes = await requestHost('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: 'tc-edit-1',
          title: 'Write config.json',
          kind: 'edit',
          status: 'pending',
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        ],
      });

      const approved =
        permRes?.outcome?.outcome === 'selected' && permRes.outcome.optionId === 'allow_once';

      notifySessionUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-edit-1',
        status: approved ? 'completed' : 'failed',
      });
      notifySessionUpdate(sessionId, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read project readme', priority: 'high', status: 'completed' },
          {
            content: 'Apply requested edit',
            priority: 'medium',
            status: approved ? 'completed' : 'pending',
          },
        ],
      });
      notifySessionUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: approved ? 'Permission approved: edit applied.' : 'Permission rejected: edit aborted.',
        },
      });
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      return;
    }

    notifySessionUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Echo: ' + text },
    });
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    return;
  }

  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found: ' + method },
  });
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.id !== undefined && msg.method === undefined) {
    const pending = pendingHostRequests.get(String(msg.id));
    if (pending) {
      pendingHostRequests.delete(String(msg.id));
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
    return;
  }
  if (msg.method === 'session/cancel' && activePrompt) {
    const pending = activePrompt;
    activePrompt = null;
    send({ jsonrpc: '2.0', id: pending.id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (msg.id !== undefined && msg.method) {
    void handleRequest(msg);
  }
});
`;

class NodeChildProcessAcpTransport implements AcpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineHandlers = new Set<AcpTransportLineHandler>();
  private exitHandlers = new Set<AcpTransportExitHandler>();
  private rl: readline.Interface | null = null;

  constructor(
    private readonly scriptPath: string,
    private readonly args: string[] = [],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(process.execPath, [this.scriptPath, ...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });
    this.child = child;
    this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      for (const handler of this.lineHandlers) {
        handler(line);
      }
    });
    child.on('exit', (code, signal) => {
      const reason = signal ? `signal:${signal}` : undefined;
      for (const handler of this.exitHandlers) {
        handler(code, reason);
      }
    });
  }

  async sendLine(line: string): Promise<void> {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error('Child ACP process stdin is not writable');
    }
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(`${line}\n`, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      child.kill();
    }
  }

  onLine(handler: AcpTransportLineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onExit(handler: AcpTransportExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }
}

async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  timeoutMs = 5000,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('JsonRpcAcpClient: 真实子进程 NDJSON 握手、双向 fs/read_text_file、set_mode 与 session/cancel 全流程', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-acp-client-'));
  const scriptPath = path.join(tempDir, 'mock-acp-agent.mjs');
  const readmePath = path.join(tempDir, 'README.md');
  fs.writeFileSync(scriptPath, MOCK_ACP_AGENT_SCRIPT, 'utf8');
  fs.writeFileSync(readmePath, 'RocketX ACP Integration Works\nSecond line', 'utf8');

  const updates: AcpSessionUpdateNotificationParams[] = [];
  const transport = new NodeChildProcessAcpTransport(scriptPath);
  const client = new JsonRpcAcpClient(transport, {
    requestTimeoutMs: 5000,
    promptTimeoutMs: 5000,
    hostHandlers: {
      readTextFile: async (params) => {
        const resolved = path.resolve(tempDir, params.path);
        assert.equal(resolved, readmePath);
        const content = fs.readFileSync(resolved, 'utf8');
        const lines = content.split(/\r?\n/);
        const start = Math.max(0, (params.line ?? 1) - 1);
        const end = params.limit ? start + params.limit : lines.length;
        return { content: lines.slice(start, end).join('\n') };
      },
    },
    onSessionUpdate: (params) => updates.push(params),
  });

  try {
    const init = await client.initialize();
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentInfo?.name, 'mock-acp-agent');
    assert.equal(init.agentCapabilities?.loadSession, true);
    assert.equal((init as unknown as Record<string, unknown>).receivedClientFsRead, true);
    assert.equal(client.serverCapabilities?.protocolVersion, 1);

    const sess = await client.sessionNew({ cwd: tempDir, mcpServers: [] });
    assert.equal(sess.sessionId, 'acp-sess-1');
    assert.equal(sess.modes?.currentModeId, 'code');

    await client.sessionSetMode({ sessionId: sess.sessionId, modeId: 'architect' });
    assert.ok(
      updates.some(
        (u) =>
          u.update.sessionUpdate === 'current_mode_update' &&
          u.update.currentModeId === 'architect',
      ),
    );

    const promptRes = await client.sessionPrompt({
      sessionId: sess.sessionId,
      prompt: [{ type: 'text', text: 'please read_and_report' }],
    });
    assert.equal(promptRes.stopReason, 'end_turn');

    assert.ok(updates.some((u) => u.update.sessionUpdate === 'agent_thought_chunk'));
    assert.ok(updates.some((u) => u.update.sessionUpdate === 'plan'));
    assert.ok(
      updates.some(
        (u) => u.update.sessionUpdate === 'tool_call' && u.update.toolCallId === 'tc-read-1',
      ),
    );
    assert.ok(
      updates.some(
        (u) =>
          u.update.sessionUpdate === 'tool_call_update' &&
          u.update.toolCallId === 'tc-read-1' &&
          u.update.status === 'completed',
      ),
    );
    const msgUpdate = updates.find((u) => u.update.sessionUpdate === 'agent_message_chunk');
    assert.ok(msgUpdate && msgUpdate.update.sessionUpdate === 'agent_message_chunk');
    assert.equal(msgUpdate.update.content.type, 'text');
    assert.ok(msgUpdate.update.content.text.includes('RocketX ACP Integration Works'));

    // Verify session/cancel interrupts an active turn cleanly
    const cancelPromptPromise = client.sessionPrompt({
      sessionId: sess.sessionId,
      prompt: [{ type: 'text', text: 'slow_cancel' }],
    });
    await waitFor(
      () =>
        updates.some(
          (u) =>
            u.update.sessionUpdate === 'agent_thought_chunk' &&
            u.update.content.type === 'text' &&
            u.update.content.text.includes('Starting long task'),
        ),
      3000,
      'slow_cancel thought chunk',
    );
    await client.sessionCancel({ sessionId: sess.sessionId });
    const cancelledRes = await cancelPromptPromise;
    assert.equal(cancelledRes.stopReason, 'cancelled');
  } finally {
    await client.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('useAcpAgents + useWorkLedger + buildWorkflowExecutionReport: 交互式审批(allow_once)与 readonly 自动拒绝闭环', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-acp-store-'));
  const scriptPath = path.join(tempDir, 'mock-acp-agent.mjs');
  fs.writeFileSync(scriptPath, MOCK_ACP_AGENT_SCRIPT, 'utf8');

  // Verify permission policy helper semantics directly
  const samplePermReq = {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', title: 'Write file', kind: 'edit' as const, status: 'pending' as const },
    options: [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' as const },
    ],
  };
  assert.equal(evaluateAcpPermissionPolicy('readonly', samplePermReq).decision, 'reject');
  assert.equal(evaluateAcpPermissionPolicy('confirm', samplePermReq).decision, 'prompt');
  assert.equal(evaluateAcpPermissionPolicy('autonomous', samplePermReq).decision, 'prompt');
  assert.equal(
    evaluateAcpPermissionPolicy('autonomous', {
      sessionId: 's1',
      toolCall: { toolCallId: 't2', title: 'Read package.json', kind: 'read', status: 'pending' },
      options: samplePermReq.options,
    }).decision,
    'allow',
  );

  useTodos.setState({
    todos: [
      {
        id: 'todo-acp-1',
        source: 'manual',
        title: 'ACP Workflow Integration Card',
        note: 'Verify ACP execution report',
        done: false,
        priority: 2,
        createdAt: Date.now(),
      },
    ],
    hydrated: true,
    loading: false,
  });
  useWorkLedger.setState({
    cards: [],
    sessions: [],
    links: [],
    evidences: [],
    dispatchActions: [],
    externalEvents: [],
    hydrated: true,
    loading: false,
    lastError: null,
  });
  useWorkLedger.getState().syncWithTodos();
  useAcpAgents.setState({
    agents: [],
    discovered: [],
    probes: {},
    sessions: {},
    activeSessionKey: null,
    loading: false,
    discovering: false,
    lastError: null,
  });

  try {
    const profile = await useAcpAgents.getState().upsertAgent({
      id: 'acp-node-mock',
      name: 'Node Mock ACP',
      preset: 'custom',
      command: process.execPath,
      args: [scriptPath],
      cwd: tempDir,
      enabled: true,
      autoApproveSafeReads: false,
    });

    // 1. Confirm mode: interactive permission approval via resolvePermission('allow_once')
    const started = await useAcpAgents.getState().startSession({
      agentId: profile.id,
      workspaceRoot: tempDir,
      linkedTodoId: 'todo-acp-1',
      autonomyMode: 'confirm',
      title: 'Confirm ACP Run',
      controllerFactory: (opts) =>
        new AcpController({
          ...opts,
          transport: new NodeChildProcessAcpTransport(scriptPath),
        }),
    });

    assert.equal(started.status, 'ready');
    assert.equal(started.acpSessionId, 'acp-sess-1');

    const ledgerSessionReady = useWorkLedger
      .getState()
      .sessions.find((s) => s.nativeSessionId === 'acp-sess-1');
    assert.ok(ledgerSessionReady);
    assert.equal(ledgerSessionReady.runtime, 'acp');
    assert.equal(ledgerSessionReady.controlMode, 'controllable');
    assert.equal(ledgerSessionReady.todoId, 'todo-acp-1');

    const promptPromise = useAcpAgents
      .getState()
      .sendPrompt(started.sessionKey, 'run_with_permission');

    const pendingReq = await waitFor(() => {
      const s = useAcpAgents.getState().sessions[started.sessionKey];
      return s && s.pendingPermissions.length > 0 ? s.pendingPermissions[0] : null;
    }, 4000, 'pending ACP permission request');

    assert.equal(
      useAcpAgents.getState().sessions[started.sessionKey]?.status,
      'waiting_approval',
    );
    await assert.rejects(useAcpAgents.getState().resolvePermission('another-session', pendingReq.requestId, 'allow_once'), /失效/);
    await assert.rejects(useAcpAgents.getState().resolvePermission(started.sessionKey, pendingReq.requestId, 'not-an-option'), /无效/);
    await useAcpAgents
      .getState()
      .resolvePermission(started.sessionKey, pendingReq.requestId, 'allow_once');

    const promptRes = await promptPromise;
    assert.equal(promptRes.stopReason, 'end_turn');

    const completedSession = useAcpAgents.getState().sessions[started.sessionKey]!;
    assert.equal(completedSession.status, 'ready');
    assert.equal(completedSession.pendingPermissions.length, 0);
    assert.equal(completedSession.turnCount, 1);
    assert.equal(completedSession.toolCalls[0]?.status, 'completed');
    assert.equal(completedSession.plan.length, 2);
    assert.ok(
      completedSession.messages.some(
        (m) =>
          m.role === 'assistant' &&
          m.text.includes('Permission approved: edit applied.') &&
          Boolean(m.thoughts?.includes('Inspecting workspace context.')),
      ),
    );

    const linkedCard = useWorkLedger.getState().cards.find((c) => c.id === 'todo-acp-1')!;
    const report = buildWorkflowExecutionReport({
      card: linkedCard,
      acpSession: completedSession,
      sessions: useWorkLedger.getState().sessions.filter((s) => s.todoId === 'todo-acp-1'),
      evidences: [],
      links: [],
    });
    assert.equal(report.title, 'ACP Workflow Integration Card');
    assert.equal(report.status, 'in_progress');
    assert.equal(report.progressPercent, 100);
    assert.equal(report.planBreakdown.length, 2);
    assert.equal(report.keyChanges[0]?.title, 'Write config.json');
    assert.ok(report.markdown.includes('# 工作流执行汇报'));
    assert.ok(report.markdown.includes('Write config.json'));

    await useAcpAgents.getState().stopSession(started.sessionKey);
    const ledgerSessionStopped = useWorkLedger
      .getState()
      .sessions.find((s) => s.nativeSessionId === 'acp-sess-1');
    assert.equal(ledgerSessionStopped?.controlMode, 'resumable');
    assert.equal(ledgerSessionStopped?.runtimeStatus, 'stopped');

    // 2. Readonly mode: automatic rejection without queueing pendingPermissions
    const readonlySess = await useAcpAgents.getState().startSession({
      agentId: profile.id,
      workspaceRoot: tempDir,
      autonomyMode: 'readonly',
      title: 'Readonly ACP Run',
      controllerFactory: (opts) =>
        new AcpController({
          ...opts,
          transport: new NodeChildProcessAcpTransport(scriptPath),
        }),
    });

    const roRes = await useAcpAgents
      .getState()
      .sendPrompt(readonlySess.sessionKey, 'run_with_permission');
    assert.equal(roRes.stopReason, 'end_turn');

    const roAfter = useAcpAgents.getState().sessions[readonlySess.sessionKey]!;
    assert.equal(roAfter.pendingPermissions.length, 0);
    assert.equal(roAfter.toolCalls[0]?.status, 'failed');
    assert.ok(
      roAfter.messages.some(
        (m) => m.role === 'assistant' && m.text.includes('Permission rejected: edit aborted.'),
      ),
    );

    await useAcpAgents.getState().stopSession(readonlySess.sessionKey);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ACP_PRESET_TEMPLATES 与 adoptAllDiscoveredAgents: 11 项预设校验及批量接入去重与状态同步', async () => {
  assert.equal(ACP_PRESET_TEMPLATES.length, 11);

  const byPreset = new Map(ACP_PRESET_TEMPLATES.map((item) => [item.preset, item]));
  const expectedBridgePresets = ['codex-acp', 'antigravity', 'claude-code', 'dsh'] as const;
  const expectedNativePresets = [
    'kimi-cli',
    'copilot-cli',
    'gemini-cli',
    'opencode',
    'goose',
    'qwen-code',
    'custom',
  ] as const;

  for (const preset of expectedBridgePresets) {
    const tpl = byPreset.get(preset);
    assert.ok(tpl, `Missing bridge preset: ${preset}`);
    assert.equal(tpl.transportLabel, '内置桥接');
  }
  for (const preset of expectedNativePresets) {
    const tpl = byPreset.get(preset);
    assert.ok(tpl, `Missing native ACP preset: ${preset}`);
    assert.equal(tpl.transportLabel, '原生 ACP');
  }

  localStorage.clear();
  useAcpAgents.setState({
    agents: [],
    discovered: [],
    probes: {},
    sessions: {},
    activeSessionKey: null,
    loading: false,
    discovering: false,
    lastError: null,
  });

  // Pre-register claude-code so adoptAllDiscoveredAgents skips it cleanly
  const existingClaude = await useAcpAgents.getState().upsertAgent({
    name: 'Claude Code',
    preset: 'claude-code',
    command: 'C:/npm/claude.cmd',
    args: ['--rocketx-acp-bridge=claude'],
    enabled: true,
  });

  useAcpAgents.setState({
    discovered: [
      {
        preset: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        resolvedPath: 'C:/npm/claude.cmd',
        args: ['--rocketx-acp-bridge=claude'],
        version: '2.1.316',
        alreadyRegistered: true,
      },
      {
        preset: 'antigravity',
        name: 'Google Antigravity',
        command: 'language_server',
        resolvedPath: 'C:/Antigravity/language_server.exe',
        args: ['--rocketx-acp-bridge=antigravity'],
        version: 'Antigravity 44.9.1',
        alreadyRegistered: false,
      },
      {
        preset: 'codex-acp',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        resolvedPath: 'C:/npm/codex.cmd',
        args: ['--rocketx-acp-bridge=codex'],
        version: 'codex-cli 0.165.0',
        alreadyRegistered: false,
      },
      {
        preset: 'kimi-cli',
        name: 'Kimi Code (ACP)',
        command: 'kimi',
        resolvedPath: 'C:/Users/test/.kimi-code/bin/kimi.exe',
        args: ['acp'],
        version: '2.2.0',
        alreadyRegistered: false,
      },
    ],
  });

  const adopted = await useAcpAgents.getState().adoptAllDiscoveredAgents();
  assert.equal(adopted.length, 3);
  assert.deepEqual(
    adopted.map((item) => item.preset),
    ['antigravity', 'codex-acp', 'kimi-cli'],
  );

  const stateAfterAdopt = useAcpAgents.getState();
  assert.equal(stateAfterAdopt.agents.length, 4);
  assert.ok(stateAfterAdopt.discovered.every((c) => c.alreadyRegistered === true));

  // Second call should be a no-op because everything is already registered
  const adoptedSecond = await useAcpAgents.getState().adoptAllDiscoveredAgents();
  assert.deepEqual(adoptedSecond, []);

  // Removing a registered agent reverts its discovered entry's alreadyRegistered flag
  const removed = await useAcpAgents.getState().removeAgent(existingClaude.id);
  assert.equal(removed, true);
  const claudeCandidate = useAcpAgents
    .getState()
    .discovered.find((c) => c.preset === 'claude-code');
  assert.equal(claudeCandidate?.alreadyRegistered, false);
});

test('acp_bridge.mjs: JsonRpcAcpClient 真实子进程对 codex 适配器执行 initialize/new/set_mode/load 握手', async () => {
  const bridgePath = path.resolve(process.cwd(), 'apps/desktop/src-tauri/src/acp_bridge.mjs');
  assert.equal(fs.existsSync(bridgePath), true, `Missing bridge script at ${bridgePath}`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-acp-bridge-handshake-'));

  try {
    for (const [adapter, expectedTitle] of [
      ['codex', 'OpenAI Codex CLI'],
    ] as const) {
      const updates: AcpSessionUpdateNotificationParams[] = [];
      const transport = new NodeChildProcessAcpTransport(bridgePath, [
        '--adapter',
        adapter,
        '--bin',
        process.execPath,
        '--cwd',
        tempDir,
      ]);
      const client = new JsonRpcAcpClient(transport, {
        requestTimeoutMs: 5000,
        onSessionUpdate: (params) => updates.push(params),
      });

      try {
        const init = await client.initialize();
        assert.equal(init.protocolVersion, 1);
        assert.equal(init.agentCapabilities?.loadSession, true);
        assert.equal(init.agentInfo?.name, `rocketx-acp-bridge-${adapter}`);
        assert.equal(init.agentInfo?.title, expectedTitle);

        const created = await client.sessionNew({ cwd: tempDir, mcpServers: [] });
        assert.ok(created.sessionId.startsWith('acp-bridge-'));
        assert.equal(created.modes?.currentModeId, 'confirm');
        assert.deepEqual(
          created.modes?.availableModes.map((m) => m.id),
          ['confirm', 'auto', 'plan'],
        );

        await client.sessionSetMode({ sessionId: created.sessionId, modeId: 'auto' });
        assert.ok(
          updates.some(
            (u) =>
              u.update.sessionUpdate === 'current_mode_update' &&
              u.update.currentModeId === 'auto',
          ),
        );

        const loadedExisting = await client.sessionLoad({
          sessionId: created.sessionId,
          cwd: tempDir,
          mcpServers: [],
        });
        assert.equal(loadedExisting.modes?.currentModeId, 'auto');

        const freshRequest = client.sessionLoad({
          sessionId: `restored-${adapter}-sess`,
          cwd: tempDir,
          mcpServers: [],
        });
        if (adapter === 'codex') {
          await assert.rejects(freshRequest, /交接/);
          await assert.rejects(client.sessionLoad({ sessionId: '', cwd: tempDir, mcpServers: [] }), /原生会话 ID/);
        } else {
          assert.equal((await freshRequest).modes?.currentModeId, 'confirm');
        }
      } finally {
        await client.stop();
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Antigravity 没有执行连接时必须在握手阶段失败，不能把本地桥接标为就绪', async () => {
  const bridgePath = path.resolve(process.cwd(), 'apps/desktop/src-tauri/src/acp_bridge.mjs');
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-antigravity-unavailable-'));
  const env = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome };
  delete env.ANTIGRAVITY_LS_ADDRESS;
  delete env.ANTIGRAVITY_CSRF_TOKEN;
  const transport = new NodeChildProcessAcpTransport(bridgePath, [
    '--adapter', 'antigravity', '--bin', path.join(isolatedHome, 'language_server.exe'), '--cwd', isolatedHome,
  ], env);
  const client = new JsonRpcAcpClient(transport, { requestTimeoutMs: 3000 });
  try {
    await assert.rejects(client.initialize(), /Antigravity.*(连接|控制|服务)/);
  } finally {
    await client.stop();
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test('Codex bridge never launches a writable CLI when the permission RPC errors or the host disconnects', async () => {
  const bridgePath = path.resolve(process.cwd(), 'apps/desktop/src-tauri/src/acp_bridge.mjs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-acp-permission-failure-'));
  try {
    for (const disconnect of [false, true]) {
      // This executable deliberately cannot start. A permission failure must return refusal before spawning it.
      const transport = new NodeChildProcessAcpTransport(bridgePath, ['--adapter', 'codex', '--bin', path.join(tempDir, 'must-never-execute'), '--cwd', tempDir]);
      const client = new JsonRpcAcpClient(transport, { requestTimeoutMs: 3000, hostHandlers: { requestPermission: async () => {
        if (disconnect) await transport.stop();
        throw new Error('Approval transport disconnected');
      } } });
      try {
        await client.initialize();
        const session = await client.sessionNew({ cwd: tempDir, mcpServers: [] });
        const prompt = client.sessionPrompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Modify files' }] });
        if (disconnect) await assert.rejects(prompt, /closed|exit|signal|stopped|timed out|stdin is not writable|断开|退出|超时/i);
        else assert.equal((await prompt).stopReason, 'refusal');
      } finally { await client.stop(); }
    }
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});
