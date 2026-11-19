/** Explicit live smoke: creates an isolated CODEX_HOME/repo and spends two model turns. Never targets user threads. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import readline from 'node:readline';

async function main(): Promise<void> {
const packageResolve = createRequire(path.join(process.cwd(), 'package.json'));
const packageRequire = createRequire(packageResolve.resolve('@openai/codex/package.json'));
const triples: Record<string, string> = { 'win32-x64': 'x86_64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-musl', 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-arm64': 'aarch64-unknown-linux-musl', 'win32-arm64': 'aarch64-pc-windows-msvc' };
const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
const binary = process.env.ROCKETX_CODEX_TEST_BINARY || path.join(path.dirname(packageRequire.resolve(`${platformPackage}/package.json`)), 'vendor', triples[`${process.platform}-${process.arch}`]!, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketx-s2-live-'));
const repo = path.join(root, 'repo');
const codexHome = path.join(root, 'codex-home');
fs.mkdirSync(repo); fs.mkdirSync(codexHome);
const originalHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
for (const name of ['config.toml', 'auth.json']) {
  const source = path.join(originalHome, name);
  if (fs.existsSync(source)) { fs.copyFileSync(source, path.join(codexHome, name)); fs.chmodSync(path.join(codexHome, name), 0o600); }
}
const env = { ...process.env, CODEX_HOME: codexHome };
let testModel = process.env.ROCKETX_CODEX_TEST_MODEL;
const marker = `ROCKETX_S2_${Date.now()}`;
let child: ReturnType<typeof spawn> | undefined;
const createdThroughBridge = process.argv.includes('--new-session');
const connectBridge = (nativeId?: string) => {
  const processChild = spawn(process.execPath, ['apps/desktop/src-tauri/src/acp_bridge.mjs', '--adapter', 'codex', '--bin', binary, '--cwd', repo, ...(nativeId ? ['--resume-session', nativeId] : []), '--', '--profile', 'rocketx_s2_handoff'], { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child = processChild;
  let nextId = 1;
  let text = '';
  let nativeIdentity: { nativeSessionId: string; workspaceRoot: string; sourceScope: string } | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readline.createInterface({ input: processChild.stdout! }).on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const update = message.params?.update;
    if (message.method === 'session/update' && update?.sessionUpdate === 'agent_message_chunk') text += update.content.text ?? '';
    if (message.method === 'session/update' && update?.sessionUpdate === 'rocketx_native_session') nativeIdentity = update;
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 120_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    processChild.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { rpc, text: () => text, nativeIdentity: () => nativeIdentity, close: async () => {
    processChild.stdin!.end();
    await new Promise<void>((resolve) => { if (processChild.exitCode !== null) return resolve(); processChild.once('close', () => resolve()); setTimeout(() => { processChild.kill(); resolve(); }, 3000).unref(); });
  } };
};
try {
  const help = spawnSync(binary, ['exec', 'resume', '--help'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(help.status, 0, 'Codex exec resume must be available');
  const catalog = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: repo, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let catalogId = 1;
    const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    readline.createInterface({ input: catalog.stdout }).on('line', (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const request = waiting.get(message.id); if (!request) return;
      waiting.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    });
    const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = catalogId++;
      const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`Model catalog timeout: ${method}`)); }, 30_000);
      waiting.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
      catalog.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    await request('initialize', { clientInfo: { name: 'rocketx-native-handoff-smoke', title: 'RocketX isolated native handoff smoke', version: '1' }, capabilities: { experimentalApi: true } });
    catalog.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const models = await request('model/list', { includeHidden: false });
    assert.ok(models.data?.length, 'Current account has no visible Codex models');
    const selected = models.data.find((model: any) => model.isDefault) ?? models.data[0];
    testModel ??= selected.model ?? selected.id;
    console.log(JSON.stringify({ modelCatalog: models.data.map((model: any) => ({ id: model.id, model: model.model, isDefault: model.isDefault })), selectedModel: testModel }));
  } finally { catalog.stdin.end(); catalog.kill(); }
  fs.writeFileSync(path.join(codexHome, 'rocketx_s2_handoff.config.toml'), `model_reasoning_effort = "low"\n${testModel ? `model = ${JSON.stringify(testModel)}\n` : ''}`, { mode: 0o600 });
  let nativeId: string | undefined;
  if (createdThroughBridge) {
    const first = connectBridge();
    await first.rpc('initialize', {});
    const created = await first.rpc('session/new', { cwd: repo, mcpServers: [] });
    assert.ok(created.sessionId.startsWith('acp-bridge-'));
    await first.rpc('session/set_mode', { sessionId: created.sessionId, modeId: 'plan' });
    await first.rpc('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: `Reply exactly ${marker}. Do not use tools.` }] });
    assert.ok(first.text().includes(marker));
    nativeId = first.nativeIdentity()?.nativeSessionId;
    assert.ok(nativeId && nativeId !== created.sessionId, 'New bridge sessions must expose the real native ID');
    await first.close();
  } else {
  const initial = spawnSync(binary, ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', repo, ...(testModel ? ['-m', testModel] : []), '-'], { cwd: repo, env, input: `Reply exactly ${marker}. Do not use tools.`, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const initialEvents = initial.stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  if (initial.status !== 0) {
    const failure = initialEvents.filter((event) => event.type === 'error' || event.type === 'turn.failed').map((event) => event.message ?? event.error?.message).filter(Boolean).join('; ') || initial.stderr.slice(-1200);
    const redacted = failure.replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
    throw new Error(`Dedicated initial Codex turn failed: ${redacted.slice(0, 1200)} (no user thread was modified)`);
  }
  nativeId = initialEvents.find((event) => event.type === 'thread.started')?.thread_id as string | undefined;
  }
  assert.ok(nativeId, 'Initial native thread ID must be recorded');
  const resumed = connectBridge(nativeId);
  const rpc = resumed.rpc;
  await rpc('initialize', {});
  await assert.rejects(rpc('session/load', { sessionId: 'wrong-session', cwd: repo }), /交接/);
  await rpc('session/load', { sessionId: nativeId, cwd: repo });
  await rpc('session/set_mode', { sessionId: nativeId, modeId: 'plan' });
  await rpc('session/prompt', { sessionId: nativeId, prompt: [{ type: 'text', text: 'What exact marker did you just return? Reply only with that marker. Do not use tools.' }] });
  assert.ok(resumed.text().includes(marker), 'Original native conversation context must survive resume');
  assert.equal(resumed.nativeIdentity()?.nativeSessionId, nativeId);
  const rollouts: string[] = [];
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const item = path.join(dir, entry.name); if (entry.isDirectory()) walk(item); else if (entry.name.endsWith('.jsonl')) rollouts.push(item); } };
  walk(path.join(codexHome, 'sessions'));
  const original = rollouts.map((file) => ({ file, rows: fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) })).find(({ rows }) => rows.some((row) => row.type === 'session_meta' && row.payload?.id === nativeId));
  assert.ok(original);
  assert.ok(original.rows.filter((row) => row.type === 'event_msg' && row.payload?.type === 'user_message').length >= 2, 'Both turns must be in the original native log');
  const meta = original.rows.find((row) => row.type === 'session_meta')!.payload;
  assert.equal(path.resolve(meta.cwd).toLowerCase(), path.resolve(repo).toLowerCase());
  console.log(JSON.stringify({ passed: true, createdThroughBridge, nativeIdPreserved: true, cwdPreserved: true, customCodexHomePreserved: true, namedProfilePreserved: true, originalLogContainsBothTurns: true, wrongIdentityRejected: true }));
} finally {
  if (child) { child.stdin?.end(); await new Promise<void>((resolve) => { if (child!.exitCode !== null) return resolve(); child!.once('close', () => resolve()); setTimeout(() => { child!.kill(); resolve(); }, 3000).unref(); }); }
  // Resolve and verify the precise generated directory before recursive cleanup.
  const resolved = path.resolve(root);
  assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('rocketx-s2-live-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
