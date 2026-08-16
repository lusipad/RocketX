import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HostedDshController,
  type HostedDshControllerOptions,
} from '../../apps/web/src/agent/dsh/HostedDshController';
import type {
  DshControllerRuntime,
  DshServerRequest,
} from '../../apps/web/src/agent/dsh/DshController';
import type {
  DshPendingApproval,
  DshPendingQuestion,
  DshQuestionAnswer,
} from '../../apps/web/src/agent/dsh/types';

type EventName = 'dsh-bridge-output' | 'dsh-bridge-exit';

interface RuntimeEventMap {
  'dsh-bridge-output': { processId: string; stream: 'stdout' | 'stderr'; line: string };
  'dsh-bridge-exit': { processId: string; code: number | null };
}

const bridgeScript = path.resolve('apps/desktop/src-tauri/src/dsh_bridge.mjs');

function websocketAccept(key: string): string {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'utf8')
    .digest('base64');
}

function websocketFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error('fixture payload is unexpectedly large');
}

function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = read();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function options(runtime: DshControllerRuntime, sink: {
  approvals: DshPendingApproval[];
  questions: DshPendingQuestion[];
  traces: DshServerRequest[];
  interrupted: Error[];
  approvalResolved: Array<[string, string]>;
  questionResolved: Array<[string, string]>;
}): HostedDshControllerOptions {
  return {
    runtime,
    onApproval: (approval) => sink.approvals.push(approval),
    onApprovalResolved: (sessionId, approvalId) => sink.approvalResolved.push([sessionId, approvalId]),
    onQuestion: (question) => sink.questions.push(question),
    onQuestionResolved: (sessionId, questionRpcId) => sink.questionResolved.push([sessionId, questionRpcId]),
    onTrace: (request) => sink.traces.push(request),
    onInterrupted: (error) => sink.interrupted.push(error),
  };
}

class BridgeRuntimeFixture implements DshControllerRuntime {
  private readonly listeners = new Map<EventName, Set<(event: { payload: unknown }) => void>>();
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private tempRoot = '';
  private patchPath = '';
  private cliPath = '';
  readonly serverLogPath: string;

  private constructor(serverLogPath: string) {
    this.serverLogPath = serverLogPath;
  }

  static async create(): Promise<BridgeRuntimeFixture> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rocketx-hosted-dsh-bridge-'));
    const serverLogPath = path.join(tempRoot, 'fixture-server-log.jsonl');
    const fixture = new BridgeRuntimeFixture(serverLogPath);
    fixture.tempRoot = tempRoot;
    fixture.patchPath = path.join(tempRoot, 'fixture.patch.yml');
    fixture.cliPath = path.join(tempRoot, 'fake-dsh-cli-hosted.mjs');
    await writeFile(fixture.patchPath, '# fixture patch\n', 'utf8');
    await writeFile(fixture.cliPath, fixture.fixtureScript(), 'utf8');
    return fixture;
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (command === 'dsh_bridge_start') {
      const child = spawn(process.execPath, [bridgeScript, this.cliPath, this.patchPath], {
        cwd: process.cwd(),
        env: { ...process.env, DSH_BRIDGE_FIXTURE_LOG: this.serverLogPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdin.setDefaultEncoding('utf8');
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const processId = `bridge-${child.pid ?? Date.now()}`;
      this.processes.set(processId, child);

      let stdoutBuffer = '';
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let boundary = stdoutBuffer.indexOf('\n');
        while (boundary !== -1) {
          const line = stdoutBuffer.slice(0, boundary);
          stdoutBuffer = stdoutBuffer.slice(boundary + 1);
          this.emit('dsh-bridge-output', { processId, stream: 'stdout', line });
          try {
            const frame = JSON.parse(line) as { kind?: string; code?: number | null };
            if (frame.kind === 'exit') {
              this.emit('dsh-bridge-exit', {
                processId,
                code: typeof frame.code === 'number' ? frame.code : null,
              });
            }
          } catch {
            // DshController will surface malformed lines from stdout.
          }
          boundary = stdoutBuffer.indexOf('\n');
        }
      });

      let stderrBuffer = '';
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk;
        let boundary = stderrBuffer.indexOf('\n');
        while (boundary !== -1) {
          const line = stderrBuffer.slice(0, boundary);
          stderrBuffer = stderrBuffer.slice(boundary + 1);
          this.emit('dsh-bridge-output', { processId, stream: 'stderr', line });
          boundary = stderrBuffer.indexOf('\n');
        }
      });

      child.once('close', () => {
        this.processes.delete(processId);
      });
      return { processId, leaseId: `lease-${processId}` } as T;
    }

    if (command === 'dsh_bridge_write') {
      const processId = String(args?.processId ?? '');
      const child = this.processes.get(processId);
      if (!child) throw new Error(`bridge ${processId} is not running`);
      child.stdin.write(`${JSON.stringify(args?.message ?? {})}\n`);
      return undefined as T;
    }

    if (command === 'dsh_bridge_stop') {
      const processId = String(args?.processId ?? '');
      const child = this.processes.get(processId);
      if (!child) return undefined as T;
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.stdin.write(`${JSON.stringify({ kind: 'shutdown' })}\n`);
      });
      return undefined as T;
    }

    throw new Error(`unexpected invoke: ${command}`);
  }

  async listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
    const name = event as EventName;
    let bucket = this.listeners.get(name);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(name, bucket);
    }
    bucket.add(handler as (event: { payload: unknown }) => void);
    return () => {
      bucket?.delete(handler as (event: { payload: unknown }) => void);
    };
  }

  async dispose(): Promise<void> {
    for (const [processId] of this.processes) {
      await this.invoke('dsh_bridge_stop', { processId }).catch(() => undefined);
    }
    if (this.tempRoot) await rm(this.tempRoot, { recursive: true, force: true });
  }

  private emit<K extends EventName>(event: K, payload: RuntimeEventMap[K]): void {
    for (const handler of this.listeners.get(event) ?? []) handler({ payload });
  }

  private fixtureScript(): string {
    return String.raw`
import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import http from 'node:http'

const args = process.argv.slice(2)
const expected = ['--profile', 'web', '--patch', args[3], '--host', '127.0.0.1', '--port', '0']
if (args.length !== expected.length || args.some((value, index) => value !== expected[index])) {
  console.error('unexpected argv', args)
  process.exit(2)
}

const serverLog = process.env.DSH_BRIDGE_FIXTURE_LOG
if (!serverLog) {
  console.error('missing DSH_BRIDGE_FIXTURE_LOG')
  process.exit(3)
}

const state = {
  sessionId: 'session-bridge-1',
  responded: new Set(),
  promptScheduled: false,
}

function log(entry) {
  return appendFile(serverLog, JSON.stringify(entry) + '\n')
}

function websocketAccept(key) {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'utf8')
    .digest('base64')
}

function websocketFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  }
  if (payload.length < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
    return Buffer.concat([header, payload])
  }
  throw new Error('fixture payload is unexpectedly large')
}

const sockets = { mux: new Set(), host: new Set() }

function emit(kind, envelope) {
  const frame = websocketFrame(JSON.stringify(envelope))
  for (const socket of sockets[kind]) socket.write(frame)
}

function maybeFinishPrompt() {
  if (!state.responded.has('approval-rpc') || !state.responded.has('question-rpc')) return
  emit('mux', {
    type: 'server-request',
    rpcId: 'approval-resolved-rpc',
    method: 'approval/resolved',
    payload: {
      type: 'approval/resolved',
      sessionId: state.sessionId,
      approvalId: 'approval-1',
    },
  })
  emit('mux', {
    type: 'server-request',
    rpcId: 'question-resolved-rpc',
    method: 'question/resolved',
    payload: {
      type: 'question/resolved',
      sessionId: state.sessionId,
      questionRpcId: 'question-rpc',
    },
  })
  emit('mux', {
    type: 'server-request',
    rpcId: 'assistant-message-rpc',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId: state.sessionId,
      event: {
        type: 'assistant/message',
        seq: 5,
        time: 5,
        data: {
          turn: 2,
          step: 1,
          message: {
            id: 'assistant-bridge-1',
            role: 'assistant',
            content: [{ type: 'text', text: '桥接回答完成' }],
            source: { kind: 'model' },
          },
        },
      },
    },
  })
  emit('mux', {
    type: 'server-request',
    rpcId: 'turn-end-rpc',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId: state.sessionId,
      event: {
        type: 'turn/end',
        seq: 6,
        time: 6,
        data: { turn: 2, reason: { kind: 'done' } },
      },
    },
  })
}

const server = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const bodyText = Buffer.concat(chunks).toString('utf8')
  const body = bodyText === '' ? null : JSON.parse(bodyText)
  await log({ path: request.url, body })
  response.setHeader('content-type', 'application/json')

  if (request.method === 'POST' && request.url === '/api/host.describe') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { version: 1 } },
    }))
    return
  }

  if (request.method === 'POST' && request.url === '/api/credentials.describe') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: {
        ok: true,
        value: {
          credentials: {
            DEEPSEEK_API_KEY: { source: 'env', configured: true, writable: false },
          },
        },
      },
    }))
    return
  }

  if (request.method === 'POST' && request.url === '/api/session.create') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { sessionId: state.sessionId } },
    }))
    return
  }

  if (request.method === 'POST' && request.url === '/api/session.history') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: {
        ok: true,
        value: {
          events: [
            { event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
            {
              event: {
                type: 'assistant/message',
                seq: 2,
                time: 2,
                data: {
                  turn: 1,
                  step: 1,
                  message: {
                    id: 'history-1',
                    role: 'assistant',
                    content: [{ type: 'text', text: '历史答复' }],
                    source: { kind: 'model' },
                  },
                },
              },
            },
            { event: { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'done' } } } },
          ],
          hasMore: false,
        },
      },
    }))
    return
  }

  if (request.method === 'POST' && request.url === '/api/session.prompt') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { accepted: true } },
    }))
    if (!state.promptScheduled) {
      state.promptScheduled = true
      setTimeout(() => {
        emit('mux', {
          type: 'server-request',
          rpcId: 'turn-start-rpc',
          method: 'session/event',
          payload: {
            type: 'session/event',
            sessionId: state.sessionId,
            event: {
              type: 'turn/start',
              seq: 4,
              time: 4,
              data: { turn: 2 },
            },
          },
        })
        emit('mux', {
          type: 'server-request',
          rpcId: 'approval-rpc',
          method: 'approval/requested',
          payload: {
            type: 'approval/requested',
            sessionId: state.sessionId,
            approvalId: 'approval-1',
            toolName: 'shell',
            reason: '需要执行命令',
          },
        })
        emit('mux', {
          type: 'server-request',
          rpcId: 'question-rpc',
          method: 'question/requested',
          payload: {
            type: 'question/requested',
            sessionId: state.sessionId,
            questions: [{
              id: 'q1',
              question: '继续吗？',
              options: [{ label: '继续', description: '允许继续' }],
            }],
          },
        })
      }, 10)
    }
    return
  }

  if (request.method === 'POST' && request.url === '/api/session.cancel') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: {} },
    }))
    return
  }

  if (request.method === 'POST' && request.url === '/api/respond') {
    const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : ''
    if (rpcId === 'approval-rpc' || rpcId === 'question-rpc') {
      state.responded.add(rpcId)
      response.end(JSON.stringify({ accepted: true }))
      queueMicrotask(maybeFinishPrompt)
      return
    }
    response.end(JSON.stringify({ accepted: false, reason: 'not-pending' }))
    return
  }

  response.statusCode = 404
  response.end(JSON.stringify({ error: 'not found' }))
})

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string') {
    socket.end()
    return
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + websocketAccept(key),
    '',
    '',
  ].join('\r\n'))
  if (request.url === '/api/events.mux') {
    sockets.mux.add(socket)
    socket.on('close', () => sockets.mux.delete(socket))
    return
  }
  if (request.url === '/api/events.host') {
    sockets.host.add(socket)
    socket.on('close', () => sockets.host.delete(socket))
    return
  }
  socket.end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') {
  console.error('failed to read server address')
  process.exit(4)
}

console.log('dsh web: http://127.0.0.1:' + address.port)

const shutdown = async () => {
  for (const socket of sockets.mux) socket.end()
  for (const socket of sockets.host) socket.end()
  await new Promise((resolve) => server.close(resolve))
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
`;
  }
}

test('hosted DSH controller completes a real bridge-backed session lifecycle against a fake host', async () => {
  const runtime = await BridgeRuntimeFixture.create();
  const workspaceRoot = 'D:/Repos/rocketchatx';
  const sink = {
    approvals: [] as DshPendingApproval[],
    questions: [] as DshPendingQuestion[],
    traces: [] as DshServerRequest[],
    interrupted: [] as Error[],
    approvalResolved: [] as Array<[string, string]>,
    questionResolved: [] as Array<[string, string]>,
  };
  const controller = new HostedDshController(
    workspaceRoot,
    'hosted-room-bridge',
    options(runtime, sink),
  );

  try {
    await controller.connect();

    const sessionId = await controller.createSession();
    assert.equal(sessionId, 'session-bridge-1');

    await controller.resumeSession(sessionId);

    const prompting = controller.prompt(sessionId, '请总结当前变更');
    const approval = await waitFor('approval request', () => sink.approvals[0]);
    const question = await waitFor('question request', () => sink.questions[0]);

    assert.equal(approval.rpcId, 'approval-rpc');
    assert.equal(question.rpcId, 'question-rpc');

    await controller.respondApproval(approval, true);
    const answers: DshQuestionAnswer[] = [{ id: 'q1', selected: ['继续'] }];
    await controller.respondQuestion(question, answers);

    assert.deepEqual(await prompting, { turnId: 'turn-2', text: '桥接回答完成' });
    await waitFor('approval resolved', () => sink.approvalResolved[0]);
    await waitFor('question resolved', () => sink.questionResolved[0]);

    await controller.cancel(sessionId);
    await controller.stop();

    assert.deepEqual(sink.approvalResolved, [[sessionId, 'approval-1']]);
    assert.deepEqual(sink.questionResolved, [[sessionId, 'question-rpc']]);
    assert.equal(sink.interrupted.length, 0);
    assert.ok(sink.traces.some((request) => request.method === 'session/event'));
    assert.ok(sink.traces.some((request) => request.method === 'approval/requested'));
    assert.ok(sink.traces.some((request) => request.method === 'question/requested'));

    const serverLog = (await readFile(runtime.serverLogPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { path: string; body: { method?: string; payload?: Record<string, unknown>; rpcId?: string } | null });

    assert.ok(serverLog.some((entry) => entry.path === '/api/host.describe' && entry.body?.method === 'host.describe'));
    assert.ok(serverLog.some((entry) => (
      entry.path === '/api/session.create'
      && entry.body?.payload?.cwd === workspaceRoot
    )));
    assert.ok(serverLog.some((entry) => (
      entry.path === '/api/session.history'
      && entry.body?.payload?.sessionId === sessionId
    )));
    assert.ok(serverLog.some((entry) => (
      entry.path === '/api/session.prompt'
      && Array.isArray(entry.body?.payload?.content)
      && (entry.body?.payload?.content as Array<{ text?: string }>)[0]?.text === '请总结当前变更'
    )));
    assert.ok(serverLog.some((entry) => entry.path === '/api/respond' && entry.body?.rpcId === 'approval-rpc'));
    assert.ok(serverLog.some((entry) => entry.path === '/api/respond' && entry.body?.rpcId === 'question-rpc'));
    assert.ok(serverLog.some((entry) => (
      entry.path === '/api/session.cancel'
      && entry.body?.payload?.sessionId === sessionId
    )));
  } finally {
    await controller.stop().catch(() => undefined);
    await runtime.dispose();
  }
});
