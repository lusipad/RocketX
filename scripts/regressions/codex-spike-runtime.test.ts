import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NodeCodexTransport,
  codexRuntimeSourceFromArgs,
  type CodexInvocation,
} from '../lib/codex-app-server-spike';

test('Codex 探针运行时来源必须显式解析为 pinned 或 system', () => {
  assert.equal(codexRuntimeSourceFromArgs([], 'pinned'), 'pinned');
  assert.equal(codexRuntimeSourceFromArgs([], 'system'), 'system');
  assert.equal(
    codexRuntimeSourceFromArgs(['--runtime', 'system']),
    'system',
  );
  assert.equal(
    codexRuntimeSourceFromArgs(['--runtime', 'pinned']),
    'pinned',
  );
  assert.throws(
    () => codexRuntimeSourceFromArgs(['--runtime', 'unknown']),
    /pinned 或 system/,
  );
});

test('生命周期验收可以触发测试子进程的非预期退出回调', async () => {
  const invocation: CodexInvocation = {
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 60_000)'],
    appServerArgs: [],
    version: 'test',
    source: 'pinned',
    displayPath: process.execPath,
  };
  const transport = new NodeCodexTransport(process.cwd(), invocation);
  let exited: number | null | undefined;
  const exit = new Promise<number | null>((resolve) => {
    void transport.start({
      onLine: () => undefined,
      onExit: (code) => {
        exited = code;
        resolve(code);
      },
    });
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    await transport.terminateUnexpectedly();
    const code = await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 onExit 超时')), 5_000);
        timer.unref();
      }),
    ]);
    assert.notEqual(exited, undefined);
    assert.equal(code, exited);
  } finally {
    await transport.stop();
  }
});
