/**
 * 真实本地 RC 汇报验收：pnpm exec tsx scripts/smoke-local-report-delivery.ts
 * 仅允许 rocketx-acceptance-20261115 隔离栈的 127.0.0.1:3301。
 * 使用 compose 开发管理员，临时频道与无凭据存储文件在 finally 清理。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportActionSpec } from '../apps/web/src/agent/externalActionExecutor';

const base = 'http://127.0.0.1:3301';
const project = 'rocketx-acceptance-20261115';
const records = new Map<string, string>();
const originalFetch = globalThis.fetch;
let storageFile: string;
let sends = 0;
let loseNextReceipt = false;
let readOnly = false;

function installStorage(file: string) {
  storageFile = file;
  try {
    for (const [key, value] of JSON.parse(readFileSync(file, 'utf8')) as Array<[string, string]>) records.set(key, value);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const persist = () => writeFileSync(file, JSON.stringify([...records].filter(([key]) => key !== 'rcx-auth')), { mode: 0o600 });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, String(value)); persist(); },
    removeItem: (key: string) => { records.delete(key); persist(); },
    clear: () => { records.clear(); persist(); },
    key: (index: number) => [...records.keys()][index] ?? null,
    get length() { return records.size; },
  } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, base, '验收请求不得离开隔离 RC 实例');
    const isSend = url.pathname === '/api/v1/chat.sendMessage';
    if (readOnly) assert.equal(init?.method ?? 'GET', 'GET', '重启对账期间只能读取');
    if (isSend) sends += 1;
    const response = await originalFetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
    if (!response.ok && url.pathname !== '/api/v1/login') {
      const failure = await response.clone().json().catch(() => ({})) as { error?: string; errorType?: string; message?: string };
      console.log(JSON.stringify({ check: 'rc-http-failure', path: url.pathname, status: response.status,
        error: failure.error, errorType: failure.errorType, message: failure.message,
        responseKeys: Object.keys(failure), contentType: response.headers.get('content-type') }));
    }
    if (isSend && loseNextReceipt && response.ok) {
      loseNextReceipt = false;
      await response.arrayBuffer();
      throw new TypeError('验收故障注入：真实服务已接收，客户端回执丢失');
    }
    return response;
  };
}

function assertIsolatedStack() {
  const inspect = JSON.parse(execFileSync('docker', ['inspect', `${project}-rocketchat-1`, `${project}-mongodb-1`], { encoding: 'utf8' })) as Array<{
    Config: { Labels: Record<string, string> }; State: { Health?: { Status: string } };
    NetworkSettings: { Ports: Record<string, Array<{ HostPort: string }> | null> };
    Mounts: Array<{ Name?: string }>;
  }>;
  assert.equal(inspect.length, 2);
  for (const container of inspect) {
    assert.equal(container.Config.Labels['com.docker.compose.project'], project);
    assert.equal(container.State.Health?.Status, 'healthy');
  }
  assert.ok(inspect[0].NetworkSettings.Ports['3000/tcp']?.every((port) => port.HostPort === '3301'));
  assert.ok(inspect[1].Mounts.some((mount) => mount.Name === `${project}_mongodb_data`));
}

async function connect() {
  records.set('rcx-server', base);
  const [{ rest }, { useAuth }, { useChat }, { useWorkLedger }, external] = await Promise.all([
    import('../apps/web/src/lib/client'), import('../apps/web/src/stores/auth'),
    import('../apps/web/src/stores/chat'), import('../apps/web/src/stores/workLedger'),
    import('../apps/web/src/agent/externalWorkActions'),
  ]);
  const compose = readFileSync(new URL('../docker/docker-compose.yml', import.meta.url), 'utf8');
  const username = compose.match(/ADMIN_USERNAME: \$\{ROCKETCHAT_ADMIN_USERNAME:-([^}]+)\}/)?.[1];
  const password = compose.match(/ADMIN_PASS: \$\{ROCKETCHAT_ADMIN_PASSWORD:-([^}]+)\}/)?.[1];
  assert.ok(username && password, 'compose 缺少隔离开发账号');
  const auth = await rest.login(username, password);
  records.set('rcx-auth', JSON.stringify({ authToken: auth.authToken, userId: auth.userId }));
  records.set('rcx-owner', `${base}:${auth.userId}`);
  useAuth.setState({ status: 'authed', localMode: false, user: auth.me });
  const subscriptions = await rest.getSubscriptions();
  useChat.setState({ subscriptions: Object.fromEntries(subscriptions.map((sub) => [sub.rid, sub])) });
  return { rest, useWorkLedger, ...external };
}

async function verifyRestart() {
  const [, , , file, workId, actionId] = process.argv;
  assert.ok(path.basename(path.dirname(file)).startsWith('rocketx-report-acceptance-'));
  assert.equal(path.dirname(path.dirname(path.resolve(file))), path.resolve(tmpdir()));
  installStorage(file);
  const p = await connect();
  await p.useWorkLedger.getState().hydrate();
  const action = p.useWorkLedger.getState().actions.find((item) => item.id === actionId);
  assert.equal(action?.state, 'verifying_delivery');
  assert.ok(p.useWorkLedger.getState().cards.some((card) => card.id === workId));
  const spec = JSON.parse(action.specJson) as ReportActionSpec;
  readOnly = true;
  await p.reconcileExternalWorkActions();
  assert.equal(p.useWorkLedger.getState().actions.find((item) => item.id === actionId)?.state, 'acknowledged');
  const duplicate = await p.publishWorkReport({ workId, rid: spec.rid, reportId: spec.reportId,
    reportTitle: spec.reportTitle, reportGeneratedAt: spec.reportGeneratedAt, markdown: '重启后不可覆盖旧快照' });
  assert.equal(duplicate.state, 'acknowledged');
  assert.equal(sends, 0);
  console.log(JSON.stringify({ check: 'fresh-process-reconcile', state: duplicate.state, messageWrites: sends }));
}

async function main() {
  assertIsolatedStack();
  if (process.argv[2] === '--reconcile') return verifyRestart();
  const directory = mkdtempSync(path.join(tmpdir(), 'rocketx-report-acceptance-'));
  installStorage(path.join(directory, 'storage.json'));
  let rid: string | undefined;
  let cleanup: Awaited<ReturnType<typeof connect>>['rest'] | undefined;
  try {
    const p = await connect();
    cleanup = p.rest;
    const name = `rcx-acceptance-${Date.now()}`;
    const created = await p.rest.request<{ channel: { _id: string } }>('POST', 'channels.create', { name });
    rid = created.channel._id;
    const { useChat } = await import('../apps/web/src/stores/chat');
    const subscriptions = await p.rest.getSubscriptions();
    useChat.setState({ subscriptions: Object.fromEntries(subscriptions.map((sub) => [sub.rid, sub])) });
    const card = await p.useWorkLedger.getState().createCard({ requestId: name, title: '本地真实汇报验收',
      goal: '验证真实投递、幂等和重启只读核对', acceptance: ['实际消息与冻结快照一致'],
      rid, visibility: 'room_shared', autonomyMode: 'autonomous', enroll: true });
    const input = { workId: card.id, rid, reportTitle: '隔离验收汇报', reportGeneratedAt: Date.now() };
    const normal = await p.publishWorkReport({ ...input, reportId: `${name}-multipart`,
      markdown: '仅限本地隔离验收：真实发送、快照和稳定消息 ID。\n'.repeat(400) });
    assert.equal(normal.state, 'acknowledged', normal.errorMessage ?? '真实分段汇报未确认');
    const normalSpec = JSON.parse(normal.specJson) as ReportActionSpec;
    assert.ok(normalSpec.parts.length > 1, '必须覆盖真实分段汇报');
    const normalSends = sends;
    const duplicate = await p.publishWorkReport({ ...input, reportId: normalSpec.reportId, markdown: '重复提交不能覆盖已冻结快照' });
    assert.equal(duplicate.id, normal.id);
    assert.equal(sends, normalSends);
    for (const part of normalSpec.parts) {
      const message = await p.rest.getMessage(part.id);
      assert.equal(message.rid, rid); assert.equal(message.msg, part.text);
    }
    loseNextReceipt = true;
    const unknown = await p.publishWorkReport({ ...input, reportId: `${name}-lost-receipt`, markdown: '真实服务已收到，但本次验收丢弃客户端回执。' });
    assert.equal(unknown.state, 'verifying_delivery');
    const unknownSpec = JSON.parse(unknown.specJson) as ReportActionSpec;
    assert.equal((await p.rest.getMessage(unknownSpec.parts[0].id)).msg, unknownSpec.parts[0].text);
    const token = (JSON.parse(records.get('rcx-auth')!) as { authToken: string }).authToken;
    assert.ok(!readFileSync(storageFile, 'utf8').includes(token), '不得持久化认证信息');
    const restart = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--reconcile', storageFile, card.id, unknown.id],
      { encoding: 'utf8', timeout: 60_000 });
    assert.equal(restart.status, 0, `新进程核对失败：${restart.stdout}\n${restart.stderr}`);
    const history = await p.rest.getHistory(rid, 'c', 100);
    const ids = [...normalSpec.parts, ...unknownSpec.parts].map((part) => part.id);
    for (const id of ids) assert.equal(history.filter((message) => message._id === id).length, 1);
    console.log(restart.stdout.trim());
    console.log(JSON.stringify({ check: 'real-local-report-delivery', endpoint: base, project,
      multipartMessages: normalSpec.parts.length, receiptLossMessages: 1, totalMessageWrites: sends,
      messageIds: ids, duplicateMessages: 0, restoredAction: 'acknowledged', credentialsPersisted: false }));
  } finally {
    readOnly = false;
    loseNextReceipt = false;
    try {
      if (rid && cleanup) {
        const deleted = await cleanup.request<{ success: boolean }>('POST', 'channels.delete', { roomId: rid });
        assert.equal(deleted.success, true, '隔离验收频道清理失败');
      }
    } finally {
      globalThis.fetch = originalFetch;
      try { unlinkSync(storageFile); } finally { rmdirSync(directory); }
    }
    console.log(JSON.stringify({ check: 'cleanup', temporaryChannelRemoved: Boolean(rid), temporaryStorageRemoved: true }));
  }
}

main().catch((error: unknown) => {
  globalThis.fetch = originalFetch;
  // 仅输出断言/请求错误；不输出请求头、登录数据或完整账本。
  console.error(error instanceof Error ? error.message : '本地汇报验收失败');
  process.exitCode = 1;
});
