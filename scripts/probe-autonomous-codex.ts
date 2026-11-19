/** Runs the real Codex app-server against a loopback model fixture, never user sessions or credentials. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { codexInvocation, codexRuntimeSourceFromArgs } from './lib/codex-app-server-spike';

async function main() {
const args = process.argv.slice(2);
const option = (key: string, fallback: string) => args.includes(key) ? args[args.indexOf(key) + 1] ?? fallback : fallback;
const runtime = codexRuntimeSourceFromArgs(args);
const invocation = codexInvocation(runtime);
const shared = args.includes('--shared-clients');
const output = path.resolve(option('--output', `.omx/logs/autonomous-implementation-20261117/codex-${runtime}${shared ? '-shared' : ''}`));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketx-autonomous-probe-'));
const home = path.join(root, 'codex-home');
const workspace = path.join(root, 'workspace');
await fs.mkdir(home); await fs.mkdir(workspace); await fs.mkdir(output, { recursive: true });
const marker = `ROCKETX_PROBE_${randomUUID()}`;
const deniedFile = path.join(workspace, 'approval-must-not-write.txt');
const steps: Array<{ name: string; passed: boolean; details?: unknown }> = [];
const notifications: Array<{ method: string; params: any }> = [];
const traffic: Array<{ direction: string; method: string }> = [];
const hostRequests: Array<{ method: string; threadId?: string; turnId?: string }> = [];
const toolNames = new Set<string>();
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const responses: http.ServerResponse[] = [];
let child: ChildProcessWithoutNullStreams | undefined;
let nextId = 1;
let calls = 0;
let exitExpected = false;
let failure: string | undefined;
let phase: 'initial' | 'hold' | 'approval' | 'after-approval' = 'initial';
let resumedContextSeen = false;
let socket: WebSocket | undefined;
let secondary: WebSocket | undefined;
const secondaryEvents: Array<{ method: string; params: any }> = [];
const secondaryPending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

async function waitFor<T>(read: () => T | undefined | false, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

function complete(response: http.ServerResponse, text: string) {
  const id = `resp_${randomUUID()}`;
  const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const send = (type: string, value: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send('response.created', { response: { id, status: 'in_progress', output: [] } });
  send('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
  send('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  send('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: text });
  send('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text });
  send('response.output_item.done', { output_index: 0, item: message });
  send('response.completed', { response: { id, status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  response.end();
}

function askForApproval(response: http.ServerResponse, payload: any) {
  const tool = payload.tools?.find((entry: any) => ['exec_command', 'shell_command'].includes(entry.name));
  assert(tool, 'Native shell tool must be advertised for the approval probe');
  const command = process.platform === 'win32'
    ? `Set-Content -LiteralPath '${deniedFile.replaceAll("'", "''")}' -Value 'must-not-execute'`
    : `printf must-not-execute > '${deniedFile.replaceAll("'", "'\\''")}'`;
  const parameters = tool.name === 'exec_command' ? { cmd: command } : { command };
  const item = { type: 'function_call', id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`, name: tool.name, arguments: JSON.stringify(parameters), status: 'completed' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, data] of [
    ['response.created', { response: { id: `resp_${randomUUID()}`, output: [] } }],
    ['response.output_item.done', { output_index: 0, item }],
    ['response.completed', { response: { id: `resp_${randomUUID()}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }],
  ] as const) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  response.end();
}

const gateway = http.createServer(async (request, response) => {
  try {
  // Refuse unrelated paths and record counts only, never prompts, headers, or credentials.
  if (request.method !== 'POST' || request.url !== '/v1/responses') {
    response.writeHead(404); response.end(); return;
  }
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  const payload = JSON.parse(body);
  for (const tool of payload.tools ?? []) if (typeof tool.name === 'string') toolNames.add(tool.name);
  calls += 1;
  responses.push(response);
  if (phase === 'initial') { complete(response, marker); phase = 'hold'; }
  else if (phase === 'approval') {
    resumedContextSeen = JSON.stringify(payload.input).includes(marker);
    phase = 'after-approval'; askForApproval(response, payload);
  }
  else if (phase === 'after-approval') complete(response, 'Approval was denied; no command was executed.');
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
    if (!response.headersSent) response.writeHead(500);
    response.end(JSON.stringify({ error: { message: 'Local probe fixture rejected this request' } }));
  }
});
let endpoint = 'stdio://';
const env: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, { CODEX_HOME: home, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });

function write(message: object) {
  const line = JSON.stringify(message);
  if (socket) socket.send(line);
  else child!.stdin.write(`${line}\n`);
}

async function connectSocket(): Promise<WebSocket> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const connection = new WebSocket(endpoint);
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 500);
      connection.addEventListener('open', () => { clearTimeout(timer); resolve(true); }, { once: true });
      connection.addEventListener('error', () => { clearTimeout(timer); resolve(false); }, { once: true });
    });
    if (opened) return connection;
    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Shared app-server listener did not become ready');
}

async function start() {
  exitExpected = false;
  child = spawn(invocation.command, [...invocation.args, 'app-server', '--listen', endpoint], { cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  child.stderr.resume(); // Native diagnostics can include local environment details; do not persist them.
  const receive = (line: string) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    traffic.push({ direction: 'in', method: message.method ?? 'response' });
    if (message.method && message.id !== undefined) {
      hostRequests.push({ method: message.method, threadId: message.params?.threadId, turnId: message.params?.turnId });
      const reply = message.method === 'item/commandExecution/requestApproval'
        ? { id: message.id, result: { decision: 'decline' } }
        : { id: message.id, error: { code: -32000, message: 'Probe denies host side effects' } };
      write(reply);
    } else if (message.method) notifications.push(message);
    else {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result);
    }
  };
  lines.on('line', receive);
  const failPending = (error: Error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.on('error', failPending);
  child.on('close', (code) => { lines.close(); if (!exitExpected) failPending(new Error(`Codex exited: ${code}`)); });
  if (shared) {
    socket = await connectSocket();
    socket.addEventListener('message', (event) => receive(String(event.data)));
  }
}

function rpc(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  traffic.push({ direction: 'out', method });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timed out: ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    try { write({ id, method, params }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

async function initialize() {
  const result = await rpc('initialize', { clientInfo: { name: 'rocketx-autonomous-probe', title: 'RocketX isolated probe', version: '1' }, capabilities: { experimentalApi: true } });
  write({ method: 'initialized' });
  assert.equal(typeof result.userAgent, 'string');
  return result;
}

async function stop() {
  const current = child;
  if (!current?.pid || current.exitCode !== null) return;
  exitExpected = true;
  secondary?.close(); secondary = undefined;
  socket?.close(); socket = undefined;
  const stopped = new Promise<void>((resolve) => current.once('close', () => resolve()));
  current.stdin.end();
  const timer = setTimeout(() => current.kill(), 2000);
  await stopped; clearTimeout(timer); child = undefined;
}

const turn = (threadId: string, text: string) => rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], cwd: workspace, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
const completed = (turnId: string) => waitFor(() => notifications.find((entry) => entry.method === 'turn/completed' && entry.params.turn?.id === turnId), `completed ${turnId}`);
try {
  if (shared) {
    const reservation = http.createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const reserved = reservation.address(); assert(reserved && typeof reserved !== 'string');
    endpoint = `ws://127.0.0.1:${reserved.port}`;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
  }
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  assert(address && typeof address !== 'string');
  await fs.writeFile(path.join(home, 'config.toml'), [
    'model = "rocketx-local-probe"', 'model_provider = "rocketx_probe"',
    'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"',
    '[model_providers.rocketx_probe]', 'name = "RocketX loopback fixture"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`, 'wire_api = "responses"',
    'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0',
  ].join('\n'));
  await start(); await initialize(); steps.push({ name: 'initialize-real-codex', passed: true });
  const created = await rpc('thread/start', { cwd: workspace, model: 'rocketx-local-probe', modelProvider: 'rocketx_probe', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false });
  const threadId = created.thread.id;
  assert(threadId); assert.equal(path.resolve(created.thread.cwd), workspace);
  const first = await turn(threadId, 'Return the probe marker. Do not use tools.');
  const done = await completed(first.turn.id);
  assert.equal(done.params.turn.status, 'completed');
  assert(notifications.some((entry) => entry.method === 'item/agentMessage/delta' && entry.params.delta?.includes(marker)));
  steps.push({ name: 'real-turn-and-streamed-reply', passed: true });

  const running = await turn(threadId, 'Wait for follow-up instructions.');
  await waitFor(() => calls >= 2, 'held model request');
  let control = rpc;
  if (shared) {
    secondary = await connectSocket();
    secondary.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method) { secondaryEvents.push(message); return; }
      const entry = secondaryPending.get(message.id); if (!entry) return;
      secondaryPending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
    });
    control = (method: string, params: unknown) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { secondaryPending.delete(id); reject(new Error(`Secondary RPC timed out: ${method}`)); }, 10_000);
      secondaryPending.set(id, { resolve, reject, timer });
      secondary!.send(JSON.stringify({ id, method, params }));
    });
    await control('initialize', { clientInfo: { name: 'rocketx-second-client', version: '1' }, capabilities: { experimentalApi: true } });
    secondary.send(JSON.stringify({ method: 'initialized' }));
    const attached = await control('thread/resume', { threadId });
    assert.equal(attached.thread.id, threadId);
    steps.push({ name: 'second-client-resumes-same-active-thread', passed: true });
  }
  const steered = await control('turn/steer', { threadId, expectedTurnId: running.turn.id, input: [{ type: 'text', text: 'Use the updated requirement.', text_elements: [] }] });
  assert.equal(steered.turnId, running.turn.id);
  steps.push({ name: 'steer-active-turn-same-id', passed: true });
  await assert.rejects(rpc('turn/steer', { threadId, expectedTurnId: 'wrong-turn', input: [{ type: 'text', text: 'Must not target another turn.', text_elements: [] }] }));
  steps.push({ name: 'wrong-turn-steer-rejected', passed: true });
  await control('turn/interrupt', { threadId, turnId: running.turn.id });
  const interrupted = await completed(running.turn.id);
  assert.equal(interrupted.params.turn.status, 'interrupted');
  steps.push({ name: 'interrupt-confirmed-by-native-event', passed: true });
  if (shared) {
    await waitFor(() => secondaryEvents.find((entry) => entry.method === 'turn/completed' && entry.params.turn?.id === running.turn.id && entry.params.turn.status === 'interrupted'), 'secondary completion event');
    steps.push({ name: 'both-clients-observe-same-interrupted-turn', passed: true });
  }

  await stop(); await start(); await initialize();
  const resumed = await rpc('thread/resume', { threadId, cwd: workspace });
  assert.equal(resumed.thread.id, threadId);
  const read = await rpc('thread/read', { threadId, includeTurns: true });
  assert.equal(read.thread.id, threadId);
  assert(JSON.stringify(read.thread.turns).includes(marker), 'Persisted response must survive native process restart');
  steps.push({ name: 'original-id-and-history-after-restart', passed: true });
  await assert.rejects(rpc('thread/resume', { threadId: randomUUID(), cwd: workspace }));
  steps.push({ name: 'missing-thread-does-not-create-replacement', passed: true });
  phase = 'approval';
  const approvalTurn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Exercise approval refusal only.', text_elements: [] }], cwd: workspace, approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  const approvalCompleted = await completed(approvalTurn.turn.id);
  assert.equal(approvalCompleted.params.turn.status, 'completed');
  assert(resumedContextSeen, 'Resumed native model input must retain the original conversation response');
  assert(hostRequests.some((request) => request.method === 'item/commandExecution/requestApproval' && request.threadId === threadId && request.turnId === approvalTurn.turn.id), 'Approval must be requested for the exact native thread and turn');
  assert(notifications.some((entry) => entry.method === 'item/completed' && entry.params.threadId === threadId && entry.params.turnId === approvalTurn.turn.id && entry.params.item?.type === 'commandExecution' && entry.params.item.status === 'declined'), 'Native command result must confirm refusal on the approval turn');
  await assert.rejects(fs.access(deniedFile), 'Declined command must not write its output file');
  steps.push({ name: 'native-command-approval-denied-with-correct-identity', passed: true });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await stop();
  for (const response of responses) if (!response.writableEnded) response.destroy();
  gateway.closeAllConnections();
  if (gateway.listening) await new Promise<void>((resolve) => gateway.close(() => resolve()));
  const commandResults = notifications.filter((entry) => entry.method === 'item/completed' && entry.params.item?.type === 'commandExecution').map((entry) => ({ status: entry.params.item.status, exitCode: entry.params.item.exitCode }));
  const report = { runtime, version: invocation.version, executable: invocation.displayPath, transport: shared ? 'experimental-loopback-websocket' : 'stdio', isolatedRoot: root, inference: 'loopback-fixture', userCredentialsRead: false, userSessionsAccessed: false, externalTaskSent: false, modelCalls: calls, toolNames: [...toolNames], hostRequests, commandResults, steps, failure: failure ?? null, liveDesktopAttach: 'not-tested', providerAuthentication: 'not-tested', realApplicationJourney: 'not-tested' };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'protocol-methods.json'), JSON.stringify(traffic, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
}

main().catch(async (error) => {
  const failure = error instanceof Error ? error.message : String(error);
  const argv = process.argv.slice(2);
  const runtimeIndex = argv.indexOf('--runtime');
  const runtime = runtimeIndex < 0 ? 'pinned' : argv[runtimeIndex + 1];
  const outputIndex = argv.indexOf('--output');
  const output = path.resolve(outputIndex < 0 ? `.omx/logs/autonomous-implementation-20261117/codex-${runtime}${argv.includes('--shared-clients') ? '-shared' : ''}` : argv[outputIndex + 1]);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ runtime, steps: [], failure, phase: 'setup-or-cleanup', userCredentialsRead: false, userSessionsAccessed: false, externalTaskSent: false }, null, 2) + '\n');
  console.error(failure);
  process.exitCode = 1;
});
