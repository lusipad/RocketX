import assert from 'node:assert/strict';
import test from 'node:test';
import { beginButlerAccountSelection } from '../../apps/web/src/platform/butlerAccountReady';
import { answerNativeWork, cancelQueuedNativeWork, readNativeWorkSnapshot, resumeNativeWork, startNativeWork, submitNativeWork } from '../../apps/web/src/platform/desktopCommands';

test('同页原生工作入口传原工作、来源和幂等命令；排队意图随命令持久化', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: Array<{ command: string; args: any }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: any) => { calls.push({ command, args }); return { fixtureOnly: true }; },
  } } });
  try {
    const account = { accountScope: 'native-scene-A', generation: 1 };
    beginButlerAccountSelection(account.accountScope).activate(account);
    await readNativeWorkSnapshot({ account, sessionId: 'original-ledger-session' });
    await resumeNativeWork({ account, sessionId: 'original-ledger-session', todoId: 'original-work', expectedRequirementsVersion: 2, expectedContentVersion: 3, expectedBindingVersion: 0,
      authorization: { token: 'fixture-token', sessionId: 'original-native-id', sourceScope: 'codex:original', accountScope: account.accountScope, hostDeviceId: 'original-device' } });
    const command = { requestId: 'same-once-only-id', todoId: 'original-work', sessionId: 'original-ledger-session', expectedRequirementsVersion: 2, expectedContentVersion: 3, expectedBindingVersion: 1,
      intent: { kind: 'prompt' as const, text: '本轮结束后继续验证' }, queueAfterTurn: true, submittedBy: 'user' as const };
    await submitNativeWork({ account, command });
    await cancelQueuedNativeWork({ account, sessionId: command.sessionId, requestId: command.requestId });
    await answerNativeWork({ account, sessionId: command.sessionId, decisionId: 'original-decision', expectedBindingVersion: 1, expectedRequirementsVersion: 2, nativeTurnId: 'original-turn', answer: { decision: 'decline' } });
    assert.deepEqual(calls.map(({ command: name }) => name), ['butler_native_work_snapshot', 'butler_native_work_resume', 'butler_native_work_submit', 'butler_native_work_cancel_queued', 'butler_native_work_answer']);
    for (const call of calls) assert.deepEqual(Object.keys(call.args), ['input']);
    assert.deepEqual(calls[2]!.args.input, { account, command });
    assert.equal(calls[1]!.args.input.authorization.sessionId, 'original-native-id');
    assert.equal(calls[4]!.args.input.nativeTurnId, 'original-turn');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('同页原生快照或命令返回时账号已切换，拒绝向新账号发布旧结果', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let complete!: (value: unknown) => void;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async () => new Promise((resolve) => { complete = resolve; }),
  } } });
  try {
    const account = { accountScope: 'native-scene-old', generation: 2 };
    beginButlerAccountSelection(account.accountScope).activate(account);
    const pending = readNativeWorkSnapshot({ account, sessionId: 'old-session' });
    await new Promise((resolve) => setImmediate(resolve));
    beginButlerAccountSelection('native-scene-new').activate({ accountScope: 'native-scene-new', generation: 3 });
    complete({ messages: [{ text: 'old private reply' }] });
    await assert.rejects(pending, /账号已切换/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('空项目开工只提交一次开工意图，迟到的原账号接纳结果不能发布到新账号', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: Array<{ name: string; args: unknown }> = [];
  let complete!: (value: unknown) => void;
  let signal!: () => void;
  const invoked = new Promise<void>(resolve => { signal = resolve; });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: (name: string, args: unknown) => new Promise(resolve => { calls.push({ name, args }); complete = resolve; signal(); }),
  } } });
  try {
    const account = { accountScope: 'start-user', generation: 4 };
    beginButlerAccountSelection(account.accountScope).activate(account);
    const input = { account, todoId: 'new-work', requestId: 'native-start:new-work', workspaceRoot: 'D:/projects/new',
      executionProfileId: 'local-profile', expectedRequirementsVersion: 0, expectedContentVersion: 0, hostDeviceId: 'this-device' };
    const pending = startNativeWork(input);
    await invoked;
    beginButlerAccountSelection('another-user').activate({ accountScope: 'another-user', generation: 5 });
    complete({ runtimeStatus: 'idle' });
    await assert.rejects(pending, /账号已切换/);
    assert.deepEqual(calls, [{ name: 'butler_native_work_start', args: { input } }]);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});
