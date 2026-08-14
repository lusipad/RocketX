import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const bridgeScript = path.resolve('apps/desktop/src-tauri/src/dsh_bridge.mjs');

function websocketAccept(key: string): string {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'utf8')
    .digest('base64');
}

function websocketFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([
      Buffer.from([0x81, payload.length]),
      payload,
    ]);
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

test('DSH bridge wraps logs, enforces the method allowlist, and forwards mux/host/respond/shutdown', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rocketx-dsh-bridge-'));
  const patchPath = path.join(tempRoot, 'fixture.patch.yml');
  const cliPath = path.join(tempRoot, 'fake-dsh-cli.mjs');
  const serverLogPath = path.join(tempRoot, 'fixture-server-log.jsonl');
const fixtureScript = String.raw`
import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import http from 'node:http'

const [, , profileFlag, profileName, patchFlag, patchPath, portFlag, portValue] = process.argv
if (profileFlag !== '--profile'
  || profileName !== 'web'
  || patchFlag !== '--patch'
  || !patchPath
  || portFlag !== '--port'
  || portValue !== '0') {
  console.error('unexpected argv', process.argv.slice(2))
  process.exit(2)
}

const serverLog = process.env.DSH_BRIDGE_FIXTURE_LOG
if (!serverLog) {
  console.error('missing DSH_BRIDGE_FIXTURE_LOG')
  process.exit(3)
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

const sockets = { mux: null, host: null }

const server = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const bodyText = Buffer.concat(chunks).toString('utf8')
  const body = bodyText === '' ? null : JSON.parse(bodyText)
  await log({ path: request.url, body })
  response.setHeader('content-type', 'application/json')
  if (request.method === 'POST' && request.url === '/api/session.list') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { items: [{ id: 'session-1' }] } },
    }))
    return
  }
  if (request.method === 'POST' && request.url === '/api/settings.describe') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { writable: true, hasDocument: true, namespaces: [] } },
    }))
    return
  }
  if (request.method === 'POST' && [
    '/api/session.models',
    '/api/session.selectModel',
    '/api/agentPreset.list',
    '/api/agentPreset.select',
    '/api/settings.update',
    '/api/settings.mutate',
    '/api/llm.models',
    '/api/commands/execute',
  ].includes(request.url)) {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: {} },
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
  if (request.method === 'POST' && request.url === '/api/credentials.set') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: {} },
    }))
    return
  }
  if (request.method === 'POST' && request.url === '/api/credentials.unset') {
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: {} },
    }))
    return
  }
  if (request.method === 'POST' && request.url === '/api/respond') {
    response.end(JSON.stringify(body.rpcId === 'mux-req'
      ? { accepted: true }
      : { accepted: false, reason: 'not-pending' }))
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
    sockets.mux = socket
    socket.write(websocketFrame(JSON.stringify({
      type: 'server-request',
      rpcId: 'mux-req',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
    })))
  } else if (request.url === '/api/events.host') {
    sockets.host = socket
    socket.write(websocketFrame(JSON.stringify({
      type: 'server-request',
      rpcId: 'host-req',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    })))
  } else {
    socket.end()
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') {
  console.error('failed to read server address')
  process.exit(4)
}

console.log('booting fake dsh web host')
console.error('stderr ready line')
console.log('dsh web: http://127.0.0.1:' + address.port)

const shutdown = async () => {
  sockets.mux?.end()
  sockets.host?.end()
  await new Promise((resolve) => server.close(resolve))
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
`;

  await writeFile(patchPath, '# fixture patch\n', 'utf8');
  await writeFile(cliPath, fixtureScript, 'utf8');

  const child = spawn(process.execPath, [bridgeScript, cliPath, patchPath], {
    cwd: process.cwd(),
    env: { ...process.env, DSH_BRIDGE_FIXTURE_LOG: serverLogPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closePromise = once(child, 'close');
  child.stdin.setDefaultEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const stdoutLines: string[] = [];
  const stderrChunks: string[] = [];
  let stdoutBuffer = '';
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let boundary = stdoutBuffer.indexOf('\n');
    while (boundary !== -1) {
      stdoutLines.push(stdoutBuffer.slice(0, boundary));
      stdoutBuffer = stdoutBuffer.slice(boundary + 1);
      boundary = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderrChunks.push(chunk);
  });

  const deadline = Date.now() + 15_000;
  const waitForFrame = async (predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (;;) {
      for (const line of stdoutLines) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (predicate(frame)) return frame;
      }
      assert.ok(Date.now() < deadline, `timed out waiting for frame\n${stdoutLines.join('\n')}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  try {
    const ready = await waitForFrame((frame) => frame.kind === 'ready');
    assert.match(String(ready.url), /^http:\/\/127\.0\.0\.1:\d+$/);

    const logFrames = stdoutLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((frame) => frame.kind === 'log');
    assert.ok(logFrames.some((frame) => frame.stream === 'dsh.stdout' && frame.message === 'booting fake dsh web host'));
    assert.ok(logFrames.some((frame) => frame.stream === 'dsh.stderr' && frame.message === 'stderr ready line'));

    child.stdin.write(JSON.stringify({
      id: 'call-session-list',
      kind: 'call',
      method: 'session.list',
      payload: {},
    }) + '\n');
    child.stdin.write(JSON.stringify({
      id: 'call-settings-describe',
      kind: 'call',
      method: 'settings.describe',
      payload: {},
    }) + '\n');
    const configurationCalls = [
      ['session.models', { sessionId: 'session-1' }],
      ['session.selectModel', { sessionId: 'session-1', provider: 'deepseek-official', model: 'deepseek-chat' }],
      ['agentPreset.list', {}],
      ['agentPreset.select', { sessionId: 'session-1', agentPreset: 'standard' }],
      ['settings.update', { ns: 'agent-presets', patch: { default: 'standard' } }],
      ['settings.mutate', { ns: 'permission', ops: [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }] }],
      ['llm.models', {}],
      ['commands/execute', { args: { agentId: 'session-1', line: '/permission workspace-write' } }],
    ] as const;
    for (const [method, payload] of configurationCalls) {
      child.stdin.write(JSON.stringify({ id: `call-${method}`, kind: 'call', method, payload }) + '\n');
    }
    child.stdin.write(JSON.stringify({
      id: 'call-settings-replace',
      kind: 'call',
      method: 'settings.replace',
      payload: { ns: 'permission', section: {} },
    }) + '\n');
    child.stdin.write(JSON.stringify({
      id: 'call-credentials-describe',
      kind: 'call',
      method: 'credentials.describe',
      payload: { refs: ['DEEPSEEK_API_KEY'] },
    }) + '\n');
    child.stdin.write(JSON.stringify({
      id: 'call-credentials-set',
      kind: 'call',
      method: 'credentials.set',
      payload: { ref: 'DEEPSEEK_API_KEY', value: 'secret-value' },
    }) + '\n');
    child.stdin.write(JSON.stringify({
      id: 'call-credentials-unset',
      kind: 'call',
      method: 'credentials.unset',
      payload: { ref: 'DEEPSEEK_API_KEY' },
    }) + '\n');
    child.stdin.write(JSON.stringify({
      id: 'respond-mux',
      kind: 'respond',
      response: {
        type: 'client-response',
        rpcId: 'mux-req',
        result: { ok: true, value: { answer: 'ok' } },
      },
    }) + '\n');

    const sessionResponse = await waitForFrame((frame) => frame.kind === 'response' && frame.id === 'call-session-list');
    assert.equal(sessionResponse.op, 'call');
    assert.equal((sessionResponse.response as { type: string }).type, 'server-response');
    assert.deepEqual(
      ((sessionResponse.response as { result: { ok: boolean; value: { items: Array<{ id: string }> } } }).result.value.items),
      [{ id: 'session-1' }],
    );

    const settingsResponse = await waitForFrame((frame) => frame.kind === 'response' && frame.id === 'call-settings-describe');
    assert.deepEqual((settingsResponse.response as {
      result: { ok: boolean; value: { writable: boolean; namespaces: unknown[] } };
    }).result.value, { writable: true, hasDocument: true, namespaces: [] });

    for (const [method] of configurationCalls) {
      const response = await waitForFrame((frame) => frame.kind === 'response' && frame.id === `call-${method}`);
      assert.equal((response.response as { result: { ok: boolean } }).result.ok, true);
    }

    const blockedResponse = await waitForFrame((frame) => frame.kind === 'response' && frame.id === 'call-settings-replace');
    const blockedResult = (blockedResponse.response as { result: { ok: boolean; error: { code: string; message: string } } }).result;
    assert.equal(blockedResult.ok, false);
    assert.equal(blockedResult.error.code, 'bad-request');
    assert.match(blockedResult.error.message, /not allowed by the DSH bridge/);

    const credentialsDescribeResponse = await waitForFrame((frame) => frame.kind === 'response' && frame.id === 'call-credentials-describe');
    assert.equal(credentialsDescribeResponse.op, 'call');
    assert.deepEqual(
      (credentialsDescribeResponse.response as {
        result: {
          ok: boolean;
          value: { credentials: Record<string, { source: string; configured: boolean; writable: boolean }> };
        };
      }).result.value,
      {
        credentials: {
          DEEPSEEK_API_KEY: { source: 'env', configured: true, writable: false },
        },
      },
    );

    const credentialsSetResponse = await waitForFrame((frame) => frame.kind === 'response' && frame.id === 'call-credentials-set');
    assert.equal(credentialsSetResponse.op, 'call');
    assert.deepEqual(
      (credentialsSetResponse.response as { result: { ok: boolean; value: Record<string, never> } }).result.value,
      {},
    );

    const credentialsUnsetResponse = await waitForFrame((frame) => frame.kind === 'response' && frame.id === 'call-credentials-unset');
    assert.equal(credentialsUnsetResponse.op, 'call');
    assert.deepEqual(
      (credentialsUnsetResponse.response as { result: { ok: boolean; value: Record<string, never> } }).result.value,
      {},
    );
    assert.doesNotMatch(stdoutLines.join('\n'), /secret-value/);

    const respondReceipt = await waitForFrame((frame) => frame.kind === 'response' && frame.id === 'respond-mux');
    assert.deepEqual(respondReceipt.response, { accepted: true });

    const muxFrame = await waitForFrame((frame) => frame.kind === 'mux');
    assert.equal((muxFrame.envelope as { method: string }).method, 'session/subscribed');
    const hostFrame = await waitForFrame((frame) => frame.kind === 'host');
    assert.equal((hostFrame.envelope as { method: string }).method, 'host/remote-event');

    child.stdin.write(JSON.stringify({ kind: 'shutdown' }) + '\n');
    const exitFrame = await waitForFrame((frame) => frame.kind === 'exit');
    if (process.platform === 'win32') {
      // Windows shutdown now prefers `taskkill /T /F`: the fake DSH process is
      // force-terminated as a tree, so the child no longer exits with the
      // earlier graceful 0/SIGTERM shape. What matters here is that the bridge
      // observed a concrete child exit before it could finish its own shutdown.
      assert.ok(typeof exitFrame.code === 'number' || typeof exitFrame.signal === 'string');
    } else {
      assert.ok(exitFrame.code === 0 || exitFrame.signal === 'SIGTERM');
    }
    const [bridgeCode, bridgeSignal] = await closePromise;
    assert.equal(bridgeSignal, null);
    assert.equal(bridgeCode, 0);

    const serverLog = (await readFile(serverLogPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { path: string; body: { method?: string; rpcId?: string } | null });
    assert.ok(serverLog.some((entry) => entry.path === '/api/session.list' && entry.body?.method === 'session.list'));
    assert.ok(serverLog.some((entry) => entry.path === '/api/credentials.describe' && entry.body?.method === 'credentials.describe'));
    assert.ok(serverLog.some((entry) => entry.path === '/api/credentials.set' && entry.body?.method === 'credentials.set'));
    for (const [method] of configurationCalls) {
      assert.ok(serverLog.some((entry) => entry.path === `/api/${method}` && entry.body?.method === method));
    }
    assert.ok(serverLog.some((entry) => entry.path === '/api/respond' && entry.body?.rpcId === 'mux-req'));
    assert.ok(serverLog.some((entry) => entry.path === '/api/settings.describe'));
    assert.ok(!serverLog.some((entry) => entry.path === '/api/settings.replace'));

    for (const line of stdoutLines) JSON.parse(line);
    assert.ok(!stdoutLines.some((line) => (JSON.parse(line) as { kind?: string }).kind === 'fatal'));
    assert.equal(stderrChunks.join(''), '');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(tempRoot, { recursive: true, force: true });
  }
});
