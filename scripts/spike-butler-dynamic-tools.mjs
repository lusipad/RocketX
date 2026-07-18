import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = resolve(import.meta.dirname, '..');
const timeoutMs = 120_000;
const dynamicToolName = 'list_todos_demo';
const demoTodos = [
  { id: 'demo-1', title: '购买燕麦奶', status: '未完成' },
  { id: 'demo-2', title: '整理周报', status: '未完成' },
];
const demoTodoKeywords = demoTodos.map((todo) => todo.title);

function invocation() {
  if (process.platform !== 'win32') return { command: 'codex', args: [] };
  const lookup = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8' });
  const fallback = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command -Name codex.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)'],
    { encoding: 'utf8' },
  );
  const shim = (lookup.stdout || fallback.stdout)?.split(/\r?\n/).find(Boolean);
  const entry = shim ? join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : '';
  if (!entry || !existsSync(entry)) throw new Error('找不到 PATH 中 Codex CLI 的官方 Node 入口');
  return { command: process.execPath, args: [entry] };
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill();
  await Promise.race([closed, sleep(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const timeline = [];
  let child;
  let tempDir;
  let threadId = null;
  let turnId = null;
  let answer = '';
  let failure = null;
  let cliVersion = null;
  let stopping = false;
  let dynamicToolCall = {
    received: false,
    threadIdMatches: false,
    toolNameMatches: false,
  };

  const addTimeline = (direction, method, id) => {
    timeline.push({ at: new Date().toISOString(), direction, method, ...(id === undefined ? {} : { id }) });
  };

  try {
    tempDir = await mkdtemp(join(tmpdir(), 'rocketx-butler-dynamic-tools-'));
    const cli = invocation();
    const version = spawnSync(cli.command, [...cli.args, '--version'], { encoding: 'utf8' });
    cliVersion = version.stdout.trim().match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1] ?? null;
    if (version.status !== 0 || !cliVersion) {
      throw new Error(`无法识别 Codex CLI 版本：${version.stdout.trim() || '不可用'}`);
    }

    child = spawn(cli.command, [...cli.args, 'app-server', '--stdio'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let nextId = 1;
    let turnCompleted = false;
    const pending = new Map();
    let resolveTurnCompletion;
    let rejectTurnCompletion;
    const turnCompletion = new Promise((resolve, reject) => {
      resolveTurnCompletion = resolve;
      rejectTurnCompletion = reject;
    });
    void turnCompletion.catch(() => undefined);

    const rejectPending = (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };

    const write = (message) => {
      const method = typeof message.method === 'string' ? message.method : 'response';
      addTimeline('client→server', method, message.id);
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const request = (method, params) => {
      const id = nextId++;
      write({ id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
    };

    const respondToServerRequest = (message) => {
      if (message.method === 'item/tool/call') {
        const params = asRecord(message.params);
        dynamicToolCall = {
          received: true,
          threadIdMatches: params?.threadId === threadId,
          toolNameMatches: params?.tool === dynamicToolName,
        };
        write({
          id: message.id,
          result: {
            contentItems: [{ type: 'inputText', text: JSON.stringify({ todos: demoTodos }) }],
            success: true,
          },
        });
        return;
      }
      if (message.method === 'currentTime/read') {
        write({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
        return;
      }
      write({ id: message.id, error: { code: -32001, message: `Denied by Spike D client: ${message.method}` } });
    };

    child.stderr.on('data', (value) => process.stderr.write(value));
    child.on('error', (error) => {
      rejectPending(error);
      if (!turnCompleted && !stopping) rejectTurnCompletion(error);
    });
    child.on('close', (code) => {
      const error = new Error(`Codex app-server 已退出（${code ?? 'signal'}）`);
      rejectPending(error);
      if (!turnCompleted && !stopping) rejectTurnCompletion(error);
    });

    createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        addTimeline('server→client', '<invalid-json>');
        rejectPending(new Error('Codex app-server 返回了无效 JSON'));
        if (!turnCompleted) rejectTurnCompletion(new Error('Codex app-server 返回了无效 JSON'));
        return;
      }

      const method = typeof message.method === 'string' ? message.method : null;
      if ('id' in message && !method) {
        const waiter = pending.get(message.id);
        addTimeline('server→client', waiter ? `${waiter.method}/response` : 'response', message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? 'Codex app-server 请求失败'));
        else waiter.resolve(message.result);
        return;
      }

      if (!method) {
        addTimeline('server→client', '<missing-method>', message.id);
        return;
      }

      addTimeline('server→client', method, message.id);
      if ('id' in message) {
        respondToServerRequest(message);
        return;
      }
      if (method === 'item/agentMessage/delta') answer += message.params?.delta ?? '';
      if (method === 'turn/completed' && message.params?.threadId === threadId) {
        turnCompleted = true;
        resolveTurnCompletion();
      }
    });

    const initialized = await request('initialize', {
      clientInfo: { name: 'rocketx-spike-d', title: 'RocketX Spike D', version: '0.20.1' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: null,
      },
    });
    const initializedVersion = initialized.userAgent?.match(/\/(\d+\.\d+\.\d+)/)?.[1];
    if (initializedVersion !== cliVersion) {
      throw new Error(`初始化版本不匹配：${initialized.userAgent ?? '未知'}`);
    }
    write({ method: 'initialized' });

    const thread = await request('thread/start', {
      cwd: tempDir,
      runtimeWorkspaceRoots: [tempDir],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      ephemeral: true,
      developerInstructions:
        '你是 RocketX 的中文管家。收到本次任务时必须调用 list_todos_demo 查询待办，然后只用一句中文总结。回答末尾附上暗号 RCX-SPIKE-D。',
      dynamicTools: [
        {
          type: 'function',
          name: dynamicToolName,
          description: '查询用户未完成待办',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
    threadId = thread.thread.id;

    const turn = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '请调用 list_todos_demo 查询我的待办，然后用一句话总结', text_elements: [] }],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    turnId = turn.turn.id;

    let timeout;
    try {
      await Promise.race([
        turnCompletion,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Spike D 超时（${timeoutMs / 1000}s）`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    stopping = true;
    await stopChild(child);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }

  const matchedTodoKeywords = demoTodoKeywords.filter((keyword) => answer.includes(keyword));
  const checks = {
    dynamicToolCall: dynamicToolCall.received && dynamicToolCall.threadIdMatches && dynamicToolCall.toolNameMatches,
    demoTodoKeyword: matchedTodoKeywords.length > 0,
    injectedMarker: answer.includes('RCX-SPIKE-D'),
  };
  const passed = !failure && Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      {
        spike: 'butler-dynamic-tools',
        result: passed ? 'PASS' : 'FAIL',
        cliVersion,
        threadId,
        turnId,
        checks,
        dynamicToolCall,
        matchedTodoKeywords,
        finalAnswer: answer,
        error: failure,
        timeline,
      },
      null,
      2,
    ),
  );
  process.exitCode = passed ? 0 : 1;
}

await main();
