import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const evidence = '.omx/logs/native-work-scene-20261117';
const scene = (page: Page) => page.getByRole('region', { name: 'Codex 工作现场', exact: true });

async function mountScene(page: Page, options: { connected?: boolean; running?: boolean; portal?: boolean; board?: boolean; lateEventRegistration?: boolean } = {}) {
  await page.route('**/src/main.tsx', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.goto('/');
  await page.evaluate(async (options) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    if (options.board) Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async () => null } });
    await load('/src/styles.css');
    const [reactModule, domModule, component, account] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load(options.board ? '/src/components/WorkKanbanBoard.tsx' : options.portal ? '/src/components/WorkCardPortal.tsx' : '/src/components/NativeCodexWorkScene.tsx'), load('/src/platform/butlerAccountReady.ts'),
    ]);
    const React = reactModule.default ?? reactModule;
    const runtime = window as any;
    runtime.__nativeCalls = []; runtime.__views = [];
    runtime.__fixtureSnapshot = (id: string) => ({ protocolVersion: 1, todoId: `work-${id}`, sessionId: `session-${id}`, nativeThreadId: `original-${id}`, sourceScope: 'codex:fixture', executionProfileId: 'original-profile', bindingVersion: options.connected ? 1 : 0,
      connectionId: options.connected ? 'fixture-connection' : null, connectionStatus: options.connected ? 'connected' : 'disconnected', runtimeStatus: options.running ? 'running' : 'idle', activeTurnId: options.running ? 'turn-original' : null,
      capabilities: { resume: !options.connected, prompt: Boolean(options.connected), steer: Boolean(options.connected), interrupt: Boolean(options.connected), answer: Boolean(options.connected), externalLiveAttach: false },
      messages: [{ id: 'original-history', role: 'assistant', text: `工作 ${id} 的原会话上下文已保留。`, turnId: null, streaming: false }], historyTruncated: false, commands: [], decisions: [], cursor: 1, lastEventAt: 1, error: null, runtimeVersion: 'fixture-only',
    });
    runtime.__snapshots = { 'session-a': runtime.__fixtureSnapshot('a'), 'session-b': runtime.__fixtureSnapshot('b') };
    runtime.__holdSnapshot = false; runtime.__heldSnapshot = null; runtime.__failSubmit = false;
    const callbacks = new Map<number, (value: unknown) => void>(); let callbackId = 0;
    const listeners = new Map<number, number>(); let listenerId = 0;
    runtime.__activeNativeListenerCount = () => listeners.size;
    runtime.__emitNativeWork = (payload: unknown) => { for (const [id, callback] of listeners) callbacks.get(callback)?.({ event: 'native-work-updated', id, payload }); };
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { configurable: true, value: { unregisterListener: (_event: string, id: number) => { callbacks.delete(listeners.get(id)!); listeners.delete(id); } } });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { transformCallback: (callback: (value: unknown) => void) => { const id = ++callbackId; callbacks.set(id, callback); return id; }, invoke: async (command: string, args: any) => {
      runtime.__nativeCalls.push({ command, args });
      const input = args?.input;
      if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(id, args.handler); if (options.lateEventRegistration) return new Promise((resolve) => { runtime.__finishEventRegistration = () => resolve(id); }); return id; }
      if (command === 'plugin:event|unlisten') return null;
      if (command === 'butler_work_ledger_snapshot') {
        const ledger = structuredClone({ ...runtime.__backendLedger,
        sessions: runtime.__backendLedger.sessions.map((session: any) => { const snapshot = runtime.__snapshots[session.id]; return { ...session,
          runtimeStatus: snapshot.runtimeStatus, controlMode: snapshot.connectionStatus === 'connected' ? 'controllable' : 'readonly',
          configSnapshotJson: JSON.stringify({ ...JSON.parse(session.configSnapshotJson), ...(snapshot.bindingVersion ? { nativeHost: { bindingVersion: snapshot.bindingVersion } } : {}) }),
        }; }), actions: Object.values(runtime.__snapshots).flatMap((snapshot: any) => snapshot.commands),
        });
        if (runtime.__holdLedger) { runtime.__holdLedger = false; return new Promise((resolve) => { runtime.__heldLedger = () => resolve(ledger); }); }
        return ledger;
      }
      if (command === 'butler_native_work_snapshot') {
        if (runtime.__holdSnapshot) { runtime.__holdSnapshot = false; const frozen = structuredClone(runtime.__snapshots[input.sessionId]); return new Promise((resolve) => { runtime.__heldSnapshot = () => resolve(frozen); }); }
        return structuredClone(runtime.__snapshots[input.sessionId]);
      }
      if (command === 'acp_local_session_handoff') return 'fixture-only-token';
      if (command === 'butler_native_work_resume') {
        const snapshot = runtime.__snapshots[input.sessionId]; Object.assign(snapshot, { bindingVersion: 1, connectionId: 'fixture-connection', connectionStatus: 'connected', capabilities: { resume: false, prompt: true, steer: true, interrupt: true, answer: true, externalLiveAttach: false } }); return structuredClone(snapshot);
      }
      if (command === 'butler_native_work_submit') {
        if (runtime.__failSubmit) throw new Error('测试投递超时，原端结果待核对');
        const record = { id: `command-${runtime.__nativeCalls.length}`, todoId: input.command.todoId, sessionId: input.command.sessionId, idempotencyKey: input.command.requestId, state: 'prepared', actionKind: input.command.intent.kind === 'steer' ? 'session_steer' : 'session_prompt', specJson: JSON.stringify(input.command), createdAt: Date.now(), updatedAt: Date.now() };
        runtime.__snapshots[input.command.sessionId].commands.push(record); return record;
      }
      if (command === 'butler_native_work_cancel_queued') { const record = runtime.__snapshots[input.sessionId].commands.find((value: any) => JSON.parse(value.specJson).requestId === input.requestId); record.state = 'canceled'; return record; }
      if (command === 'butler_native_work_answer') {
        if (runtime.__failAnswer) throw new Error('该决定未能提交，请核对后再试');
        const snapshot = runtime.__snapshots[input.sessionId];
        const decision = snapshot.decisions.find((value: any) => value.id === input.decisionId);
        if (Array.isArray(decision.params.availableDecisions) && !decision.params.availableDecisions.includes(input.answer.decision)) throw new Error('该决定不在原请求允许的选项中');
        decision.state = 'answered'; return structuredClone(snapshot);
      }
      if (command === 'workspace_git_inspect') return { workspaceRoot: 'D:/fixture', dirtyFiles: [], isWorktree: false };
      throw new Error(`未声明的测试IPC: ${command}`);
    } } });
    account.beginButlerAccountSelection('fixture-account').activate({ accountScope: 'fixture-account', generation: 1 });
    const card = (id: string) => ({ id: `work-${id}`, title: `修复登录后返回原页面 ${id}`, priority: 3, createdAt: 1, updatedAt: 1, source: 'manual', state: { todoId: `work-${id}`, goal: '保留用户原来的页面和筛选条件', nextStep: null, acceptance: ['登录后回到原页面'], stage: 'in_progress', visibility: 'private', autonomyMode: 'confirm', waitState: 'none', requirementsVersion: 2, contentVersion: 3, dependsOn: [], maxAutoTurns: 5, autoTurnsUsed: 0, consecutiveFailures: 0 } });
    const session = (id: string) => ({ id: `session-${id}`, todoId: `work-${id}`, runtime: 'acp', nativeSessionId: `original-${id}`, sourceScope: 'codex:fixture', title: '原有 Codex 工作', workspaceRoot: 'D:/fixture', accountScope: 'fixture-account', origin: 'native_cli', controlMode: 'readonly', runtimeStatus: 'unknown', configSnapshotJson: JSON.stringify({ provider: 'codex', executionProfileId: 'original-profile' }), createdAt: 1, updatedAt: 1 });
    if (options.portal || options.board) {
      const [ledger, { useAcpAgents }, { useCodexWorkspace }] = await Promise.all([load('/src/stores/workLedger.ts'), load('/src/stores/acpAgents.ts'), load('/src/stores/codexWorkspace.ts')]);
      if (options.board) {
        localStorage.setItem('rcx-owner', 'fixture-account');
        ledger.beginWorkLedgerAccount('fixture-account')();
        runtime.__backendLedger = { cards: [card('a'), card('b')], sessions: [session('a'), session('b')], evidences: [], actions: [], links: [], events: [] };
        const { setSuperAgentRuntimeDriversForTests } = await load('/src/agent/superAgentBridge.ts');
        setSuperAgentRuntimeDriversForTests({ isDesktop: () => false, discoverLocalSessions: async () => [], inspectWorkspaceGit: async () => ({ workspaceRoot: 'D:/fixture', dirtyFiles: [], isWorktree: false }) });
      } else ledger.useWorkLedger.setState({ cards: [card('a'), card('b')], sessions: [session('a'), session('b')], evidences: [], actions: [], links: [], events: [], hydrated: true, hydrate: async () => {} });
      useAcpAgents.setState({ agents: [], sessions: {}, hydrate: async () => {} });
      useCodexWorkspace.setState({ workspaceRoot: 'D:/fixture', threads: [] });
    }
    document.documentElement.dataset.theme = 'dark';
    const host = document.getElementById('root')!;
    host.style.cssText = 'height:100vh;overflow:auto;max-width:1100px;margin:auto;padding:24px;background:var(--color-surface-3)';
    const root = (domModule.default ?? domModule).createRoot(host);
    runtime.__unmountScene = () => root.unmount();
    runtime.__renderEmpty = () => root.render(null);
    runtime.__renderScene = (id: string, statePatch = {}) => root.render(React.createElement(component.default, { key: id, layout: 'page', card: { ...card(id), state: { ...card(id).state, ...statePatch } }, session: session(id), onClose: () => {}, onViewHistory: () => runtime.__views.push('history'), onViewResults: () => runtime.__views.push('results') }));
    runtime.__renderScene('a');
  }, options);
  if (options.board) await page.getByRole('button', { name: '修复登录后返回原页面 a', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '补充这项工作的要求' })).toBeEditable();
}

test('工作详情原位交接原身份，输入法不误发，双击不重复提交且不切管理页', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mountScene(page, { portal: true });
  const input = page.getByRole('textbox', { name: '补充这项工作的要求' });
  await input.fill('保留原筛选条件');
  await input.press('Enter');
  await expect(input).toHaveValue('保留原筛选条件');
  const resume = scene(page).getByRole('button', { name: '在这里继续原会话', exact: true });
  await expect(resume).toBeDisabled();
  await page.getByRole('checkbox', { name: '原 Codex 会话已停止执行' }).check();
  await resume.click();
  await expect(scene(page).getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    useWorkLedger.setState((state: any) => ({ sessions: [...state.sessions, { ...state.sessions[0], id: 'newer-unselected-source', nativeSessionId: 'must-not-switch', updatedAt: Date.now() }] }));
  });
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(input).toHaveValue('保留原筛选条件');
  await scene(page).getByRole('button', { name: '发送', exact: true }).dblclick();
  const calls = await page.evaluate(() => (window as any).__nativeCalls);
  expect(calls.filter((value: any) => value.command === 'butler_native_work_submit')).toHaveLength(1);
  expect(calls.find((value: any) => value.command === 'butler_native_work_submit').args.input.command.sessionId).toBe('session-a');
  expect(calls.find((value: any) => value.command === 'butler_native_work_resume').args.input).toMatchObject({ todoId: 'work-a', sessionId: 'session-a', expectedBindingVersion: 0, authorization: { token: 'fixture-only-token', sessionId: 'original-a', sourceScope: 'codex:fixture' } });
  expect(calls.filter((value: any) => /acp_process_start|pi_|codex_turn/.test(value.command))).toHaveLength(0);
  await expect(page.getByRole('heading', { name: '修复登录后返回原页面 a', exact: true })).toBeVisible();
  await expect(scene(page).getByRole('button', { name: '查看成果', exact: true })).toBeVisible();
  await page.evaluate(() => { const snapshot = (window as any).__snapshots['session-a']; snapshot.commands[0].state = 'completed'; snapshot.cursor += 1; snapshot.messages.push({ id: 'completed-reply', role: 'assistant', text: '已补充筛选条件的回归验证，测试结果请查看成果记录。', turnId: 'completed-turn', streaming: false }); });
  await expect(page.getByText('本轮回复已结束；最近回复尚未核验。')).toBeVisible();
  await expect(page.getByText('要求已记下，正在等待原端确认。')).toHaveCount(0);
  await expect(page.getByText(/fixture-only/)).toHaveCount(0);
  await mkdir(evidence, { recursive: true });
  await page.evaluate(() => { const root = document.getElementById('root')!; root.scrollTop = 0; for (const element of root.querySelectorAll<HTMLElement>('*')) if (element.scrollTop) element.scrollTop = 0; });
  await page.screenshot({ path: `${evidence}/work-detail-connected.png`, fullPage: true });
});

test('草稿按原工作隔离，切工作和重新载入后保留', async ({ page }) => {
  await mountScene(page, { connected: true });
  const input = page.getByRole('textbox', { name: '补充这项工作的要求' });
  await input.fill('A 的保留草稿');
  await page.evaluate(() => (window as any).__renderScene('b'));
  await expect(input).toHaveValue('');
  await input.fill('B 的保留草稿');
  await page.evaluate(() => (window as any).__renderScene('a'));
  await expect(input).toHaveValue('A 的保留草稿');
  await expect.poll(async () => page.evaluate(async () => { const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('rocketx-agent-composer-drafts'); request.onsuccess = () => resolve(request.result); }); return new Promise<number>((resolve) => { const request = db.transaction('drafts').objectStore('drafts').count(); request.onsuccess = () => resolve(request.result); }); })).toBe(2);
  await mountScene(page, { connected: true });
  await expect(input).toHaveValue('A 的保留草稿');
});

test('发送始终默认排队，立即调整只生效一次且冻结当前轮次，停止需原端回执', async ({ page }) => {
  await mountScene(page, { connected: true, running: true });
  const input = page.getByRole('textbox', { name: '补充这项工作的要求' });
  await input.fill('本轮结束后运行验证');
  await expect(scene(page).getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await expect(page.getByText('正在执行；补充要求会在本轮结束后发送。', { exact: true })).toBeVisible();
  await input.press('Enter');
  const queue = page.getByRole('region', { name: '本轮结束后发送的要求' });
  await expect(queue).toContainText('本轮结束后运行验证');
  await queue.getByRole('button', { name: '撤回', exact: true }).click();
  await expect(queue).toHaveCount(0);
  await input.fill('先补充登录过期的复现');
  await scene(page).getByRole('button', { name: '立即调整', exact: true }).click();
  await input.fill('调整后仍按默认时机发送');
  await input.press('Enter');
  await scene(page).getByRole('button', { name: '停止本轮', exact: true }).click();
  await expect(page.getByText('停止请求已记下，正在等待本轮终止回执。')).toBeVisible();
  await expect(scene(page).getByRole('status').first()).toContainText('正在执行');
  const commands = await page.evaluate(() => (window as any).__nativeCalls.filter((value: any) => value.command === 'butler_native_work_submit').map((value: any) => value.args.input.command));
  expect(commands).toHaveLength(4);
  expect(commands[0]).toMatchObject({ intent: { kind: 'prompt' }, queueAfterTurn: true });
  expect(commands[1]).toMatchObject({ intent: { kind: 'steer' }, nativeTurnId: 'turn-original' });
  expect(commands[2]).toMatchObject({ intent: { kind: 'prompt', text: '调整后仍按默认时机发送' }, queueAfterTurn: true });
  expect(commands[2]).not.toHaveProperty('nativeTurnId');
  expect(commands[3]).toMatchObject({ intent: { kind: 'interrupt' }, nativeTurnId: 'turn-original' });
  expect(new Set(commands.map((value: any) => value.requestId)).size).toBe(4);
  await page.evaluate(() => Object.assign((window as any).__snapshots['session-a'], { runtimeStatus: 'interrupted', activeTurnId: null }));
  await expect(scene(page).getByRole('status').first()).toContainText('本轮已停止');
  await expect(scene(page).getByRole('button', { name: '立即调整', exact: true })).toHaveCount(0);
  await input.fill('下一轮正常继续');
  await scene(page).getByRole('button', { name: '发送', exact: true }).click();
  const next = await page.evaluate(() => (window as any).__nativeCalls.filter((value: any) => value.command === 'butler_native_work_submit').at(-1).args.input.command);
  expect(next).toMatchObject({ intent: { kind: 'prompt', text: '下一轮正常继续' } });
  expect(next).not.toHaveProperty('queueAfterTurn');
  expect(next).not.toHaveProperty('nativeTurnId');
});

test('决定绑定当前轮次与版本，过期批准禁用，额外权限只能拒绝', async ({ page }) => {
  await mountScene(page, { connected: true, running: true });
  await page.evaluate(() => { const s = (window as any).__snapshots['session-a']; const decision = { nativeRequestId: 1, nativeThreadId: 'original-a', nativeTurnId: 'turn-original', requirementsVersion: 2, bindingVersion: 1, state: 'pending', createdAt: 1 };
    s.decisions = [{ ...decision, id: 'expired', method: 'item/commandExecution/requestApproval', requirementsVersion: 1, params: { command: 'expired command' } }, { ...decision, id: 'unknown', state: 'unknown', method: 'item/commandExecution/requestApproval', params: { command: 'unknown command' } }, { ...decision, id: 'valid', method: 'item/commandExecution/requestApproval', params: { command: 'pnpm test' } }, { ...decision, id: 'permission', method: 'item/permissions/requestApproval', params: {} }, { ...decision, id: 'question', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'target', question: '选择验证范围', options: [{ label: '登录模块', description: '运行受影响测试' }] }] } }];
  });
  await page.getByText('待核对的历史请求 · 2', { exact: true }).click();
  const decisions = scene(page).getByRole('region', { name: '执行者需要你决定' });
  await expect(decisions).toHaveCount(5);
  const unknown = decisions.filter({ hasText: 'unknown command' });
  await expect(unknown.getByRole('heading', { name: '答复结果待核对', exact: true })).toBeVisible();
  await expect(unknown.getByText('答复可能已经送达，请先核对原端结果；不会重复回答。')).toBeVisible();
  await expect(unknown.getByRole('button', { name: '允许本次操作' })).toBeDisabled();
  await expect(unknown.getByRole('button', { name: '拒绝', exact: true })).toBeDisabled();
  await expect(decisions.filter({ hasText: 'expired command' }).getByRole('button', { name: '允许本次操作' })).toBeDisabled();
  await decisions.filter({ hasText: 'pnpm test' }).getByRole('button', { name: '允许本次操作' }).click();
  await scene(page).getByRole('button', { name: '拒绝额外权限' }).click();
  await page.getByRole('combobox', { name: '选择验证范围' }).selectOption('登录模块');
  await scene(page).getByRole('button', { name: '提交回答', exact: true }).click();
  const answers = await page.evaluate(() => (window as any).__nativeCalls.filter((value: any) => value.command === 'butler_native_work_answer').map((value: any) => value.args.input));
  expect(answers).toHaveLength(3);
  expect(answers[0]).toMatchObject({ decisionId: 'valid', nativeTurnId: 'turn-original', expectedRequirementsVersion: 2, answer: { decision: 'accept' } });
  expect(answers[1].answer).toEqual({ permissions: {}, scope: 'turn' });
  expect(answers[2].answer).toEqual({ answers: { target: { answers: ['登录模块'] } } });
});

test('旧工作快照迟到不覆盖新工作，未知发送保留正文且不自动重发', async ({ page }) => {
  await mountScene(page, { connected: true });
  await page.evaluate(() => { (window as any).__holdSnapshot = true; });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__heldSnapshot))).toBe(true);
  await page.evaluate(() => (window as any).__renderScene('b'));
  await expect(page.getByText('工作 b 的原会话上下文已保留。')).toBeVisible();
  await page.evaluate(() => (window as any).__heldSnapshot());
  await expect(page.getByText('工作 a 的原会话上下文已保留。')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__failSubmit = true; });
  await page.getByRole('textbox', { name: '补充这项工作的要求' }).fill('不能丢失或自动重发的要求');
  await scene(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('上次发送结果尚未确认，先核对原会话，避免重复发送。', { exact: false })).toBeVisible();
  await expect(page.getByText('不能丢失或自动重发的要求', { exact: true })).toBeVisible();
  await page.waitForTimeout(1300);
  expect(await page.evaluate(() => (window as any).__nativeCalls.filter((value: any) => value.command === 'butler_native_work_submit').length)).toBe(1);
});

test('切账号立即移除旧工作投影，旧账号迟到消息不会显示', async ({ page }) => {
  await mountScene(page, { connected: true });
  await page.evaluate(() => { (window as any).__holdSnapshot = true; });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__heldSnapshot))).toBe(true);
  await page.evaluate(async () => {
    const account = await new Function('return import("/src/platform/butlerAccountReady.ts")')();
    account.beginButlerAccountSelection('new-fixture-account').activate({ accountScope: 'new-fixture-account', generation: 2 });
    const runtime = window as any;
    runtime.__snapshots['session-a'] = { ...runtime.__snapshots['session-a'], messages: [{ id: 'new-account', role: 'assistant', text: '新账号受控测试投影', streaming: false }], cursor: 2 };
    runtime.__heldSnapshot();
  });
  await expect(page.getByText('工作 a 的原会话上下文已保留。')).toHaveCount(0);
  await expect(page.getByText('新账号受控测试投影')).toHaveCount(0);
  await expect(page.getByText('这条工作属于原账号，请切回原账号继续')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__nativeCalls.filter((value: any) => value.command === 'butler_native_work_submit').length)).toBe(0);
});

test('同页现场在常用与窄窗口可读，没有横向溢出', async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(viewport);
    await mountScene(page, { board: true, connected: true, running: true });
    const composer = page.getByRole('textbox', { name: '补充这项工作的要求' });
    const submit = scene(page).getByRole('button', { name: '发送', exact: true });
    const checkComposer = async () => {
      for (const element of [composer, submit]) {
        const bounds = (await element.boundingBox())!;
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        await expect(element).toBeInViewport({ ratio: 1 });
      }
    };
    await checkComposer();
    await page.getByText('工作要求', { exact: true }).click();
    await expect(page.getByRole('complementary', { name: '工作详情' }).getByText('保留用户原来的页面和筛选条件', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑工作要求', exact: true })).toBeVisible();
    await checkComposer();
    await page.getByText('工作要求', { exact: true }).click();
    await page.evaluate(() => { const snapshot = (window as any).__snapshots['session-a']; snapshot.messages = Array.from({ length: 40 }, (_, index) => ({ id: `long-${index}`, role: index % 2 ? 'user' : 'assistant', text: `历史消息 ${index}：${'这是用于验证阅读区域滚动与输入框位置的长对话。'.repeat(10)}`, turnId: 'turn-original', streaming: false })); snapshot.cursor += 1; });
    await expect(page.getByText(/^历史消息 39/)).toBeVisible();
    await checkComposer();
    await expect(page.getByLabel('这项工作的对话', { exact: true })).toHaveCSS('max-height', 'none');
    await expect(page.getByLabel('这项工作的对话', { exact: true })).toHaveCSS('overflow-y', 'visible');
    const reading = page.getByLabel('工作对话与决定', { exact: true });
    await reading.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await page.evaluate(() => { const snapshot = (window as any).__snapshots['session-a']; snapshot.decisions = [{ id: 'layout-approval', nativeRequestId: 31, method: 'item/commandExecution/requestApproval', nativeThreadId: 'original-a', nativeTurnId: 'turn-original', requirementsVersion: 2, bindingVersion: 1, state: 'pending', params: { command: 'pnpm test', availableDecisions: ['accept', 'cancel'] }, createdAt: 1 }]; snapshot.runtimeStatus = 'waiting_approval'; snapshot.cursor += 1; });
    await expect(scene(page).getByRole('button', { name: '拒绝并结束本轮', exact: true })).toBeVisible();
    const attention = page.getByRole('region', { name: '当前需要你决定' });
    await expect(attention).toBeInViewport({ ratio: 1 });
    expect(await reading.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(scene(page).getByRole('button', { name: '拒绝并结束本轮', exact: true })).toBeInViewport({ ratio: 1 });
    await checkComposer();
    expect(await page.getByRole('complementary', { name: '工作详情' }).locator('.work-first-detail-body').evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    await page.screenshot({ path: `${evidence}/work-scene-${viewport.width}x${viewport.height}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await mountScene(page, { connected: true, running: true });
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(scene(page).getByRole('button', { name: '发送', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${evidence}/scene-${width}.png`, fullPage: true });
  }
});

test('当前长问题直接可答并独立滚动，不挤走固定输入且不抢历史阅读位置', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 640 });
  await mountScene(page, { board: true, connected: true, running: true });
  const reading = page.getByLabel('工作对话与决定', { exact: true });
  await page.evaluate(() => {
    const snapshot = (window as any).__snapshots['session-a'];
    snapshot.messages = Array.from({ length: 30 }, (_, index) => ({ id: `question-history-${index}`, role: 'assistant', text: `历史 ${index} ${'保留原来的阅读位置。'.repeat(20)}`, streaming: false }));
    snapshot.cursor += 1;
  });
  await expect(page.getByText(/^历史 29/)).toBeVisible();
  await reading.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => {
    const snapshot = (window as any).__snapshots['session-a'];
    snapshot.decisions = [{ id: 'long-question', nativeRequestId: 91, method: 'item/tool/requestUserInput', nativeThreadId: 'original-a', nativeTurnId: 'turn-original', requirementsVersion: 2, bindingVersion: 1, state: 'pending', createdAt: 1, params: { questions: [{ id: 'scope', question: '请选择这次验证范围', options: [{ label: '登录模块' }] }] } }];
    snapshot.runtimeStatus = 'waiting_input'; snapshot.cursor += 1;
  });
  const current = page.getByRole('region', { name: '当前需要你决定' });
  await expect(current.getByRole('combobox', { name: '请选择这次验证范围' })).toBeInViewport({ ratio: 1 });
  await expect(current.getByRole('button', { name: '提交回答', exact: true })).toBeInViewport({ ratio: 1 });
  await current.getByRole('combobox', { name: '请选择这次验证范围' }).click();
  await page.keyboard.press('Escape');
  expect(await reading.evaluate((element) => element.scrollTop)).toBe(0);
  await page.evaluate(() => { const snapshot = (window as any).__snapshots['session-a']; snapshot.decisions[0].params.reason = '完整问题说明。'.repeat(150); snapshot.cursor += 1; });
  await expect(current.getByText('查看完整说明', { exact: true })).toBeVisible();
  await expect(current.getByRole('combobox', { name: '请选择这次验证范围' })).toBeInViewport({ ratio: 1 });
  await expect(current.getByRole('button', { name: '提交回答', exact: true })).toBeInViewport({ ratio: 1 });
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/current-question-default-940x640.png`, fullPage: true });
  await current.getByText('查看完整说明', { exact: true }).click();
  await expect(current.getByText('完整问题说明。'.repeat(150), { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '补充这项工作的要求' })).toBeInViewport({ ratio: 1 });
  await expect(scene(page).getByRole('button', { name: '发送', exact: true })).toBeInViewport({ ratio: 1 });
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/current-long-question-940x640.png`, fullPage: true });
  expect(await current.locator('.native-work-decision-body').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await current.getByRole('combobox', { name: '请选择这次验证范围' }).selectOption('登录模块');
  await current.getByRole('button', { name: '提交回答', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_native_work_answer').map((call: any) => call.args.input.answer))).toEqual([{ answers: { scope: { answers: ['登录模块'] } } }]);
});

test('零验证记录时查看成果原位定位最近回复，Markdown可读但不冒充验收结果', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountScene(page, { connected: true });
  await page.evaluate(() => {
    const snapshot = (window as any).__snapshots['session-a'];
    snapshot.messages.push({ id: 'latest-reply', role: 'assistant', text: '## 修改说明\n\n已保留 **筛选条件**。\n\n```ts\nconst keep = true;\n```\n\n[说明](https://example.com/result) [本地文件](D:/fixture/result.md)', streaming: false });
    snapshot.cursor += 1;
  });
  await expect(page.getByRole('heading', { name: '修改说明', exact: true })).toBeVisible();
  await scene(page).getByRole('button', { name: '查看成果', exact: true }).click();
  const latest = page.locator('[data-native-message-id="latest-reply"]');
  await expect(latest).toContainText('最近回复 · 未核验');
  await expect(latest.locator('strong')).toHaveText('筛选条件');
  await expect(latest.locator('pre')).toContainText('const keep = true;');
  await expect(latest.getByRole('link', { name: '说明', exact: true })).toHaveAttribute('href', 'https://example.com/result');
  await expect(latest.getByRole('link', { name: '本地文件', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__views)).toEqual([]);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/latest-reply-markdown.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(async () => { const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')(); useWorkLedger.setState({ evidences: [{ id: 'real-verification', todoId: 'work-a', kind: 'test_run', title: '已有验证记录', passed: true, stale: false }] }); });
  await scene(page).getByRole('button', { name: '查看成果', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__views)).toEqual(['results']);
});

test('接续与待决定、本轮完成投影刷新统一账本，返回列表没有旧状态且流式消息不触发全量轮询', async ({ page }) => {
  await mountScene(page, { board: true });
  await page.getByRole('checkbox', { name: '原 Codex 会话已停止执行' }).check();
  await scene(page).getByRole('button', { name: '在这里继续原会话', exact: true }).click();
  await expect(scene(page).getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  const ledgerSession = () => page.evaluate(async () => { const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')(); return useWorkLedger.getState().sessions.find((session: any) => session.id === 'session-a'); });
  expect(JSON.parse((await ledgerSession()).configSnapshotJson)).toHaveProperty('nativeHost');
  await page.evaluate(() => { const snapshot = (window as any).__snapshots['session-a']; Object.assign(snapshot, { runtimeStatus: 'waiting_approval', activeTurnId: 'turn-original', cursor: 2, decisions: [{ id: 'approval', nativeRequestId: 42, method: 'item/commandExecution/requestApproval', nativeThreadId: 'original-a', nativeTurnId: 'turn-original', requirementsVersion: 2, bindingVersion: 1, state: 'pending', params: { command: 'pnpm test' }, createdAt: 1 }] }); });
  await expect(page.getByRole('button', { name: '允许本次操作' })).toBeEnabled();
  await expect.poll(async () => (await ledgerSession()).runtimeStatus).toBe('waiting_approval');
  await page.getByRole('button', { name: '返回我的工作', exact: true }).click();
  const row = page.getByRole('button', { name: '修复登录后返回原页面 a', exact: true });
  await expect(row).toContainText('请求运行 pnpm test');
  await row.click();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await page.evaluate(() => { const snapshot = (window as any).__snapshots['session-a']; Object.assign(snapshot, { runtimeStatus: 'idle', activeTurnId: null, cursor: 3, messages: [...snapshot.messages, { id: 'completed', role: 'assistant', text: '本轮验证已经结束，工作验收尚待核对。', turnId: 'turn-original', streaming: false }] }); });
  await expect(scene(page).getByText('本轮验证已经结束，工作验收尚待核对。').first()).toBeVisible();
  await expect.poll(async () => (await ledgerSession()).runtimeStatus).toBe('idle');
  await expect(scene(page).getByRole('status').first()).toContainText('可以继续交代');
  await page.waitForTimeout(500);
  const reads = await page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_work_ledger_snapshot').length);
  for (let cursor = 4; cursor < 7; cursor++) {
    await page.evaluate((cursor) => { const snapshot = (window as any).__snapshots['session-a']; snapshot.cursor = cursor; snapshot.messages[0].text = `只更新正文 ${cursor}`; }, cursor);
    await expect(page.getByText(`只更新正文 ${cursor}`, { exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_work_ledger_snapshot').length)).toBe(reads);
  await page.getByRole('button', { name: '返回我的工作', exact: true }).click();
  await expect(row).not.toContainText('请求运行 pnpm test');
  await expect(page.getByRole('button', { name: '需我处理', exact: true })).toBeVisible();
});

test('原生投影触发的账本刷新迟到时，切账号仍不会发布旧工作', async ({ page }) => {
  await mountScene(page, { board: true, connected: true });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const runtime = window as any;
    runtime.__holdLedger = true;
    Object.assign(runtime.__snapshots['session-a'], { runtimeStatus: 'running', activeTurnId: 'new-turn', cursor: 2 });
  });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__heldLedger))).toBe(true);
  await page.evaluate(async () => {
    const [{ beginWorkLedgerAccount }, account] = await Promise.all([
      new Function('return import("/src/stores/workLedger.ts")')(),
      new Function('return import("/src/platform/butlerAccountReady.ts")')(),
    ]);
    localStorage.setItem('rcx-owner', 'next-fixture-account');
    const activate = beginWorkLedgerAccount('next-fixture-account');
    account.beginButlerAccountSelection('next-fixture-account').activate({ accountScope: 'next-fixture-account', generation: 2 });
    activate();
    (window as any).__heldLedger();
  });
  await expect(page.getByRole('button', { name: '修复登录后返回原页面 a', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => {
    const { useWorkLedger } = await new Function('return import("/src/stores/workLedger.ts")')();
    return useWorkLedger.getState().cards.length;
  })).toBe(0);
});

test('最后发送提示随同一命令实际回执变化，停止后的失败不冒充工作完成', async ({ page }) => {
  await mountScene(page, { connected: true });
  await page.getByRole('textbox', { name: '补充这项工作的要求' }).fill('运行登录验证');
  await scene(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('要求已排队，等待执行。')).toBeVisible();
  await page.evaluate(() => { const snapshot = (window as any).__snapshots['session-a']; snapshot.commands[0].state = 'acknowledged'; Object.assign(snapshot, { runtimeStatus: 'running', activeTurnId: 'turn-original', cursor: 2 }); });
  await expect(page.getByText('原端已接收，正在执行本轮。')).toBeVisible();
  await page.evaluate(() => { const snapshot = (window as any).__snapshots['session-a']; snapshot.commands[0].state = 'verifying_delivery'; snapshot.cursor += 1; });
  await expect(scene(page).getByRole('region', { name: '待核对的原操作' })).toContainText('运行登录验证');
  await expect(scene(page).getByRole('button', { name: '立即调整', exact: true })).toBeDisabled();
  await scene(page).getByRole('button', { name: '停止本轮', exact: true }).click();
  await expect(page.getByText('停止请求已记下，正在等待本轮终止回执。')).toBeVisible();
  await page.evaluate(() => { const snapshot = (window as any).__snapshots['session-a']; snapshot.commands[0].state = 'failed'; snapshot.commands[0].errorMessage = 'turn interrupted'; snapshot.commands[1].state = 'completed'; Object.assign(snapshot, { runtimeStatus: 'interrupted', activeTurnId: null, cursor: 4 }); });
  await expect(page.getByText('本轮已停止；这项工作尚未验收。')).toBeVisible();
  await expect(page.getByText('本轮回复已结束；最近回复尚未核验。')).toHaveCount(0);
});

test('关闭详情后原生语义事件合并刷新列表，错误账号与未就绪账号不刷新', async ({ page }) => {
  await mountScene(page, { board: true, connected: true });
  await page.getByRole('button', { name: '返回我的工作', exact: true }).click();
  await page.waitForTimeout(500);
  const ledgerReads = () => page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_work_ledger_snapshot').length);
  const before = await ledgerReads();
  await page.evaluate(() => {
    const runtime = window as any;
    Object.assign(runtime.__snapshots['session-a'], { runtimeStatus: 'waiting_approval', activeTurnId: 'background-turn', cursor: 5 });
    runtime.__emitNativeWork({ accountScope: 'wrong-account', todoId: 'work-a', sessionId: 'session-a', cursor: 5 });
  });
  await page.waitForTimeout(350);
  expect(await ledgerReads()).toBe(before);
  await page.evaluate(() => { const runtime = window as any; for (let count = 0; count < 5; count++) runtime.__emitNativeWork({ accountScope: 'fixture-account', todoId: 'work-a', sessionId: 'session-a', cursor: 5 }); });
  const row = page.getByRole('button', { name: '修复登录后返回原页面 a', exact: true });
  await expect(row).toContainText('原会话有待确认的操作');
  expect(await ledgerReads()).toBe(before + 1);
  await page.evaluate(() => { const runtime = window as any; Object.assign(runtime.__snapshots['session-a'], { runtimeStatus: 'idle', activeTurnId: null }); runtime.__emitNativeWork({ accountScope: 'fixture-account', todoId: 'work-a', sessionId: 'session-a', cursor: 5 }); });
  await expect(row).not.toContainText('原会话有待确认的操作');
  expect(await ledgerReads()).toBe(before + 2);
  await page.evaluate(async () => {
    const account = await new Function('return import("/src/platform/butlerAccountReady.ts")')();
    account.beginButlerAccountSelection('not-ready-account');
    (window as any).__emitNativeWork({ accountScope: 'fixture-account', todoId: 'work-a', sessionId: 'session-a', cursor: 6 });
  });
  await page.waitForTimeout(350);
  expect(await ledgerReads()).toBe(before + 2);
});

test('原生事件注册迟到或组件卸载后清理监听，不再刷新账本', async ({ page }) => {
  await mountScene(page, { board: true, connected: true, lateEventRegistration: true });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__finishEventRegistration))).toBe(true);
  await page.evaluate(() => { const runtime = window as any; runtime.__unmountScene(); runtime.__finishEventRegistration(); });
  await expect.poll(() => page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'plugin:event|unlisten').length)).toBe(1);
  const before = await page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_work_ledger_snapshot').length);
  await page.evaluate(() => (window as any).__emitNativeWork({ accountScope: 'fixture-account', cursor: 7 }));
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_work_ledger_snapshot').length)).toBe(before);
});

test('账号初始化失败时仍注册事件，之后就绪无需重建列表即可刷新', async ({ page }) => {
  await mountScene(page, { board: true, connected: true });
  await page.evaluate(() => (window as any).__renderEmpty());
  await expect(page.getByRole('textbox', { name: '补充这项工作的要求' })).toHaveCount(0);
  await page.evaluate(async () => {
    const account = await new Function('return import("/src/platform/butlerAccountReady.ts")')();
    const runtime = window as any;
    runtime.__failedAccountSelection = account.beginButlerAccountSelection('fixture-account');
    runtime.__failedAccountSelection.fail(new Error('fixture initial selection failed'));
    runtime.__renderScene('a');
  });
  const row = page.getByRole('button', { name: '修复登录后返回原页面 a', exact: true });
  await expect(row).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__activeNativeListenerCount())).toBe(3);
  const ledgerReads = () => page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_work_ledger_snapshot').length);
  await page.waitForTimeout(350);
  const before = await ledgerReads();
  await page.evaluate(() => {
    const runtime = window as any;
    Object.assign(runtime.__snapshots['session-a'], { runtimeStatus: 'waiting_approval', activeTurnId: 'recovered-turn' });
    runtime.__emitNativeWork({ accountScope: 'fixture-account', todoId: 'work-a', sessionId: 'session-a' });
  });
  await page.waitForTimeout(350);
  expect(await ledgerReads()).toBe(before);
  await page.evaluate(() => {
    const runtime = window as any;
    runtime.__failedAccountSelection.activate({ accountScope: 'fixture-account', generation: 2 });
    runtime.__emitNativeWork({ accountScope: 'fixture-account', todoId: 'work-a', sessionId: 'session-a' });
  });
  await expect(row).toContainText('原会话有待确认的操作');
  expect(await ledgerReads()).toBe(before + 1);
});

test('真实pinned审批选项只提供cancel时明确结束本轮，不发送未提供的decline或扩权选项', async ({ page }) => {
  await mountScene(page, { connected: true, running: true });
  await page.evaluate(() => {
    const snapshot = (window as any).__snapshots['session-a'];
    const decision = { nativeRequestId: 17, method: 'item/commandExecution/requestApproval', nativeThreadId: 'original-a', nativeTurnId: 'turn-original', requirementsVersion: 2, bindingVersion: 1, state: 'pending', createdAt: 1 };
    snapshot.decisions = [
      { ...decision, id: 'pinned', params: { command: 'synthetic command', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['synthetic'] } }, 'cancel'] } },
      { ...decision, id: 'decline-only', params: { command: 'decline-only command', availableDecisions: ['decline'] } },
      { ...decision, id: 'unsupported', params: { command: 'unsupported command', availableDecisions: ['acceptForSession', { acceptWithExecpolicyAmendment: {} }] } },
    ];
  });
  const requests = scene(page).getByRole('region', { name: '执行者需要你决定' });
  const pinned = requests.filter({ hasText: 'synthetic command' });
  await expect(pinned.getByRole('button', { name: '允许本次操作', exact: true })).toBeVisible();
  await expect(pinned.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0);
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1100, height: 1100 });
  await page.screenshot({ path: `${evidence}/approval-available-decisions.png`, fullPage: true });
  await pinned.getByRole('button', { name: '拒绝并结束本轮', exact: true }).click();
  const decline = requests.filter({ hasText: 'decline-only command' });
  await expect(decline.getByRole('button', { name: '允许本次操作', exact: true })).toHaveCount(0);
  await decline.getByRole('button', { name: '拒绝', exact: true }).click();
  const unsupported = requests.filter({ hasText: 'unsupported command' });
  await expect(unsupported.getByText('当前请求没有可支持的单次允许或拒绝选项，请在原端处理。')).toBeVisible();
  await expect(unsupported.getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_native_work_answer').map((call: any) => call.args.input.answer))).toEqual([{ decision: 'cancel' }, { decision: 'decline' }]);
});

test('动作提交失败在成功后台轮询后仍保留，下一次动作成功才清除', async ({ page }) => {
  await mountScene(page, { connected: true, running: true });
  await page.evaluate(() => {
    const runtime = window as any; runtime.__failAnswer = true;
    runtime.__snapshots['session-a'].decisions = [{ id: 'retained-error', nativeRequestId: 18, method: 'item/commandExecution/requestApproval', nativeThreadId: 'original-a', nativeTurnId: 'turn-original', requirementsVersion: 2, bindingVersion: 1, state: 'pending', params: { command: 'pnpm test', availableDecisions: ['accept', 'cancel'] }, createdAt: 1 }];
  });
  await scene(page).getByRole('button', { name: '拒绝并结束本轮', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: '该决定未能提交，请核对后再试' });
  await expect(error).toBeVisible();
  const before = await page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_native_work_snapshot').length);
  await expect.poll(() => page.evaluate(() => (window as any).__nativeCalls.filter((call: any) => call.command === 'butler_native_work_snapshot').length)).toBeGreaterThanOrEqual(before + 2);
  await expect(error).toBeVisible();
  await page.evaluate(() => { (window as any).__failAnswer = false; });
  await scene(page).getByRole('button', { name: '拒绝并结束本轮', exact: true }).click();
  await expect(error).toHaveCount(0);
});

test('工作只读、暂停、取消或已完成时保留草稿并阻止新增要求，仍能停止当前轮次', async ({ page }) => {
  await mountScene(page, { connected: true, running: true });
  const work = scene(page);
  const input = work.getByRole('textbox', { name: '补充这项工作的要求' });
  await input.fill('等工作可写后再发送');
  for (const [state, reason] of [
    [{ autonomyMode: 'readonly' }, '只读'], [{ waitState: 'paused' }, '已暂停'],
    [{ waitState: 'canceled' }, '已取消'], [{ stage: 'done' }, '已标记完成'],
  ] as const) {
    await page.evaluate(patch => (window as any).__renderScene('a', patch), state);
    await expect(work.getByRole('status').filter({ hasText: reason })).toBeVisible();
    await expect(work.getByRole('button', { name: '立即调整', exact: true })).toBeDisabled();
    await expect(work.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    await input.press('Enter');
    await expect(input).toHaveValue('等工作可写后再发送');
  }
  await work.getByRole('button', { name: '停止本轮', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__nativeCalls.filter((c: any) => c.command === 'butler_native_work_submit')
    .map((c: any) => [c.args.input.command.intent.kind, c.args.input.command.nativeTurnId]))).toEqual([['interrupt', 'turn-original']]);
});

test('重开工作后持久未决要求仍可核对，核实回执前禁止重复发送', async ({ page }) => {
  await mountScene(page, { connected: true });
  await page.evaluate(() => (window as any).__renderEmpty());
  await expect(scene(page)).toHaveCount(0);
  await page.evaluate(() => {
    const runtime = window as any;
    runtime.__snapshots['session-a'].commands = [{ id: 'prior', todoId: 'work-a', sessionId: 'session-a',
      actionKind: 'session_prompt', state: 'verifying_delivery', specJson: JSON.stringify({ requestId: 'saved-request',
        intent: { kind: 'prompt', text: '修复原页面返回位置' } }) }];
    runtime.__renderScene('a');
  });
  const work = scene(page);
  const pending = work.getByRole('region', { name: '待核对的原操作' });
  await expect(pending).toContainText('修复原页面返回位置');
  await pending.getByRole('button', { name: '核对原会话记录' }).click();
  expect(await page.evaluate(() => (window as any).__views)).toEqual(['history']);
  const input = work.getByRole('textbox', { name: '补充这项工作的要求' });
  await input.fill('等回执后补充');
  await input.press('Enter');
  await expect(input).toHaveValue('等回执后补充');
  await expect(work.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).__snapshots['session-a'].commands[0].state = 'completed'; });
  await expect(pending).toHaveCount(0);
  await expect(work.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__nativeCalls.filter((c: any) => c.command === 'butler_native_work_submit'))).toEqual([]);
});
