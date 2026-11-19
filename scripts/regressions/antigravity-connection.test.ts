import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const bridge = import(pathToFileURL(path.resolve('apps/desktop/src-tauri/src/acp_bridge.mjs')).href);
const serverPath = path.resolve('fixture-antigravity/resources/bin/language_server.exe');
const nowMs = Date.now();
const processInfo = { pid: 1234, path: serverPath, startedAtMs: nowMs - 20_000 };
const hub = { pid: 1234, httpPort: 45678, httpsPort: 45679, lsVersion: '2.32.1', csrfToken: 'fixture-only-token' };

test('Antigravity 仅采用与存活服务身份和启动时间匹配的本地记录', async () => {
  const { validateAntigravityHubCandidate } = await bridge;
  const options = { filename: 'hub_45678.json', mtimeMs: nowMs - 10_000, processInfo, serverPath, nowMs };
  const valid = validateAntigravityHubCandidate(hub, options);
  assert.equal(valid?.address, '127.0.0.1:45678');
  assert.equal(valid?.csrfToken, 'fixture-only-token');
  for (const invalid of [
    { ...hub, pid: -1 },
    { ...hub, pid: '1234' },
    { ...hub, httpPort: 0 },
    { ...hub, httpPort: 65536 },
    { ...hub, httpPort: '45678' },
    { ...hub, csrfToken: '' },
  ]) assert.equal(validateAntigravityHubCandidate(invalid, options), null);
  assert.equal(validateAntigravityHubCandidate(hub, { ...options, processInfo: null }), null);
  assert.equal(validateAntigravityHubCandidate(hub, { ...options, processInfo: { ...processInfo, pid: 999 } }), null);
  assert.equal(validateAntigravityHubCandidate(hub, { ...options, processInfo: { ...processInfo, path: path.resolve('other/language_server.exe') } }), null);
  assert.equal(validateAntigravityHubCandidate(hub, { ...options, mtimeMs: nowMs - 120_000 }), null);
  assert.equal(validateAntigravityHubCandidate(hub, { ...options, filename: 'hub_11111.json' }), null);
});

test('Antigravity 自动发现忽略陈旧记录，有多个存活服务时不擅自选择', async () => {
  const { resolveAntigravityConnection } = await bridge;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-antigravity-discovery-'));
  const directory = path.join(homeDir, '.gemini', 'antigravity', 'daemon');
  fs.mkdirSync(directory, { recursive: true });
  const writeHub = (value: typeof hub) => fs.writeFileSync(path.join(directory, `hub_${value.httpPort}.json`), JSON.stringify(value));
  const processes = new Map([[1234, processInfo]]);
  const options = { env: {}, platform: 'win32', homeDir, readProcess: async (pid: number) => processes.get(pid) ?? null };
  try {
    writeHub(hub);
    writeHub({ ...hub, pid: 5678, httpPort: 45680 });
    fs.writeFileSync(path.join(directory, 'hub_9999.json'), '{broken');
    const connection = await resolveAntigravityConnection({ binPath: serverPath }, options);
    assert.equal(connection.source, 'hub');
    assert.equal(connection.env.ANTIGRAVITY_LS_ADDRESS, '127.0.0.1:45678');
    assert.equal(connection.env.ANTIGRAVITY_CSRF_TOKEN, 'fixture-only-token');
    processes.set(5678, { ...processInfo, pid: 5678 });
    await assert.rejects(resolveAntigravityConnection({ binPath: serverPath }, options), /多个|唯一|不确定/);
    processes.clear();
    await assert.rejects(resolveAntigravityConnection({ binPath: serverPath }, options), /Antigravity/);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('Antigravity 明确侧车环境只允许完整的本地连接，不将令牌送往远程地址', async () => {
  const { resolveAntigravityConnection } = await bridge;
  const env = { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45678', ANTIGRAVITY_CSRF_TOKEN: 'fixture-only-token' };
  const connection = await resolveAntigravityConnection({ binPath: serverPath }, { env });
  assert.equal(connection.source, 'environment');
  assert.equal(connection.env.ANTIGRAVITY_LS_ADDRESS, env.ANTIGRAVITY_LS_ADDRESS);
  await assert.rejects(resolveAntigravityConnection({ binPath: serverPath }, { env: { ...env, ANTIGRAVITY_LS_ADDRESS: 'example.org:45678' } }), /本地|地址|连接/);
});

const nativeId = '10000000-0000-0000-0000-000000000001';
async function sessionFixture() {
  const { AcpBridgeServer } = await bridge;
  const server = new AcpBridgeServer({ adapter: 'antigravity', binPath: serverPath, defaultCwd: os.tmpdir(), extraArgs: [] });
  const calls: string[][] = [];
  const messages: any[] = [];
  let connection = { binPath: serverPath, prefixArgs: ['agentapi'], env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45678', ANTIGRAVITY_CSRF_TOKEN: 'fixture-only-token' } };
  let metadata: any = { response: { conversationMetadata: { metadata: { id: nativeId } } } };
  let sendResult: any = { code: 0, stdout: JSON.stringify({ response: { sendMessage: { recipientId: nativeId } } }), stderr: '' };
  server.sendJson = (message: any) => messages.push(message);
  server.ensureAntigravityConnection = async () => connection;
  server.runAntigravityCommand = async (_connection: any, args: string[]) => {
    calls.push(args);
    if (args[0] === 'get-conversation-metadata') return { code: metadata.error ? 1 : 0, stdout: JSON.stringify(metadata), stderr: '' };
    return sendResult;
  };
  return { server, calls, messages,
    setMetadata: (value: any) => { metadata = value; },
    setSendResult: (value: any) => { sendResult = value; },
    restart: () => { connection = { ...connection, env: { ...connection.env, ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45680' } }; },
  };
}

test('Antigravity 原会话经过两次身份核对后只发送一次，不把提交回执当任务完成', async () => {
  const fixture = await sessionFixture();
  await fixture.server.dispatchRequest('session/load', { sessionId: nativeId, cwd: os.tmpdir() });
  fixture.restart(); // 服务重启可重新验证相同原会话，不要求用户再次导入。
  await fixture.server.dispatchRequest('session/set_mode', { sessionId: nativeId, modeId: 'auto' });
  const prompt = '按方案 1 执行，保留 "标题" 与 $() 字面内容';
  await fixture.server.dispatchRequest('session/prompt', { sessionId: nativeId, prompt: [{ type: 'text', text: prompt }] });
  assert.deepEqual(fixture.calls, [
    ['get-conversation-metadata', nativeId],
    ['get-conversation-metadata', nativeId],
    ['send-message', nativeId, prompt],
  ]);
  assert.equal(fixture.server.sessions.get(nativeId).backendSessionId, nativeId);
  assert.match(JSON.stringify(fixture.messages), /尚未确认任务完成/);
});

test('Antigravity 不存在或身份冲突的会话不能恢复，也不能新建替代原会话', async () => {
  for (const metadata of [
    { error: 'NotFound' },
    { response: {} },
    { response: { conversationMetadata: { metadata: [] } } },
    { response: { conversationMetadata: { metadata: { id: 'another-session' } } } },
  ]) {
    const fixture = await sessionFixture();
    fixture.setMetadata(metadata);
    await assert.rejects(fixture.server.dispatchRequest('session/load', { sessionId: nativeId }), /原会话|身份/);
    assert.equal(fixture.server.sessions.size, 0);
    assert.equal(fixture.calls.some((args) => args[0] === 'send-message' || args[0] === 'new-conversation'), false);
  }
  const fixture = await sessionFixture();
  await assert.rejects(fixture.server.dispatchRequest('session/new', {}), /Antigravity.*新建/);
  assert.equal(fixture.calls.length, 0);
});

test('Antigravity 在发送前重新确认会话，失效时不发送任何工作要求', async () => {
  const fixture = await sessionFixture();
  await fixture.server.dispatchRequest('session/load', { sessionId: nativeId });
  fixture.setMetadata({ error: 'NotFound' });
  await assert.rejects(fixture.server.runAntigravityTurn(fixture.server.sessions.get(nativeId), '继续', 'auto'), /原会话/);
  assert.equal(fixture.calls.filter((args) => args[0] === 'send-message').length, 0);
});

test('Antigravity 失败、超时和回执对象不匹配都传播失败且不会自动重发', async () => {
  for (const result of [
    { code: 1, stdout: JSON.stringify({ error: 'connection refused' }), stderr: '' },
    { code: 0, stdout: 'not-json', stderr: '' },
    { code: 0, timedOut: true, stdout: '{}', stderr: '' },
    { code: 0, stdout: JSON.stringify({ response: { sendMessage: { recipientId: 'another-session' } } }), stderr: '' },
  ]) {
    const fixture = await sessionFixture();
    await fixture.server.dispatchRequest('session/load', { sessionId: nativeId });
    await fixture.server.dispatchRequest('session/set_mode', { sessionId: nativeId, modeId: 'auto' });
    fixture.setSendResult(result);
    await fixture.server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: nativeId, prompt: [{ type: 'text', text: '继续' }] } });
    const response = fixture.messages.find((message) => message.id === 3);
    assert.match(response.error.message, /未收到.*回执/);
    assert.equal(response.result, undefined);
    assert.equal(fixture.calls.filter((args) => args[0] === 'send-message').length, 1);
    assert.equal(fixture.server.sessions.get(nativeId).backendSessionId, nativeId);
  }
});

test('Antigravity 只读模式不能意外提交可写任务', async () => {
  const fixture = await sessionFixture();
  await fixture.server.dispatchRequest('session/load', { sessionId: nativeId });
  await assert.rejects(fixture.server.runAntigravityTurn(fixture.server.sessions.get(nativeId), '修改文件', 'plan'), /只读.*未发送/);
  assert.equal(fixture.calls.filter((args) => args[0] === 'send-message').length, 0);
});
