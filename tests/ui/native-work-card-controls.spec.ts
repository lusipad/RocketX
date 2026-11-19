import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const evidence = '.omx/logs/work-control-20261118';

async function mountControls(page: Page) {
  await page.route('**/src/main.tsx', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.goto('/');
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    await load('/src/styles.css');
    const [reactModule, domModule, component, account, ledger] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/NativeWorkCardControls.tsx'), load('/src/platform/butlerAccountReady.ts'), load('/src/stores/workLedger.ts'),
    ]);
    const React = reactModule.default ?? reactModule;
    const runtime = window as any;
    runtime.__calls = []; runtime.__opens = []; runtime.__projected = {}; runtime.__heldReads = {}; runtime.__holdReads = {};
    runtime.__submitError = false; runtime.__answerError = false; runtime.__holdSubmit = false;
    const card = (id: string) => ({ id: `work-${id}`, title: `工作 ${id.toUpperCase()}`, priority: 3, createdAt: 1, updatedAt: 1, source: 'manual', state: {
      todoId: `work-${id}`, goal: `只修复 ${id.toUpperCase()} 的登录问题`, nextStep: null, acceptance: ['登录后回到原页面'], stage: 'ready', visibility: 'private', autonomyMode: 'confirm',
      waitState: 'none', requirementsVersion: 2, contentVersion: 3, dependsOn: [], maxAutoTurns: 5, autoTurnsUsed: 0, consecutiveFailures: 0,
    } });
    const session = (id: string) => ({ id: `session-${id}`, todoId: `work-${id}`, runtime: 'acp', nativeSessionId: `original-${id}`, sourceScope: `codex:fixture-${id}`,
      title: `原有工作 ${id}`, workspaceRoot: `D:/fixture/worktree-${id}`, accountScope: 'fixture-account', origin: 'native_cli', controlMode: 'controllable', runtimeStatus: 'idle',
      configSnapshotJson: JSON.stringify({ provider: 'codex', executionProfileId: `profile-${id}` }), createdAt: 1, updatedAt: 1,
    });
    const snapshot = (id: string) => ({ protocolVersion: 1, todoId: `work-${id}`, sessionId: `session-${id}`, nativeThreadId: `original-${id}`, sourceScope: `codex:fixture-${id}`,
      executionProfileId: `profile-${id}`, bindingVersion: 1, connectionId: `connection-${id}`, connectionStatus: 'connected', runtimeStatus: 'idle', activeTurnId: null,
      capabilities: { resume: false, prompt: true, steer: true, interrupt: true, answer: true, externalLiveAttach: false }, messages: [], commands: [], decisions: [],
      historyTruncated: false, cursor: 1, lastEventAt: 1, error: null, runtimeVersion: 'fixture-only',
    });
    runtime.__cards = { a: card('a'), b: card('b') }; runtime.__sessions = { a: session('a'), b: session('b') };
    runtime.__snapshots = { 'session-a': snapshot('a'), 'session-b': snapshot('b') };
    runtime.__decision = (id: string, overrides = {}) => ({ id, nativeRequestId: id, nativeThreadId: 'original-a', nativeTurnId: 'turn-a', requirementsVersion: 2, bindingVersion: 1,
      state: 'pending', method: 'item/commandExecution/requestApproval', params: { command: `验证 ${id}`, availableDecisions: ['accept', 'cancel'] }, createdAt: 1, ...overrides,
    });
    const callbacks = new Map<number, (event: unknown) => void>(); const listeners = new Map<number, number>(); let callbackId = 0; let listenerId = 0;
    runtime.__emit = (sessionId: string, accountScope = 'fixture-account') => { for (const [id, callback] of listeners) callbacks.get(callback)?.({ event: 'native-work-updated', id, payload: { sessionId, accountScope } }); };
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { configurable: true, value: { unregisterListener: (_event: string, id: number) => { callbacks.delete(listeners.get(id)!); listeners.delete(id); } } });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      transformCallback: (callback: (value: unknown) => void) => { const id = ++callbackId; callbacks.set(id, callback); return id; },
      invoke: async (command: string, args: any) => {
        runtime.__calls.push({ command, args }); const input = args?.input;
        if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(id, args.handler); return id; }
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'butler_native_work_snapshot') {
          const frozen = structuredClone(runtime.__snapshots[input.sessionId]);
          if (runtime.__holdReads[input.sessionId]) { delete runtime.__holdReads[input.sessionId]; return new Promise(resolve => { runtime.__heldReads[input.sessionId] = () => resolve(frozen); }); }
          return frozen;
        }
        if (command === 'butler_native_work_submit') {
          if (runtime.__holdSubmit) { runtime.__holdSubmit = false; await new Promise(resolve => { runtime.__finishSubmit = resolve; }); }
          if (runtime.__submitError) throw new Error('原端回执超时，结果未知');
          const value = { id: `command-${runtime.__calls.length}`, todoId: input.command.todoId, sessionId: input.command.sessionId, idempotencyKey: input.command.requestId,
            state: 'prepared', actionKind: `session_${input.command.intent.kind}`, specJson: JSON.stringify(input.command), createdAt: 1, updatedAt: 1 };
          runtime.__snapshots[input.command.sessionId].commands.push(value); return structuredClone(value);
        }
        if (command === 'butler_native_work_answer') {
          if (runtime.__answerError) throw new Error('答复回执超时，结果未知');
          const snapshot = runtime.__snapshots[input.sessionId]; const decision = snapshot.decisions.find((value: any) => value.id === input.decisionId);
          if (decision.params.availableDecisions && !decision.params.availableDecisions.includes(input.answer.decision)) throw new Error('回答不属于原端允许选项');
          decision.state = 'answered'; return structuredClone(snapshot);
        }
        throw new Error(`未声明的测试 IPC: ${command}`);
      },
    } });
    account.beginButlerAccountSelection('fixture-account').activate({ accountScope: 'fixture-account', generation: 1 });
    ledger.useWorkLedger.setState({ hydrated: true, hydrate: async () => {} });
    document.documentElement.dataset.theme = 'dark';
    const host = document.getElementById('root')!; host.style.cssText = 'min-height:100vh;padding:20px;background:var(--color-surface-3)';
    const root = (domModule.default ?? domModule).createRoot(host);
    runtime.__render = (ids = ['a', 'b']) => root.render(React.createElement('div', { style: { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,320px),1fr))' } }, ids.map((id: string) => React.createElement('section', {
      key: id, 'aria-label': `工作 ${id.toUpperCase()}`, style: { minWidth: 0, padding: '16px 0', border: '1px solid var(--color-line)', borderRadius: 12 },
    }, React.createElement(component.default, { card: runtime.__cards[id], session: runtime.__sessions[id], onOpen: () => runtime.__opens.push(id), onSnapshot: (value: unknown) => { runtime.__projected[id] = value; } })))));
    runtime.__render();
  });
  await expect(page.getByRole('button', { name: '开始处理', exact: true })).toHaveCount(2);
}

const work = (page: Page, id: string) => page.getByRole('region', { name: `工作 ${id.toUpperCase()}`, exact: true });
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__calls.filter((value: any) => value.command === command).map((value: any) => value.args.input), command);

async function emit(page: Page, sessionId = 'session-a') {
  const previous = await page.evaluate(sessionId => (window as any).__calls.filter((value: any) => value.command === 'butler_native_work_snapshot' && value.args.input.sessionId === sessionId).length, sessionId);
  await page.evaluate(sessionId => (window as any).__emit(sessionId), sessionId);
  await expect.poll(() => page.evaluate(sessionId => (window as any).__calls.filter((value: any) => value.command === 'butler_native_work_snapshot' && value.args.input.sessionId === sessionId).length, sessionId)).toBeGreaterThan(previous);
}

test('已确认的开始仍可停止且必须等原轮终止，A 的控制不影响另一目录的 B', async ({ page }) => {
  await mountControls(page);
  await work(page, 'a').getByRole('button', { name: '开始处理', exact: true }).click();
  await page.evaluate(() => { const a = (window as any).__snapshots['session-a']; a.commands[0].state = 'acknowledged'; a.runtimeStatus = 'running'; a.activeTurnId = 'turn-a'; });
  await emit(page);
  await work(page, 'a').getByRole('button', { name: '停止本轮', exact: true }).click();
  await expect(work(page, 'a').getByRole('button', { name: '停止本轮', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).__snapshots['session-a'].commands[1].state = 'completed'; });
  await emit(page);
  await expect(work(page, 'a').getByRole('button', { name: '停止本轮', exact: true })).toBeDisabled();
  await expect(work(page, 'b').getByRole('button', { name: '开始处理', exact: true })).toBeEnabled();
  const submitted = await calls(page, 'butler_native_work_submit');
  expect(submitted).toHaveLength(2);
  expect(submitted[0]).toMatchObject({ account: { accountScope: 'fixture-account', generation: 1 }, command: { todoId: 'work-a', sessionId: 'session-a', intent: { kind: 'prompt', text: '只修复 A 的登录问题' }, expectedBindingVersion: 1 } });
  expect(submitted[1].command).toMatchObject({ todoId: 'work-a', sessionId: 'session-a', nativeTurnId: 'turn-a', intent: { kind: 'interrupt' } });
  expect(await page.evaluate(() => (window as any).__snapshots['session-b'].commands)).toEqual([]);
  expect(await page.evaluate(() => Object.values((window as any).__sessions).map((value: any) => [value.nativeSessionId, value.workspaceRoot]))).toEqual([['original-a', 'D:/fixture/worktree-a'], ['original-b', 'D:/fixture/worktree-b']]);
  await page.evaluate(() => Object.assign((window as any).__snapshots['session-a'], { runtimeStatus: 'interrupted', activeTurnId: null }));
  await emit(page);
  await expect(work(page, 'a').getByRole('button', { name: '停止本轮', exact: true })).toHaveCount(0);
});

test('缺绑定、缺连接、状态未知或身份错误时不显示可开始操作', async ({ page }) => {
  await mountControls(page);
  for (const patch of [{ bindingVersion: 0 }, { connectionId: null }, { connectionStatus: 'disconnected' }, { connectionStatus: 'unknown' }, { runtimeStatus: 'unknown' }, { nativeThreadId: 'wrong-thread' }, { sourceScope: 'another-source' }, { executionProfileId: 'another-profile' }]) {
    await page.evaluate(patch => Object.assign((window as any).__snapshots['session-a'], { bindingVersion: 1, connectionId: 'connection-a', connectionStatus: 'connected', runtimeStatus: 'idle', nativeThreadId: 'original-a', sourceScope: 'codex:fixture-a', executionProfileId: 'profile-a' }, patch), patch);
    await emit(page);
    await expect(work(page, 'a').getByRole('button', { name: '开始处理', exact: true })).toHaveCount(0);
    await expect(work(page, 'b').getByRole('button', { name: '开始处理', exact: true })).toBeEnabled();
  }
  await page.evaluate(() => Object.assign((window as any).__snapshots['session-a'], { nativeThreadId: 'original-a', sourceScope: 'codex:fixture-a', executionProfileId: 'profile-a', commands: [{ id: 'old-uncertain-start', actionKind: 'session_prompt', state: 'unknown', specJson: JSON.stringify({ requestId: 'old-request', intent: { kind: 'prompt' } }) }] }));
  await emit(page);
  await expect(work(page, 'a').getByRole('button', { name: '开始处理', exact: true })).toBeDisabled();
  expect(await calls(page, 'butler_native_work_submit')).toEqual([]);
});

test('当前决定使用原端单次允许与取消选项，旧版本和未知决定不能批准', async ({ page }) => {
  await mountControls(page);
  await page.evaluate(() => { const r = window as any; Object.assign(r.__snapshots['session-a'], { runtimeStatus: 'waiting_approval', activeTurnId: 'turn-a', decisions: [
    r.__decision('old', { requirementsVersion: 1 }), r.__decision('unknown', { state: 'unknown' }), r.__decision('allow'), r.__decision('cancel', { params: { command: '取消本轮', availableDecisions: ['cancel'] } }),
  ] }); });
  await emit(page);
  await expect(work(page, 'a').locator('[data-native-decision-id="old"]')).toHaveCount(0);
  await expect(work(page, 'a').locator('[data-native-decision-id="unknown"]')).toHaveCount(0);
  await expect(work(page, 'a').getByText('上次答复尚未确认，打开工作核对；不会重复回答。')).toBeVisible();
  await work(page, 'a').locator('[data-native-decision-id="allow"]').getByRole('button', { name: '允许本次操作', exact: true }).click();
  await work(page, 'a').locator('[data-native-decision-id="cancel"]').getByRole('button', { name: '拒绝并结束本轮', exact: true }).click();
  const answers = await calls(page, 'butler_native_work_answer');
  expect(answers).toEqual([
    { account: { accountScope: 'fixture-account', generation: 1 }, sessionId: 'session-a', decisionId: 'allow', expectedBindingVersion: 1, expectedRequirementsVersion: 2, nativeTurnId: 'turn-a', answer: { decision: 'accept' } },
    { account: { accountScope: 'fixture-account', generation: 1 }, sessionId: 'session-a', decisionId: 'cancel', expectedBindingVersion: 1, expectedRequirementsVersion: 2, nativeTurnId: 'turn-a', answer: { decision: 'cancel' } },
  ]);
  await expect(work(page, 'b').getByRole('button', { name: '开始处理', exact: true })).toBeEnabled();
});

test('双击开始在回执尚未到达时只提交一次', async ({ page }) => {
  await mountControls(page);
  await page.evaluate(() => { (window as any).__holdSubmit = true; });
  await work(page, 'a').getByRole('button', { name: '开始处理', exact: true }).dblclick();
  await expect.poll(async () => (await calls(page, 'butler_native_work_submit')).length).toBe(1);
  await expect(work(page, 'a').getByRole('button', { name: '开始处理', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__finishSubmit());
  await expect(work(page, 'a').getByRole('status')).toContainText('正在开始处理');
  expect(await calls(page, 'butler_native_work_submit')).toHaveLength(1);
});

test('开始回执未知后正常快照不允许重复发送', async ({ page }) => {
  await mountControls(page);
  await page.evaluate(() => { (window as any).__submitError = true; });
  await work(page, 'a').getByRole('button', { name: '开始处理', exact: true }).click();
  await expect(work(page, 'a').getByRole('status')).toContainText('操作结果待核对');
  await emit(page);
  await expect(work(page, 'a').getByRole('status')).toContainText('操作结果待核对');
  await expect(work(page, 'a').getByRole('button', { name: '开始处理', exact: true })).toBeDisabled();
  expect(await calls(page, 'butler_native_work_submit')).toHaveLength(1);
});

test('答复回执未知后原端仍pending也不能再次批准', async ({ page }) => {
  await mountControls(page);
  await page.evaluate(() => { const r = window as any; r.__answerError = true; Object.assign(r.__snapshots['session-a'], { runtimeStatus: 'waiting_approval', activeTurnId: 'turn-a', decisions: [r.__decision('uncertain')] }); });
  await emit(page);
  const allow = work(page, 'a').getByRole('button', { name: '允许本次操作', exact: true });
  await allow.click();
  await expect(work(page, 'a').getByRole('status')).toContainText('操作结果待核对');
  await emit(page);
  await expect(work(page, 'a').getByRole('status')).toContainText('操作结果待核对');
  await expect(allow).toBeDisabled();
  expect(await calls(page, 'butler_native_work_answer')).toHaveLength(1);
});

test('账号切换后的旧快照不重新显示控制且匹配事件不会为旧工作串账号', async ({ page }) => {
  await mountControls(page);
  await page.evaluate(() => { (window as any).__holdReads['session-a'] = true; });
  await emit(page);
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__heldReads['session-a']))).toBe(true);
  await page.evaluate(async () => { const account = await new Function('return import("/src/platform/butlerAccountReady.ts")')(); account.beginButlerAccountSelection('other-account').activate({ accountScope: 'other-account', generation: 2 }); (window as any).__heldReads['session-a'](); });
  await expect(page.getByRole('button', { name: '开始处理', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__projected.a)).toBeNull();
  await page.evaluate(() => (window as any).__emit('session-a', 'fixture-account'));
  expect(await calls(page, 'butler_native_work_submit')).toEqual([]);
});

test('卡片只响应匹配会话事件，不以定时器轮询；窄卡片能完成长问题回答', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountControls(page);
  await page.clock.install();
  const before = await calls(page, 'butler_native_work_snapshot');
  await page.evaluate(() => { const r = window as any; Object.assign(r.__snapshots['session-a'], { runtimeStatus: 'waiting_input', activeTurnId: 'turn-a', decisions: [r.__decision('question', { method: 'item/tool/requestUserInput', params: { reason: '必要的上下文说明。'.repeat(160), questions: [{ id: 'scope', question: '本次需要验证哪些页面？' }] } })] }); r.__emit('missing-session'); r.__emit('session-a', 'wrong-account'); });
  await page.clock.runFor(60_000);
  expect(await calls(page, 'butler_native_work_snapshot')).toHaveLength(before.length);
  await page.evaluate(() => (window as any).__emit('session-a'));
  await page.clock.runFor(300);
  await expect(work(page, 'a').getByRole('textbox', { name: '本次需要验证哪些页面？', exact: true })).toBeEditable();
  const reads = await calls(page, 'butler_native_work_snapshot');
  expect(reads.slice(before.length).map((value: any) => value.sessionId)).toEqual(['session-a']);
  await page.clock.resume();
  await work(page, 'a').getByRole('textbox', { name: '本次需要验证哪些页面？', exact: true }).fill('登录、列表和详情页');
  const submit = work(page, 'a').getByRole('button', { name: '提交回答', exact: true });
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/card-control-question-390.png`, fullPage: true });
  await submit.click();
  expect((await calls(page, 'butler_native_work_answer'))[0]).toMatchObject({ sessionId: 'session-a', decisionId: 'question', answer: { answers: { scope: { answers: ['登录、列表和详情页'] } } } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
