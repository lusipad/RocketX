import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const expectedVersion = '0.144.4';
const root = resolve(import.meta.dirname, '..');

function invocation() {
  if (process.platform !== 'win32') return { command: 'codex', args: [] };
  const lookup = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8' });
  const shim = lookup.stdout?.split(/\r?\n/).find(Boolean);
  const entry = shim ? join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : '';
  if (!entry || !existsSync(entry)) throw new Error('找不到 PATH 中 Codex CLI 的官方 Node 入口');
  return { command: process.execPath, args: [entry] };
}

const cli = invocation();
const version = spawnSync(cli.command, [...cli.args, '--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== `codex-cli ${expectedVersion}`) {
  throw new Error(`需要 codex-cli ${expectedVersion}，实际 ${version.stdout.trim() || '不可用'}`);
}

const child = spawn(cli.command, [...cli.args, 'app-server', '--stdio'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let nextId = 1;
const pending = new Map();
let answer = '';

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  write({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const timer = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
  console.error('Codex app-server smoke 超时');
}, 90_000);

child.stderr.on('data', (value) => process.stderr.write(value));
child.on('error', (error) => {
  clearTimeout(timer);
  throw error;
});

createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line);
  if ('id' in message && !('method' in message)) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if ('id' in message && 'method' in message) {
    if (message.method === 'currentTime/read') {
      write({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
    } else {
      write({ id: message.id, error: { code: -32001, message: 'Denied by smoke client' } });
    }
    return;
  }
  if (message.method === 'item/agentMessage/delta') answer += message.params.delta ?? '';
  if (message.method === 'turn/completed') {
    clearTimeout(timer);
    if (!answer.includes('RCX_M8_OK')) {
      console.error(`未收到预期回复：${answer}`);
      process.exitCode = 1;
    } else {
      console.log(`Codex app-server ${expectedVersion} 真实 turn 通过：RCX_M8_OK`);
    }
    child.kill();
  }
});

const initialized = await request('initialize', {
  clientInfo: { name: 'rocketx-smoke', title: 'RocketX Smoke', version: '0.19.0' },
  capabilities: {
    experimentalApi: true,
    requestAttestation: false,
    mcpServerOpenaiFormElicitation: false,
    optOutNotificationMethods: null,
  },
});
if (!initialized.userAgent.startsWith(`Codex Desktop/${expectedVersion}`)) {
  throw new Error(`初始化版本不匹配：${initialized.userAgent}`);
}
write({ method: 'initialized' });
const thread = await request('thread/start', {
  cwd: root,
  runtimeWorkspaceRoots: [root],
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: 'read-only',
  ephemeral: true,
  developerInstructions: 'Do not use tools. Reply with the exact requested marker only.',
});
await request('turn/start', {
  threadId: thread.thread.id,
  input: [{ type: 'text', text: 'Reply exactly RCX_M8_OK', text_elements: [] }],
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandboxPolicy: { type: 'readOnly', networkAccess: false },
});
