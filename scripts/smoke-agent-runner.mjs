import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = resolve(import.meta.dirname, '..');
const image = 'rocketx/codex-runner:0.144.4';
const temporary = mkdtempSync(join(tmpdir(), 'rocketx-agent-smoke-'));
const workspace = join(temporary, 'workspace');
const home = join(temporary, 'codex-home');
const attachments = join(temporary, 'attachments');
const contextMarker = `RCX_M8_CONTEXT_${process.pid}_${Date.now()}`;
const configuredHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const auth = join(configuredHome, 'auth.json');
const containerName = `rocketx-agent-smoke-${process.pid}`;
const profile = 'rocketx_read';
const approvalPolicy = {
  granular: {
    sandbox_approval: true,
    rules: false,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: false,
  },
};

if (!existsSync(auth)) throw new Error('Codex 尚未登录，无法运行真实 Agent Runner smoke');
mkdirSync(workspace, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(attachments, { recursive: true });
writeFileSync(join(workspace, 'allowed.txt'), 'ROCKETX_ALLOWED_FILE\n');
writeFileSync(join(attachments, 'context.log'), `${contextMarker}\n`);
copyFileSync(
  join(root, 'apps', 'desktop', 'agent-runner', 'runner.config.toml'),
  join(home, 'config.toml'),
);

function volume(source, target, readOnly = false) {
  return `${source}:${target}${readOnly ? ':ro' : ''}`;
}

function removeContainer() {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
}

function startServer() {
  removeContainer();
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--interactive',
      '--name',
      containerName,
      '--workdir',
      '/workspace',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--security-opt',
      'seccomp=unconfined',
      '--pids-limit',
      '256',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=256m',
      '--tmpfs',
      '/run:rw,noexec,nosuid,size=16m',
      '--volume',
      volume(workspace, '/workspace'),
      '--volume',
      volume(attachments, '/workspace/.rocketx-agent/attachments', true),
      '--volume',
      volume(home, '/home/node/.codex'),
      '--volume',
      volume(auth, '/home/node/.codex/auth.json', true),
      image,
      'app-server',
      '--stdio',
    ],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let nextId = 1;
  let stderr = '';
  const pending = new Map();
  const turns = new Map();
  const answers = new Map();
  const completedTurns = new Set();
  const approvals = [];

  function write(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params, timeoutMs = 30_000) {
    const id = nextId++;
    write({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Runner app-server 请求超时：${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  }

  child.stderr.on('data', (value) => {
    stderr = `${stderr}${value}`.slice(-4_000);
  });
  child.on('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    for (const waiter of turns.values()) waiter.reject(error);
  });
  child.on('exit', (code) => {
    const error = new Error(`Runner app-server 意外退出${code === null ? '' : `（${code}）`}：${stderr}`);
    for (const waiter of pending.values()) waiter.reject(error);
    for (const waiter of turns.values()) waiter.reject(error);
  });

  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if ('id' in message && !('method' in message)) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if ('id' in message && 'method' in message) {
      if (message.method === 'currentTime/read') {
        write({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      } else if (
        message.method === 'item/commandExecution/requestApproval' ||
        message.method === 'item/fileChange/requestApproval'
      ) {
        approvals.push(message.method);
        write({ id: message.id, result: { decision: 'accept' } });
      } else if (message.method === 'item/permissions/requestApproval') {
        approvals.push(message.method);
        write({
          id: message.id,
          result: { permissions: message.params.permissions, scope: 'turn', strictAutoReview: true },
        });
      } else if (message.method === 'execCommandApproval' || message.method === 'applyPatchApproval') {
        approvals.push(message.method);
        write({ id: message.id, result: { decision: 'approved' } });
      } else {
        write({ id: message.id, error: { code: -32001, message: 'Denied by Runner smoke client' } });
      }
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      const turnId = message.params.turnId;
      answers.set(turnId, `${answers.get(turnId) ?? ''}${message.params.delta ?? ''}`);
    }
    if (message.method === 'turn/completed') {
      const turnId = message.params.turn.id;
      const waiter = turns.get(turnId);
      if (waiter) {
        turns.delete(turnId);
        waiter.resolve(answers.get(turnId) ?? '');
      } else {
        completedTurns.add(turnId);
      }
    }
  });

  async function initialize() {
    const result = await request('initialize', {
      clientInfo: { name: 'rocketx', title: 'RocketX Runner Smoke', version: '0.18.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: null,
      },
    });
    if (!/(?:Codex Desktop|rocketx)\/0\.144\.4/.test(result.userAgent)) {
      throw new Error(`Runner 初始化版本不匹配：${result.userAgent}`);
    }
    write({ method: 'initialized' });
  }

  async function turn(threadId, prompt, marker) {
    const response = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      approvalPolicy,
      approvalsReviewer: 'user',
      cwd: '/workspace',
      runtimeWorkspaceRoots: ['/workspace'],
      permissions: profile,
    });
    if (completedTurns.delete(response.turn.id)) {
      const answer = answers.get(response.turn.id) ?? '';
      if (!answer.includes(marker)) throw new Error(`未收到预期 Runner 回复 ${marker}：${answer}`);
      return;
    }
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        turns.delete(response.turn.id);
        reject(new Error(`Runner turn 超时：${marker}`));
      }, 90_000);
      turns.set(response.turn.id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    if (!answer.includes(marker)) throw new Error(`未收到预期 Runner 回复 ${marker}：${answer}`);
  }

  async function stop() {
    const exited =
      child.exitCode === null
        ? new Promise((resolve) => child.once('exit', resolve))
        : Promise.resolve();
    removeContainer();
    child.kill();
    await exited;
  }

  return { approvals, initialize, request, turn, stop };
}

const timer = setTimeout(() => {
  removeContainer();
  process.exitCode = 1;
  console.error('Agent Runner 真实 smoke 总超时');
}, 180_000);

try {
  const first = startServer();
  await first.initialize();
  const started = await first.request('thread/start', {
    cwd: '/workspace',
    runtimeWorkspaceRoots: ['/workspace'],
    approvalPolicy,
    approvalsReviewer: 'user',
    permissions: profile,
    ephemeral: false,
    developerInstructions: 'Follow the explicit user request. Never access .env or authentication files.',
  });
  const threadId = started.thread.id;
  await first.turn(threadId, 'Reply exactly RCX_M8_RUNNER_OK', 'RCX_M8_RUNNER_OK');
  await first.turn(
    threadId,
    'Read /workspace/.rocketx-agent/attachments/context.log and reply with exactly its single line, with no other text.',
    contextMarker,
  );
  await first.turn(
    threadId,
    'Use a shell command to create /workspace/approved.txt containing exactly APPROVED_WRITE. If the read-only sandbox denies it, explicitly request elevated sandbox permission from the host and retry. After the file exists, reply exactly RCX_M8_WRITE_OK.',
    'RCX_M8_WRITE_OK',
  );
  if (readFileSync(join(workspace, 'approved.txt'), 'utf8') !== 'APPROVED_WRITE') {
    throw new Error('宿主批准后未写入预期工作区文件');
  }
  if (first.approvals.length === 0) throw new Error('工作区写入未触发宿主审批');
  await first.stop();

  const resumed = startServer();
  await resumed.initialize();
  await resumed.request('thread/resume', {
    threadId,
    cwd: '/workspace',
    runtimeWorkspaceRoots: ['/workspace'],
    approvalPolicy,
    approvalsReviewer: 'user',
    permissions: profile,
    excludeTurns: true,
  });
  await resumed.turn(threadId, 'Reply exactly RCX_M8_RESUMED_OK', 'RCX_M8_RESUMED_OK');
  await resumed.stop();
  console.log('Agent Runner 真实回合、宿主审批写入与 kill/resume 通过');
} finally {
  clearTimeout(timer);
  removeContainer();
  rmSync(temporary, { recursive: true, force: true });
}
